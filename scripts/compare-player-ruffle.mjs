// Compares the Decompiled Player (the data-driven AVM1 runtime — the focus of the
// project) against the Ruffle reference, scene by scene. The existing
// verify-ruffle-runtime harness diffs Ruffle against the *frame-SVG* reference; this
// one diffs Ruffle against the *player* itself, which nothing else covers.
//
// Two signals, because pixel-diffing two independently free-running Flash renderers
// is noisy:
//   1. settle diff   — once the player's root playhead holds (a stop()/wait), both
//      sides show the same static state; this is the trustworthy, low-noise signal.
//   2. min-residual  — over a short window, each player frame is matched to its
//      CLOSEST Ruffle frame; the residual measures content/layout divergence while
//      cancelling animation timing phase (the two renderers drift out of step).
//
// Reports per-scene numbers + worst captured pair under verification/player-ruffle/.
// It is a discovery harness: visual divergence is the signal we want surfaced, so it
// only exits non-zero on a structural breakage (no Ruffle embed, no player output),
// not on a high diff — unless PLAYER_RUFFLE_STRICT=1 sets a hard settle threshold.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { compareScreenshotFiles, diffImages, readPng, imageBlankness } from "./lib/visualDiff.mjs";
import { startDevServer, stopDevServer } from "./lib/devServer.mjs";
import {
  ensurePaused, ensurePlaying, listScenes, openApp, selectScene, setRenderMode, shootStage, waitForPlayerStable,
} from "./lib/playerProbe.mjs";

// A standalone SWF whose Ruffle render is blank because it only draws once the
// A-tour shell has loaded it into its level (keyed by scene value). The player
// shows its own preview, so the comparison is not meaningful — skipped, with reason.
const EXPECTED_RUFFLE_BLANK = new Map([
  ["2", "standalone nav.swf is blank in Ruffle until the shell loads it into _level6"],
]);

const root = resolve(new URL("..", import.meta.url).pathname);
const outDir = join(root, "verification/player-ruffle");
const port = Number(process.env.VERIFY_PORT ?? 5181);
const baseUrl = process.env.VERIFY_URL ?? `http://127.0.0.1:${port}/`;
const shouldStartServer = !process.env.VERIFY_URL;
const seriesSamples = Number(process.env.PLAYER_RUFFLE_SAMPLES ?? 8);
const seriesGapMs = Number(process.env.PLAYER_RUFFLE_GAP_MS ?? 500);
const strictThreshold = process.env.PLAYER_RUFFLE_STRICT ? Number(process.env.PLAYER_RUFFLE_STRICT) : null;

mkdirSync(outDir, { recursive: true });

let server;
let browser;
const failures = [];

