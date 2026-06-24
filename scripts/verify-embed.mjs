#!/usr/bin/env node
// Prove the dist-embed/ package works as a drop-in: serve it over HTTP (with real
// Range support, since the pack is read on demand), open embed.html headlessly, and
// assert the player loads the archive and renders the tour with no errors/404s.
//
// Run: npm run build:embed && node scripts/verify-embed.mjs
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const dir = join(root, "dist-embed");
if (!existsSync(join(dir, "embed.html"))) {
  console.error("error: dist-embed/embed.html missing. Run `npm run build:embed` first.");
  process.exit(1);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".pack": "application/octet-stream" };

const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = join(dir, normalize(url === "/" ? "/embed.html" : url));
  if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  const size = statSync(file).size;
  const type = TYPES[extname(file)] || "application/octet-stream";
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    createReadStream(file).pipe(res);
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/embed.html`;

const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
const notFound = [];
page.on("pageerror", (e) => errors.push(String(e.message ?? e).slice(0, 160)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
page.on("response", (r) => { if (r.status() === 404) notFound.push(r.url()); });

try {
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => window.__tour && window.__tour.frameCount >= 0, null, { timeout: 30000 });
  // Let the shell autoload its nested levels (intro/nav) and paint.
  await page.waitForFunction(
    () => document.querySelectorAll("#tour .player-level").length >= 2
      && document.querySelectorAll("#tour img, #tour svg, #tour image").length > 5,
    null,
    { timeout: 20000 },
  ).catch(() => {});
  const stats = await page.evaluate(() => ({
    frameCount: window.__tour?.frameCount ?? null,
    isPlaying: window.__tour?.isPlaying ?? null,
    levels: document.querySelectorAll("#tour .player-level").length,
    mediaNodes: document.querySelectorAll("#tour img, #tour svg, #tour image").length,
  }));

  const real404 = notFound.filter((u) => !/favicon/.test(u));
  const ok = stats.levels > 0 && stats.mediaNodes > 5 && errors.length === 0 && real404.length === 0;
  console.log("stats:", JSON.stringify(stats));
  if (errors.length) console.log("pageErrors:", errors.slice(0, 4));
  if (real404.length) console.log("404s:", real404.slice(0, 4));
  console.log(ok ? "RESULT: PASS — embed package plays the tour from xp-tour.pack" : "RESULT: FAIL");
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close().catch(() => {});
  server.close();
}
