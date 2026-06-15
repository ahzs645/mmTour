/**
 * verify-gsap-scene.mjs
 *
 * Runtime smoke check for the GSAP scene player. For every scene that has a
 * generated gsap-scene.json it launches the standalone player page, captures a
 * screenshot at the entry frame and a mid frame, and records metrics (track and
 * keyframe counts, visible tracks, active color filters and masks, console
 * errors). Evidence is written under verification/gsap-scene/.
 *
 * This validates the convert-then-run pipeline end to end in a real browser.
 * A pixel-diff comparison against Ruffle belongs in verify-ruffle-runtime.mjs,
 * which loads the full app (Ruffle + GSAP Scene render mode) side by side.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(new URL("..", import.meta.url).pathname);
const generatedDir = join(root, "public/generated");
const outDir = join(root, "verification/gsap-scene");
const port = Number(process.env.VERIFY_PORT ?? 5310);
const baseUrl = `http://127.0.0.1:${port}`;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${baseUrl}/scene-player.html`);
      if (response.ok) return;
    } catch {
      // server not ready yet
    }
    await wait(500);
  }
  throw new Error("Vite dev server did not start");
}

function discoverScenes() {
  if (!existsSync(generatedDir)) return [];
  return readdirSync(generatedDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((scene) => existsSync(join(generatedDir, scene, "gsap-scene.json")))
    .sort();
}

async function main() {
  const scenes = discoverScenes();
  if (scenes.length === 0) {
    console.error("No gsap-scene.json files found. Run: npm run build:gsap-scenes");
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const server = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    stdio: "ignore",
  });

  const report = { generatedAt: new Date().toISOString(), baseUrl, scenes: [], failures: [] };

  try {
    await waitForServer();
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 720, height: 600 } });

    for (const scene of scenes) {
      const sceneReport = await captureScene(page, scene);
      report.scenes.push(sceneReport);
      if (sceneReport.error) report.failures.push(`${scene}: ${sceneReport.error}`);
    }

    await browser.close();
  } finally {
    try { server.kill("SIGKILL"); } catch { /* ignore */ }
  }

  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\nGSAP scene verification: ${report.scenes.length} scenes, ${report.failures.length} failures`);
  for (const sceneReport of report.scenes) {
    console.log(
      `  ${sceneReport.scene.padEnd(10)} tracks=${sceneReport.tracks} keys=${sceneReport.keyframes} ` +
      `visible@entry=${sceneReport.visibleAtEntry} filters=${sceneReport.filters} masks=${sceneReport.masks} ` +
      `errors=${sceneReport.consoleErrors}${sceneReport.error ? ` ERROR: ${sceneReport.error}` : ""}`,
    );
  }
  process.exit(report.failures.length > 0 ? 1 : 0);
}

async function captureScene(page, scene) {
  const errors = [];
  const onError = (message) => errors.push(message);
  page.on("pageerror", (error) => onError(String(error)));
  const consoleListener = (message) => { if (message.type() === "error") onError(message.text()); };
  page.on("console", consoleListener);

  const sceneJson = JSON.parse(readFileSync(join(generatedDir, scene, "gsap-scene.json"), "utf8"));
  const totalKeyframes = sceneJson.tracks.reduce((sum, track) => sum + track.keys.length, 0);

  const result = {
    scene,
    tracks: sceneJson.tracks.length,
    keyframes: totalKeyframes,
    frameCount: sceneJson.frameCount,
    entryFrame: sceneJson.entryFrame ?? 0,
    visibleAtEntry: 0,
    filters: 0,
    masks: 0,
    consoleErrors: 0,
    error: null,
  };

  try {
    await page.goto(`${baseUrl}/scene-player.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#sceneSelect", { timeout: 15000 });
    const index = await page.evaluate((target) => {
      const select = document.querySelector("#sceneSelect");
      const option = [...select.options].find((o) => o.textContent.includes(`${target}.swf`));
      return option ? option.value : null;
    }, scene);
    if (index === null) throw new Error("scene not listed in player");

    await page.selectOption("#sceneSelect", index);
    await wait(1200);

    const entryStats = await measure(page);
    result.visibleAtEntry = entryStats.visible;
    result.filters = entryStats.filters;
    result.masks = entryStats.masks;
    await page.locator("#sceneStage").screenshot({ path: join(outDir, `${scene}-entry.png`) });

    // Capture a mid frame too, to exercise tweens/cells across the timeline.
    const midFrame = Math.floor((sceneJson.frameCount - 1) / 2);
    await page.fill("#frameScrubber", String(midFrame));
    await page.dispatchEvent("#frameScrubber", "input");
    await wait(500);
    const midStats = await measure(page);
    result.filters = Math.max(result.filters, midStats.filters);
    result.masks = Math.max(result.masks, midStats.masks);
    await page.locator("#sceneStage").screenshot({ path: join(outDir, `${scene}-mid.png`) });
  } catch (error) {
    result.error = error.message;
  } finally {
    page.off("console", consoleListener);
    result.consoleErrors = errors.length;
    if (errors.length && !result.error) result.error = errors[0];
  }

  return result;
}

function measure(page) {
  return page.evaluate(() => {
    const tracks = [...document.querySelectorAll(".gsap-scene-track")];
    const visible = tracks.filter((t) => getComputedStyle(t).display !== "none");
    const filters = [...document.querySelectorAll(".gsap-scene-media")]
      .filter((m) => m.style.filter && m.style.filter !== "none").length;
    const masks = visible.filter((t) => t.style.clipPath && t.style.clipPath !== "none").length;
    return { visible: visible.length, filters, masks };
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