try {
  if (shouldStartServer) server = await startDevServer(root, port);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => failures.push(`browser page error: ${error.message}`));

  await openApp(page, baseUrl);
  const scenes = await listScenes(page);
  const results = [];

  for (const scene of scenes) {
    const safe = scene.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    await selectScene(page, scene.value);
    await setRenderMode(page, "player");

    const stable = await waitForPlayerStable(page);
    if (stable.rufflePlayers < 1) failures.push(`${scene.label}: Ruffle reference player missing`);
    if (stable.playerNodes < 1) failures.push(`${scene.label}: Decompiled Player rendered nothing`);

    // 1) Settle diff: pause the player on its held frame, capture both stages.
    await ensurePaused(page);
    await page.waitForTimeout(400);
    const rufflePng = join(outDir, `${scene.value}-${safe}-ruffle.png`);
    const playerPng = join(outDir, `${scene.value}-${safe}-player.png`);
    await shootStage(page, "#ruffleMount", rufflePng);
    await shootStage(page, "#assetStage", playerPng);
    let settle = compareScreenshotFiles(rufflePng, playerPng);
    const expectedSkip = EXPECTED_RUFFLE_BLANK.get(scene.value);
    if (settle.status !== "ok" && expectedSkip) settle = { ...settle, expectedSkip: true, expectedSkipReason: expectedSkip };

    // 2) Min-residual over a short window — ONLY for a scene that never settles (a
    //    continuous animation like the intro). With the player playing, closest-frame
    //    matching cancels timing phase and leaves content divergence. A settled scene
    //    is already compared cleanly by its settle diff; resuming it would force it off
    //    its stop() hold and manufacture divergence, so we don't.
    let series = { status: "skipped", reason: "settled — settle diff is authoritative" };
    if (!stable.settled) {
      await ensurePlaying(page);
      series = await captureSeries(page, scene.value, safe);
    }

    // The authoritative number per scene.
    const signal = stable.settled && settle.status === "ok" ? settle.meanAbsoluteDifference
      : series.status === "ok" ? series.median : null;

    const entry = { scene: scene.label, value: scene.value, state: stable, settle, series, signal };
    results.push(entry);

    if (strictThreshold && signal !== null && signal > strictThreshold && !settle.expectedSkip) {
      failures.push(`${scene.label}: divergence ${signal.toFixed(2)} exceeds ${strictThreshold}`);
    }

    const settleStr = settle.status === "ok" ? settle.meanAbsoluteDifference.toFixed(2)
      : settle.expectedSkip ? "skipped(expected)" : `skipped(${settle.reason})`;
    console.log(`${scene.label}: settle=${settleStr} minResidual median=${series.median ?? "-"} max=${series.max ?? "-"} (frame ${stable.frame}/${stable.frameMax}, ${stable.settled ? "settled" : "running"})`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    params: { seriesSamples, seriesGapMs, strictThreshold },
    results,
    divergent: rankDivergent(results),
    failures,
  };
  writeFileSync(join(outDir, "player-ruffle-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${join(outDir, "player-ruffle-report.json")}`);
  console.log("Most divergent (by combined signal):");
  for (const d of report.divergent.slice(0, 5)) console.log(`  ${d.scene}: signal=${d.signal} (settle=${d.settle}, minResidual=${d.median}, ${d.settled ? "settled" : "running"})`);

  if (failures.length) {
    for (const failure of failures) console.error(`error: ${failure}`);
    process.exit(1);
  }
} finally {
  await browser?.close();
  await stopDevServer(server);
}

/**
 * Capture an interleaved Ruffle/Player time-series and, for each player frame, find
 * its closest Ruffle frame (min mean-absolute-difference). The median/max of those
 * minima are the timing-tolerant divergence: low means "every player frame looks
 * like SOME Ruffle frame", i.e. the content matches and only timing differs.
 */
async function captureSeries(page, value, safe) {
  const rufflePngs = [];
  const playerPngs = [];
  for (let i = 0; i < seriesSamples; i += 1) {
    const r = join(outDir, `series-${value}-${safe}-r${i}.png`);
    const p = join(outDir, `series-${value}-${safe}-p${i}.png`);
    await shootStage(page, "#ruffleMount", r);
    await shootStage(page, "#assetStage", p);
    rufflePngs.push(r);
    playerPngs.push(p);
    await page.waitForTimeout(seriesGapMs);
  }

  const ruffleImgs = rufflePngs.map(readPng).filter((img) => !imageBlankness(img).isBlank);
  if (!ruffleImgs.length) return { status: "skipped", reason: "all Ruffle frames blank" };

  const minima = [];
  for (const playerPath of playerPngs) {
    const playerImg = readPng(playerPath);
    if (imageBlankness(playerImg).isBlank) continue;
    let best = Infinity;
    for (const ruffleImg of ruffleImgs) {
      const diff = diffImages(ruffleImg, playerImg);
      if (diff.status === "ok") best = Math.min(best, diff.meanAbsoluteDifference);
    }
    if (Number.isFinite(best)) minima.push(best);
  }
  if (!minima.length) return { status: "skipped", reason: "no comparable frames" };

  minima.sort((a, b) => a - b);
  return {
    status: "ok",
    samples: minima.length,
    median: +minima[Math.floor(minima.length / 2)].toFixed(2),
    min: +minima[0].toFixed(2),
    max: +minima[minima.length - 1].toFixed(2),
  };
}

/** Order scenes by their divergence signal (highest first) — the shortlist of where
 *  the player and Ruffle differ most, skipping the expected-blank standalones. */
function rankDivergent(results) {
  return results
    .filter((r) => !r.settle.expectedSkip)
    .map((r) => ({
      scene: r.scene,
      value: r.value,
      signal: r.signal === null ? null : +r.signal.toFixed(2),
      settled: r.state.settled,
      settle: r.settle.status === "ok" ? +r.settle.meanAbsoluteDifference.toFixed(2) : null,
      median: r.series.status === "ok" ? r.series.median : null,
      frame: r.state.frame,
    }))
    .sort((a, b) => (b.signal ?? -1) - (a.signal ?? -1));
}
