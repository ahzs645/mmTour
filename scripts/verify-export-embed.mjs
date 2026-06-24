#!/usr/bin/env node
// End-to-end proof of the "convert here, embed anywhere" flow: open the in-browser
// Studio, convert a bundled SWF, click "Export & embed" to download a .mmtour.pack,
// then load that pack through the BUILT embed player (dist/mmtour-player.js) in
// archive mode and assert it renders with no errors/404s.
//
// Prereq: `npm run build:pages` (or build:embed) so dist/mmtour-player.* exist.
// Run: node scripts/verify-export-embed.mjs [scene]
import { spawn } from "node:child_process";
import { createReadStream, copyFileSync, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const scene = process.argv[2] || "segment4";
const player = join(root, "dist/mmtour-player.js");
if (!existsSync(player)) {
  console.error("error: dist/mmtour-player.js missing. Run `npm run build:pages` first.");
  process.exit(1);
}

const STUDIO_PORT = 5191;
const studioBase = `http://127.0.0.1:${STUDIO_PORT}/convert-play.html`;
const tmp = mkdtempSync(join(tmpdir(), "export-embed-"));

const studio = spawn("node_modules/.bin/vite", ["--host", "127.0.0.1", "--port", String(STUDIO_PORT), "--strictPort"], { cwd: root, stdio: "ignore" });
let embedServer;
let browser;
try {
  await waitForUrl(studioBase);
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });

  // 1) Convert + export from the Studio.
  const ctxA = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 900 } });
  const studioPage = await ctxA.newPage();
  await studioPage.goto(studioBase, { waitUntil: "load", timeout: 30000 });
  await studioPage.getByRole("button", { name: scene, exact: true }).click();
  await studioPage.waitForFunction((name) => {
    const card = [...document.querySelectorAll(".card")].find((n) => n.querySelector("h3")?.textContent?.includes(`${name}.swf`));
    return card && !card.classList.contains("busy") && card.querySelector(".export");
  }, scene, { timeout: 180000 });
  const card = studioPage.locator(".card", { has: studioPage.locator("h3", { hasText: `${scene}.swf` }) }).first();
  const download = studioPage.waitForEvent("download", { timeout: 30000 });
  await card.getByRole("button", { name: /Export/ }).click();
  const file = await download;
  const packName = await file.suggestedFilename();
  await file.saveAs(join(tmp, packName));
  // The dialog should show a ready-to-paste snippet.
  const snippet = await studioPage.locator(".embed-snippet").textContent({ timeout: 10000 });
  await ctxA.close();

  // 2) Assemble an embed dir and serve it with Range support.
  copyFileSync(player, join(tmp, "mmtour-player.js"));
  copyFileSync(join(root, "dist/mmtour-player.css"), join(tmp, "mmtour-player.css"));
  const sceneSwf = `${scene}.swf`;
  writeFileSync(join(tmp, "embed.html"), embedHtml(packName, sceneSwf));

  embedServer = createRangeServer(tmp);
  await new Promise((r) => embedServer.listen(0, "127.0.0.1", r));
  const embedBase = `http://127.0.0.1:${embedServer.address().port}/embed.html`;

  // 3) Play the exported pack through the built player.
  const ctxB = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await ctxB.newPage();
  const errors = [];
  const notFound = [];
  page.on("pageerror", (e) => errors.push(String(e.message ?? e).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  page.on("response", (r) => { if (r.status() === 404) notFound.push(r.url()); });
  await page.goto(embedBase, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => window.__tour && window.__tour.frameCount >= 0, null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("#tour img, #tour svg, #tour image").length > 3, null, { timeout: 20000 }).catch(() => {});
  const stats = await page.evaluate(() => ({
    frameCount: window.__tour?.frameCount ?? null,
    isPlaying: window.__tour?.isPlaying ?? null,
    mediaNodes: document.querySelectorAll("#tour img, #tour svg, #tour image").length,
  }));

  const real404 = notFound.filter((u) => !/favicon/.test(u));
  const snippetOk = /createTourPlayer/.test(snippet ?? "") && (snippet ?? "").includes(packName);
  const ok = stats.mediaNodes > 3 && errors.length === 0 && real404.length === 0 && snippetOk;
  console.log("packName:", packName, `(${(statSync(join(tmp, packName)).size / 1048576).toFixed(1)} MB)`);
  console.log("stats:", JSON.stringify(stats));
  console.log("snippet shows createTourPlayer + pack name:", snippetOk);
  if (errors.length) console.log("pageErrors:", errors.slice(0, 4));
  if (real404.length) console.log("404s:", real404.slice(0, 4));
  console.log(ok ? "RESULT: PASS — Studio export plays in the embed player (archive mode)" : "RESULT: FAIL");
  process.exitCode = ok ? 0 : 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (embedServer) embedServer.close();
  studio.kill("SIGTERM");
}

function embedHtml(packName, sceneSwf) {
  const sceneAttr = sceneSwf === "A-tour.swf" ? "" : `\n          scene: ${JSON.stringify(sceneSwf)},`;
  return `<!doctype html><html><head><meta charset="utf-8" />
<link rel="stylesheet" href="./mmtour-player.css" /></head>
<body><div id="tour" style="width:640px;height:480px;position:relative;overflow:hidden"></div>
<script type="module">
  import { createTourPlayer } from "./mmtour-player.js";
  window.__tour = await createTourPlayer(document.getElementById("tour"), {
    assetSource: "archive", archiveUrl: "./${packName}",${sceneAttr}
    autoplay: true,
  });
</script></body></html>`;
}

function createRangeServer(dir) {
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  return createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const f = join(dir, normalize(url === "/" ? "/embed.html" : url));
    if (!f.startsWith(dir) || !existsSync(f) || !statSync(f).isFile()) return res.writeHead(404).end("nf");
    const size = statSync(f).size;
    const type = TYPES[extname(f)] || "application/octet-stream";
    const m = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
      createReadStream(f, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
      createReadStream(f).pipe(res);
    }
  });
}

async function waitForUrl(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start at ${url}`);
}
