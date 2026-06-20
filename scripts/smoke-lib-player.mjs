// Browser smoke for the embeddable library: boots the dev server, loads the
// public createTourPlayer entry against the real /generated assets, and asserts
// it actually renders DOM into the host container. Run: node scripts/smoke-lib-player.mjs
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const PORT = 5199;
const base = `http://${HOST}:${PORT}`;

async function waitForUrl(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start at ${url}`);
}

let server;
let browser;
try {
  server = spawn("node_modules/.bin/vite", ["--host", HOST, "--port", String(PORT), "--strictPort"], {
    stdio: "ignore",
  });
  await waitForUrl(`${base}/smoke.html`, 60000);

  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });

  const source = process.argv[2] || "files";
  await page.goto(`${base}/smoke.html?source=${source}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__smoke && window.__smoke.status !== "loading", null, { timeout: 60000 });
  const smoke = await page.evaluate(() => window.__smoke);

  // Wait for the shell to autoload its nested levels (intro/nav) and paint —
  // compressed bundles load slower than loose timeline.json, so give them time.
  let stats = {};
  try {
    await page.waitForFunction(
      () => document.querySelectorAll("#stage .player-level").length >= 2
        && document.querySelectorAll("#stage img, #stage image, #stage svg").length > 5,
      null,
      { timeout: 20000 },
    );
  } catch {
    /* report whatever rendered */
  }
  stats = await page.evaluate(() => {
    const stage = document.getElementById("stage");
    return {
      levels: stage.querySelectorAll(".player-level").length,
      mediaNodes: stage.querySelectorAll("#stage img, #stage image, #stage svg, img.player-media").length,
      domNodes: stage.querySelectorAll("*").length,
      currentFrame: window.__player ? window.__player.currentFrame : null,
      isPlaying: window.__player ? window.__player.isPlaying : null,
    };
  });

  const ok = smoke.status === "ready" && stats.mediaNodes > 0 && stats.levels > 0;
  console.log("smoke:", JSON.stringify(smoke));
  console.log("stats:", JSON.stringify(stats));
  if (errors.length) console.log("page errors:", errors.slice(0, 4));
  console.log(ok ? "RESULT: PASS — library renders the tour" : "RESULT: FAIL");
  process.exitCode = ok ? 0 : 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGTERM");
}
