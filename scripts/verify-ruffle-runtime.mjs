import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const outDir = join(root, "verification/ruffle-runtime");
const port = Number(process.env.VERIFY_PORT ?? 5180);
const baseUrl = process.env.VERIFY_URL ?? `http://127.0.0.1:${port}/`;
const shouldStartServer = !process.env.VERIFY_URL;
const maxSceneMeanAbsoluteDifference = Number(process.env.VERIFY_MAX_SCENE_DIFF ?? 25);
const maxHoldMeanAbsoluteDifference = Number(process.env.VERIFY_MAX_HOLD_DIFF ?? 25);
const minVisualComparisons = Number(process.env.VERIFY_MIN_VISUAL_COMPARISONS ?? 6);
const visualFrameCheckpoints = new Map([
  ["Intro - intro.swf", 5],
]);
const expectedVisualSkips = new Map([
  ["Navigation - nav.swf", "standalone nav.swf depends on shell-loaded _level0/_level6 state; shell loading is verified separately"],
]);

mkdirSync(outDir, { recursive: true });

let server;
let browser;
const failures = [];
const warnings = [];
const swfResponses = [];

try {
  if (shouldStartServer) server = await startServer(port);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  page.on("console", (message) => {
    if (message.type() === "error") warnings.push(`browser console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => failures.push(`browser page error: ${error.message}`));
  page.on("response", (response) => {
    const url = response.url();
    if (!/\.swf(?:$|\?)/i.test(url)) return;
    swfResponses.push({
      url,
      swf: url.split("/").pop()?.split("?")[0] ?? url,
      status: response.status(),
    });
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.locator("#sceneSelect").waitFor({ state: "visible", timeout: 20_000 });

  const sceneLoads = await verifyAllScenesLoad(page);
  const ruffleShellLoads = verifyRuffleShellLoads();
  const generatedShellStartup = await verifyGeneratedShellStartup(page);
  const menuHoldBehavior = await verifyMenuHoldBehavior(page, sceneLoads);
  const overlayInteractions = await verifyOverlayInteractions(page, sceneLoads);
  const segment1FunctionCalls = await verifySegment1FunctionCall(page);
  const introRootFunction = await verifyIntroRootFunctionNavigation(page);
  const segment4 = await verifySegment4HoldAndClick(page);
  const navRootFunction = await verifyNavRootFunctionNavigation(page);
  const navExitNavigation = await verifyNavExitNavigation(page);
  const nav = await verifySceneLoads(page, "2", "Navigation - nav.swf");
  const visualCoverage = summarizeVisualCoverage([
    ...sceneLoads.map((entry) => entry.visualComparison),
    segment4.visualComparison,
  ]);
  verifyVisualCoverage(visualCoverage);

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    visualThresholds: {
      maxSceneMeanAbsoluteDifference,
      maxHoldMeanAbsoluteDifference,
      minVisualComparisons,
    },
    checks: {
      sceneLoads,
      ruffleShellLoads,
      generatedShellStartup,
      menuHoldBehavior,
      overlayInteractions,
      segment1FunctionCalls,
      introRootFunction,
      segment4,
      navRootFunction,
      navExitNavigation,
      nav,
    },
    visualCoverage,
    warnings,
    failures,
  };

  writeFileSync(join(outDir, "ruffle-runtime-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`scene loads: ${sceneLoads.length} scenes checked`);
  console.log(`Ruffle shell loads: ${ruffleShellLoads.loadedSwfs.join(", ")}`);
  console.log(`generated shell startup: ${generatedShellStartup.before.selectedText} -> ${generatedShellStartup.after.selectedText}`);
  console.log(`menu holds: ${menuHoldBehavior.length} waiting scenes checked`);
  console.log(`overlay interactions: ${overlayInteractions.length} scenes checked`);
  console.log(`segment1 function call: overlays ${segment1FunctionCalls.before.functionOverlays} -> ${segment1FunctionCalls.after.functionOverlays}; combined release status="${segment1FunctionCalls.afterCombined.status}"`);
  console.log(`intro root function: ${introRootFunction.before.selectedText} frame ${introRootFunction.before.frame} -> ${introRootFunction.after.selectedText}`);
  console.log(`segment4: frame ${segment4.before.frame} -> ${segment4.afterClick.frame}, overlays ${segment4.before.overlays} -> ${segment4.afterClick.overlays}`);
  console.log(`nav root function: ${navRootFunction.before.selectedText} frame ${navRootFunction.before.frame} -> ${navRootFunction.after.selectedText}`);
  console.log(`nav exit: ${navExitNavigation.before.selectedText} frame ${navExitNavigation.before.frame} -> ${navExitNavigation.after.selectedText}`);
  console.log(`nav: frame=${nav.frame}, rufflePlayers=${nav.rufflePlayers}, generatedSvg=${nav.generatedSvg}`);
  console.log(`visual comparisons: ${visualCoverage.compared}/${visualCoverage.comparable} comparable checked, ${visualCoverage.expectedSkipped} expected skipped, ${visualCoverage.unexpectedSkipped} unexpected skipped`);
  console.log(`Wrote ${join(outDir, "ruffle-runtime-report.json")}`);

  if (failures.length) {
    for (const failure of failures) console.error(`error: ${failure}`);
    process.exit(1);
  }
} finally {
  await browser?.close();
  if (server) {
    if (server.exitCode === null && !server.killed) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
  }
}

function verifyVisualCoverage(coverage) {
  if (coverage.compared < minVisualComparisons) {
    failures.push(`visual comparison coverage ${coverage.compared}/${coverage.comparable} comparable checks is below minimum ${minVisualComparisons}`);
  }
  if (coverage.unexpectedSkipped > 0) {
    failures.push(`visual comparison had ${coverage.unexpectedSkipped} unexpected skipped checks`);
  }
}

async function verifyAllScenesLoad(page) {
  const options = await page.locator("#sceneSelect option").evaluateAll((nodes) =>
    nodes.map((node) => ({ value: node.value, label: node.textContent ?? "" })),
  );
  const results = [];

  for (const option of options) {
    await page.locator("#sceneSelect").selectOption(option.value);
    await page.waitForFunction(() => document.querySelector("#frameStageInline svg"), null, { timeout: 20_000 });
    await page.waitForTimeout(350);
    const visualFrame = visualFrameCheckpoints.get(option.label);
    if (visualFrame !== undefined) {
      await page.locator("#frameScrubber").fill(String(visualFrame));
      await page.locator("#frameScrubber").dispatchEvent("input");
      await page.waitForTimeout(100);
    }

    const safeName = option.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const state = await captureRuntimeState(page, `scene-${option.value}-${safeName}`);
    if (state.rufflePlayers < 1) failures.push(`${option.label}: Ruffle reference player missing`);
    if (state.generatedSvg < 1) failures.push(`${option.label}: generated frame SVG missing`);

    await screenshotStage(page, "#ruffleMount", `scene-${option.value}-${safeName}-ruffle.png`);
    await screenshotStage(page, "#assetStage", `scene-${option.value}-${safeName}-generated.png`);
    const diff = compareScreenshots(`scene-${option.value}-${safeName}-ruffle.png`, `scene-${option.value}-${safeName}-generated.png`);
    if (diff.status === "ok" && diff.meanAbsoluteDifference > maxSceneMeanAbsoluteDifference) {
      failures.push(`${option.label}: Ruffle/generated screenshot difference ${diff.meanAbsoluteDifference.toFixed(2)} exceeds ${maxSceneMeanAbsoluteDifference}`);
    } else if (diff.status !== "ok") {
      const expectedSkipReason = expectedVisualSkips.get(option.label);
      if (expectedSkipReason) {
        diff.expectedSkip = true;
        diff.expectedSkipReason = expectedSkipReason;
      } else {
        warnings.push(`${option.label}: screenshot comparison skipped: ${diff.reason}`);
      }
    }

    results.push({ option, state, visualFrame, visualComparison: diff });
  }

  return results;
}

function verifyRuffleShellLoads() {
  const loadedSwfs = [...new Set(swfResponses.filter((response) => response.status >= 200 && response.status < 400).map((response) => response.swf))];
  for (const swf of ["A-tour.swf", "nav.swf", "intro.swf"]) {
    if (!loadedSwfs.includes(swf)) failures.push(`Ruffle shell load missing ${swf}`);
  }

  return {
    loadedSwfs,
    responses: swfResponses,
  };
}

async function verifyGeneratedShellStartup(page) {
  await page.locator("#sceneSelect").selectOption("0");
  await page.waitForFunction(() => document.querySelector("#frameScrubber")?.getAttribute("max") === "2", null, { timeout: 20_000 });
  await page.waitForTimeout(300);
  const before = await captureRuntimeState(page, "generated-shell-startup-before");
  if (before.selectedText !== "Tour Shell - A-tour.swf") failures.push(`generated shell startup: wrong starting scene: ${before.selectedText}`);

  await page.locator("#playBtn").click();
  await page.waitForFunction(() => document.querySelector("#sceneSelect option:checked")?.textContent === "Intro - intro.swf", null, { timeout: 15_000 });
  await page.waitForTimeout(300);
  const after = await captureRuntimeState(page, "generated-shell-startup-after");
  if (after.selectedText !== "Intro - intro.swf") failures.push(`generated shell startup: expected Intro after A-tour level-4 load, got ${after.selectedText}`);
  if (after.rufflePlayers < 1) failures.push("generated shell startup: Ruffle reference player missing after startup");
  if (after.generatedSvg < 1) failures.push("generated shell startup: generated frame SVG missing after startup");
  if (after.externalLevels < 1) failures.push("generated shell startup: level-6 nav overlay missing after A-tour shell load");
  if (!after.externalLevelSwfs.includes("nav.swf")) failures.push(`generated shell startup: expected nav.swf external overlay, got ${after.externalLevelSwfs.join(", ")}`);
  if (!after.externalLevelFrames.includes("70")) failures.push(`generated shell startup: expected _level6.startNavEntrance() to move nav.swf to frame 70, got frames ${after.externalLevelFrames.join(", ")}`);

  return { before, after };
}

async function verifyMenuHoldBehavior(page, sceneLoads) {
  const candidates = sceneLoads.filter((entry) => entry.state.status?.includes("Awaiting user selection"));
  const results = [];

  for (const entry of candidates) {
    await page.locator("#sceneSelect").selectOption(entry.option.value);
    await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Awaiting user selection"), null, { timeout: 20_000 });
    await page.waitForTimeout(300);
    const before = await captureRuntimeState(page, `menu-hold-${entry.option.value}-before`);
    await page.waitForTimeout(1_000);
    const after = await captureRuntimeState(page, `menu-hold-${entry.option.value}-after`);

    if (before.frame !== after.frame) failures.push(`${entry.option.label}: waiting menu advanced from frame ${before.frame} to ${after.frame}`);
    if (before.status !== after.status) failures.push(`${entry.option.label}: waiting menu status changed from "${before.status}" to "${after.status}"`);
    if (after.overlays < 1) failures.push(`${entry.option.label}: waiting menu has no generated clickable overlays`);
    if (!after.playDisabled) failures.push(`${entry.option.label}: play button should be disabled while awaiting a menu choice`);
    const hoverStateChecks = await verifyWaitingMenuHoverStates(page, entry.option, after.overlays);

    results.push({ option: entry.option, before, after, hoverStateChecks });
  }

  return results;
}

async function verifyWaitingMenuHoverStates(page, option, overlayCount) {
  const checks = [];
  const maxOverlays = Math.min(overlayCount, 30);

  for (let index = 0; index < maxOverlays; index += 1) {
    await page.locator("#sceneSelect").selectOption(option.value);
    await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Awaiting user selection"), null, { timeout: 20_000 });
    await page.waitForTimeout(150);

    const overlay = page.locator(".flash-button-overlay").nth(index);
    const overlayData = await overlay.evaluate((element) => ({
      character: element.getAttribute("data-character"),
      hitCharacter: element.getAttribute("data-hit-character"),
      ownerCharacter: element.getAttribute("data-owner-character"),
    }));
    await overlay.evaluate((element) => {
      element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, cancelable: true, view: window }));
    });
    await page.waitForTimeout(75);
    const overStateOverlay = await page.locator(".flash-button-state-overlay").first().evaluate((element) => ({
      character: element.getAttribute("data-character"),
      state: element.getAttribute("data-state"),
      requestedState: element.getAttribute("data-requested-state"),
      fallbackState: element.getAttribute("data-fallback-state"),
    })).catch(() => null);

    if (!overStateOverlay) failures.push(`${option.label}: overlay ${index} did not show an extracted button over state on hover`);
    if (overStateOverlay?.requestedState !== "over" || overStateOverlay?.state !== "over" || overStateOverlay?.fallbackState !== "false") {
      failures.push(`${option.label}: overlay ${index} hover did not use an extracted over-state SVG`);
    }

    await overlay.evaluate((element) => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    });
    await page.waitForTimeout(75);
    const downStateOverlay = await page.locator(".flash-button-state-overlay").first().evaluate((element) => ({
      character: element.getAttribute("data-character"),
      state: element.getAttribute("data-state"),
      requestedState: element.getAttribute("data-requested-state"),
      fallbackState: element.getAttribute("data-fallback-state"),
    })).catch(() => null);

    if (!downStateOverlay) failures.push(`${option.label}: overlay ${index} did not show an extracted button down state on pointerdown`);
    if (downStateOverlay?.requestedState !== "down" || downStateOverlay?.state !== "down" || downStateOverlay?.fallbackState !== "false") {
      failures.push(`${option.label}: overlay ${index} pointerdown did not use an extracted down-state SVG`);
    }

    checks.push({ index, overlayData, overStateOverlay, downStateOverlay });

    await overlay.evaluate((element) => {
      element.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, cancelable: true, view: window }));
    }).catch(() => {});
  }

  return checks;
}

async function verifyOverlayInteractions(page, sceneLoads) {
  const candidates = sceneLoads.filter((entry) => entry.state.overlays > 0);
  const results = [];

  for (const entry of candidates) {
    const { option } = entry;
    const safeName = option.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const attempts = [];
    const maxAttempts = Math.min(entry.state.overlays, 20);
    let changedAttempt;

    for (let index = 0; index < maxAttempts; index += 1) {
      await page.locator("#sceneSelect").selectOption(option.value);
      await page.waitForFunction(() => document.querySelector(".flash-button-overlay"), null, { timeout: 20_000 });
      await page.waitForTimeout(300);

      const before = await captureRuntimeState(page, `interaction-${option.value}-${safeName}-${index}-before`);
      const overlay = page.locator(".flash-button-overlay").nth(index);
      const overlayData = await overlay.evaluate((element) => ({
        character: element.getAttribute("data-character"),
        hitCharacter: element.getAttribute("data-hit-character"),
        ownerCharacter: element.getAttribute("data-owner-character"),
      }));
      await overlay.evaluate((element) => {
        element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, cancelable: true, view: window }));
      });
      await page.waitForTimeout(150);
      const stateOverlayCount = await page.locator(".flash-button-state-overlay").count();
      if (stateOverlayCount < 1) {
        failures.push(`${option.label}: overlay ${index} did not render an extracted button state on hover`);
      }
      await clickVisibleOverlay(page, overlay);
      await page.waitForTimeout(900);
      let after = await captureRuntimeState(page, `interaction-${option.value}-${safeName}-${index}-after`);

      let changed = stateChanged(before, after);
      let clickMode = "pointer-visible";

      if (!changed) {
        await overlay.evaluate((element) => {
          element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        });
        await page.waitForTimeout(500);
        after = await captureRuntimeState(page, `interaction-${option.value}-${safeName}-${index}-after-dispatch`);
        changed = stateChanged(before, after);
        clickMode = "dom-dispatch";
      }

      const changedByPointer = clickMode === "pointer-visible" && changed;
      const changedByDispatch = clickMode === "dom-dispatch" && changed;
      const changedByAnyClick = changedByPointer || changedByDispatch;
      if (changedByDispatch) warnings.push(`${option.label}: overlay ${index} changed only with DOM-dispatched click; inspect SVG hit geometry`);

      attempts.push({ index, overlayData, before, after, changed: changedByAnyClick, clickMode, stateOverlayCount });

      if (changedByAnyClick) {
        changedAttempt = attempts.at(-1);
        if (after.rufflePlayers < 1) failures.push(`${option.label}: Ruffle player missing after overlay click`);
        if (after.generatedSvg < 1) failures.push(`${option.label}: generated SVG missing after overlay click`);
        break;
      }
    }

    if (!changedAttempt) failures.push(`${option.label}: no generated overlay click changed scene, frame, status, or overlays`);

    results.push({ option, attempts, changedAttempt });
  }

  return results;
}

async function verifyIntroRootFunctionNavigation(page) {
  await page.locator("#sceneSelect").selectOption("1");
  await page.waitForFunction(() => document.querySelector("#frameScrubber")?.getAttribute("max") === "585", null, { timeout: 20_000 });
  await page.locator("#frameScrubber").fill("427");
  await page.locator("#frameScrubber").dispatchEvent("input");
  await page.waitForTimeout(300);

  const before = await captureRuntimeState(page, "intro-root-function-before");
  if (before.selectedText !== "Intro - intro.swf") failures.push(`intro root function: wrong starting scene: ${before.selectedText}`);
  if (before.frame !== "427") failures.push(`intro root function: expected frame 427 before playback, got ${before.frame}`);

  await page.locator("#playBtn").click();
  await page.waitForFunction(() => document.querySelector("#sceneSelect option:checked")?.textContent === "Segment 4 - segment4.swf", null, { timeout: 15_000 });
  await page.waitForTimeout(300);

  const after = await captureRuntimeState(page, "intro-root-function-after");
  if (after.selectedText !== "Segment 4 - segment4.swf") failures.push(`intro root function: expected Segment 4 after LoadInitialInteractive, got ${after.selectedText}`);
  if (after.rufflePlayers < 1) failures.push("intro root function: Ruffle reference player missing after navigation");
  if (after.generatedSvg < 1) failures.push("intro root function: generated frame SVG missing after navigation");

  return { before, after };
}

async function verifySegment4HoldAndClick(page) {
  await page.locator("#sceneSelect").selectOption("6");
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Awaiting user selection"), null, { timeout: 20_000 });
  await page.waitForTimeout(500);

  const before = await captureRuntimeState(page, "segment4-before");
  if (before.selectedText !== "Segment 4 - segment4.swf") failures.push(`segment4: wrong selected scene: ${before.selectedText}`);
  if (before.frame !== "45") failures.push(`segment4: expected noKiosk hold at frame 45, got ${before.frame}`);
  if (!before.status.includes("Awaiting user selection at noKiosk")) failures.push(`segment4: unexpected hold status: ${before.status}`);
  if (before.overlays < 1) failures.push("segment4: expected at least one generated button overlay");
  if (!before.playDisabled) failures.push("segment4: play button should be disabled while awaiting a choice");
  if (before.rufflePlayers < 1) failures.push("segment4: Ruffle reference player missing");
  if (before.generatedSvg < 1) failures.push("segment4: generated frame SVG missing");

  await screenshotStage(page, "#ruffleMount", "segment4-before-ruffle.png");
  await screenshotStage(page, "#assetStage", "segment4-before-generated.png");
  await page.screenshot({ path: join(outDir, "segment4-before-full.png"), fullPage: false });

  const diff = compareScreenshots("segment4-before-ruffle.png", "segment4-before-generated.png");
  if (diff.status === "ok" && diff.meanAbsoluteDifference > maxHoldMeanAbsoluteDifference) {
    failures.push(`segment4: Ruffle/generated hold screenshot difference ${diff.meanAbsoluteDifference.toFixed(2)} exceeds ${maxHoldMeanAbsoluteDifference}`);
  } else if (diff.status !== "ok") {
    warnings.push(`segment4: screenshot comparison skipped: ${diff.reason}`);
  }

  await page.locator(".flash-button-overlay").nth(0).click({ force: true });
  await page.waitForFunction(() => document.querySelector("#frameScrubber")?.value === "46", null, { timeout: 10_000 });
  await page.waitForTimeout(300);

  const afterClick = await captureRuntimeState(page, "segment4-after-click");
  if (afterClick.frame !== "46") failures.push(`segment4: click should transition to frame 46, got ${afterClick.frame}`);
  if (!afterClick.status.includes("Awaiting user selection at robust")) failures.push(`segment4: click did not hold at robust choice: ${afterClick.status}`);
  if (!afterClick.playDisabled) failures.push("segment4: play button should remain disabled after choice transition hold");

  return { before, afterClick, visualComparison: diff };
}

async function verifySegment1FunctionCall(page) {
  await page.locator("#sceneSelect").selectOption("3");
  await page.waitForFunction(() => document.querySelector("#frameScrubber")?.getAttribute("max") === "134", null, { timeout: 20_000 });
  await page.locator("#frameScrubber").fill("35");
  await page.locator("#frameScrubber").dispatchEvent("input");
  await page.waitForFunction(() => document.querySelector('.flash-button-overlay[data-character="115"]'), null, { timeout: 20_000 });
  await page.waitForTimeout(300);

  const before = await captureRuntimeState(page, "segment1-function-before");
  if (before.selectedText !== "Segment 1 - segment1.swf") failures.push(`segment1 function: wrong selected scene: ${before.selectedText}`);
  if (before.frame !== "35") failures.push(`segment1 function: expected frame 35 before click, got ${before.frame}`);
  if (before.functionOverlays !== 0) failures.push(`segment1 function: expected no function overlay before click, got ${before.functionOverlays}`);

  await page.locator('.flash-button-overlay[data-character="115"]').first().dispatchEvent("click");
  await page.waitForFunction(() => document.querySelectorAll(".function-call-instance").length > 0, null, { timeout: 10_000 });
  await page.waitForTimeout(300);

  const after = await captureRuntimeState(page, "segment1-function-after");
  if (after.functionOverlays < 1) failures.push("segment1 function: showShots click did not render function-call overlay");
  if (!after.status.includes("Ran showShots")) failures.push(`segment1 function: unexpected status after click: ${after.status}`);

  await page.locator('.flash-button-overlay[data-character="113"]').first().dispatchEvent("click");
  await page.waitForTimeout(300);

  const afterCombined = await captureRuntimeState(page, "segment1-function-combined-after");
  if (afterCombined.frame !== "35") failures.push(`segment1 function: combined release should resolve to frame 35 hold, got ${afterCombined.frame}`);
  if (afterCombined.status.includes("Ran ")) failures.push(`segment1 function: combined release did not continue into primary action: ${afterCombined.status}`);
  if (!afterCombined.status.includes("noKiosk")) failures.push(`segment1 function: combined release did not restore noKiosk stop state: ${afterCombined.status}`);

  return { before, after, afterCombined };
}

async function verifyNavExitNavigation(page) {
  await page.locator("#sceneSelect").selectOption("2");
  await page.waitForFunction(() => document.querySelector("#frameScrubber")?.getAttribute("max") === "437", null, { timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector("#frameStageInline svg"), null, { timeout: 20_000 });
  await page.locator("#frameScrubber").fill("365");
  await page.locator("#frameScrubber").dispatchEvent("input");
  await page.waitForFunction(() => document.querySelector('.flash-button-overlay[data-character="120"]'), null, { timeout: 20_000 });
  await page.waitForTimeout(300);

  const before = await captureRuntimeState(page, "nav-exit-before");
  if (before.selectedText !== "Navigation - nav.swf") failures.push(`nav exit: wrong starting scene: ${before.selectedText}`);
  if (before.frame !== "365") failures.push(`nav exit: expected frame 365 before click, got ${before.frame}`);

  await page.locator('.flash-button-overlay[data-character="120"]').first().evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await page.waitForFunction(() => document.querySelector("#sceneSelect option:checked")?.textContent === "Segment 3 - segment3.swf", null, { timeout: 15_000 });
  await page.waitForTimeout(300);

  const after = await captureRuntimeState(page, "nav-exit-after");
  if (after.selectedText !== "Segment 3 - segment3.swf") failures.push(`nav exit: expected Segment 3 after click, got ${after.selectedText}`);
  if (after.rufflePlayers < 1) failures.push("nav exit: Ruffle reference player missing after navigation");
  if (after.generatedSvg < 1) failures.push("nav exit: generated frame SVG missing after navigation");

  return { before, after };
}

async function verifyNavRootFunctionNavigation(page) {
  await page.locator("#sceneSelect").selectOption("2");
  await page.waitForFunction(() => document.querySelector("#frameScrubber")?.getAttribute("max") === "437", null, { timeout: 20_000 });
  await page.locator("#frameScrubber").fill("23");
  await page.locator("#frameScrubber").dispatchEvent("input");
  await page.waitForFunction(() => document.querySelector('.flash-button-overlay[data-character="109"]'), null, { timeout: 20_000 });
  await page.waitForTimeout(300);

  const before = await captureRuntimeState(page, "nav-root-function-before");
  if (before.selectedText !== "Navigation - nav.swf") failures.push(`nav root function: wrong starting scene: ${before.selectedText}`);
  if (before.frame !== "23") failures.push(`nav root function: expected frame 23 before click, got ${before.frame}`);

  await page.locator('.flash-button-overlay[data-character="109"]').first().dispatchEvent("click");
  await page.waitForFunction(() => document.querySelector("#sceneSelect option:checked")?.textContent === "Segment 4 - segment4.swf", null, { timeout: 15_000 });
  await page.waitForTimeout(300);

  const after = await captureRuntimeState(page, "nav-root-function-after");
  if (after.selectedText !== "Segment 4 - segment4.swf") failures.push(`nav root function: expected Segment 4 after click, got ${after.selectedText}`);
  if (after.rufflePlayers < 1) failures.push("nav root function: Ruffle reference player missing after navigation");
  if (after.generatedSvg < 1) failures.push("nav root function: generated frame SVG missing after navigation");

  return { before, after };
}

async function verifySceneLoads(page, optionValue, expectedText) {
  await page.locator("#sceneSelect").selectOption(optionValue);
  await page.waitForFunction(() => document.querySelector("#frameStageInline svg"), null, { timeout: 20_000 });
  await page.waitForTimeout(500);
  const state = await captureRuntimeState(page, "nav-load");
  if (state.selectedText !== expectedText) failures.push(`nav: wrong selected scene: ${state.selectedText}`);
  if (state.rufflePlayers < 1) failures.push("nav: Ruffle reference player missing");
  if (state.generatedSvg < 1) failures.push("nav: generated frame SVG missing");
  await page.screenshot({ path: join(outDir, "nav-full.png"), fullPage: false });
  return state;
}

async function captureRuntimeState(page, name) {
  const state = {
    selectedText: await page.locator("#sceneSelect option:checked").textContent(),
    frame: await page.locator("#frameScrubber").inputValue(),
    status: await page.locator("#status").textContent(),
    overlays: await page.locator(".flash-button-overlay").count(),
    functionOverlays: await page.locator(".function-call-instance").count(),
    externalLevels: await page.locator(".external-level-overlay").count(),
    externalLevelSwfs: await page.locator(".external-level-overlay").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-swf") ?? ""),
    ),
    externalLevelFrames: await page.locator(".external-level-overlay").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-frame") ?? ""),
    ),
    rufflePlayers: await page.locator("ruffle-player, ruffle-embed, ruffle-object").count(),
    generatedSvg: await page.locator("#frameStageInline svg").count(),
    playDisabled: await page.locator("#playBtn").isDisabled(),
  };
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

async function clickVisibleOverlay(page, overlay) {
  const overlayBox = await overlay.boundingBox();
  const stageBox = await page.locator("#assetStage").boundingBox();
  if (!overlayBox || !stageBox) {
    await overlay.click({ force: true });
    return;
  }

  const left = Math.max(overlayBox.x, stageBox.x);
  const top = Math.max(overlayBox.y, stageBox.y);
  const right = Math.min(overlayBox.x + overlayBox.width, stageBox.x + stageBox.width);
  const bottom = Math.min(overlayBox.y + overlayBox.height, stageBox.y + stageBox.height);

  if (right <= left || bottom <= top) {
    await overlay.click({ force: true });
    return;
  }

  await page.mouse.click(left + Math.max(1, (right - left) / 2), top + Math.max(1, (bottom - top) / 2));
}

function stateChanged(before, after) {
  return before.selectedText !== after.selectedText
    || before.frame !== after.frame
    || before.status !== after.status
    || before.overlays !== after.overlays;
}

async function screenshotStage(page, selector, fileName) {
  const locator = page.locator(selector);
  await locator.screenshot({ path: join(outDir, fileName), timeout: 10_000 });
}

function compareScreenshots(leftName, rightName) {
  const leftPath = join(outDir, leftName);
  const rightPath = join(outDir, rightName);
  if (!existsSync(leftPath) || !existsSync(rightPath)) return { status: "skipped", reason: "missing screenshot" };

  const left = PNG.sync.read(readFileSync(leftPath));
  const right = PNG.sync.read(readFileSync(rightPath));
  const width = Math.min(left.width, right.width);
  const height = Math.min(left.height, right.height);
  if (width <= 0 || height <= 0) return { status: "skipped", reason: "empty image" };
  const leftBlank = imageBlankness(left, width, height);
  const rightBlank = imageBlankness(right, width, height);
  if (leftBlank.isBlank) return { status: "skipped", reason: "blank Ruffle reference", ruffleBlankness: leftBlank, generatedBlankness: rightBlank };
  if (rightBlank.isBlank) return { status: "skipped", reason: "blank generated output", ruffleBlankness: leftBlank, generatedBlankness: rightBlank };

  let total = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const li = (y * left.width + x) * 4;
      const ri = (y * right.width + x) * 4;
      total += Math.abs(left.data[li] - right.data[ri]);
      total += Math.abs(left.data[li + 1] - right.data[ri + 1]);
      total += Math.abs(left.data[li + 2] - right.data[ri + 2]);
    }
  }

  return {
    status: "ok",
    comparedWidth: width,
    comparedHeight: height,
    ruffleBlankness: leftBlank,
    generatedBlankness: rightBlank,
    meanAbsoluteDifference: total / (width * height * 3),
  };
}

function summarizeVisualCoverage(comparisons) {
  const total = comparisons.length;
  const compared = comparisons.filter((comparison) => comparison.status === "ok").length;
  const expectedSkipped = comparisons.filter((comparison) => comparison.status !== "ok" && comparison.expectedSkip).length;
  const unexpectedSkipped = comparisons.filter((comparison) => comparison.status !== "ok" && !comparison.expectedSkip).length;
  const skipped = expectedSkipped + unexpectedSkipped;
  const comparable = total - expectedSkipped;
  const maxMeanAbsoluteDifference = Math.max(
    0,
    ...comparisons
      .filter((comparison) => comparison.status === "ok" && Number.isFinite(comparison.meanAbsoluteDifference))
      .map((comparison) => comparison.meanAbsoluteDifference),
  );
  return { total, comparable, compared, skipped, expectedSkipped, unexpectedSkipped, maxMeanAbsoluteDifference };
}

function imageBlankness(image, width, height) {
  let maxDistance = 0;
  let nonTransparentPixels = 0;
  const sums = [0, 0, 0];
  const squaredSums = [0, 0, 0];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * image.width + x) * 4;
      if ((image.data[i + 3] ?? 255) < 8) continue;
      nonTransparentPixels += 1;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = image.data[i + channel] ?? 0;
        sums[channel] += value;
        squaredSums[channel] += value * value;
      }
    }
  }

  if (!nonTransparentPixels) return { isBlank: true, averageStandardDeviation: 0, maxDistance, nonTransparentPixels };

  const means = sums.map((sum) => sum / nonTransparentPixels);
  const standardDeviations = squaredSums.map((sum, channel) =>
    Math.sqrt(Math.max(0, sum / nonTransparentPixels - means[channel] * means[channel])),
  );
  const averageStandardDeviation = standardDeviations.reduce((total, value) => total + value, 0) / standardDeviations.length;
  maxDistance = Math.max(...standardDeviations);

  return { isBlank: averageStandardDeviation < 3, averageStandardDeviation, maxDistance, nonTransparentPixels };
}

async function startServer(serverPort) {
  const child = spawn("npm", ["run", "dev", "--", "--port", String(serverPort), "--strictPort"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for Vite dev server on ${serverPort}\n${output}`)), 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Vite dev server exited with ${code}\n${output}`));
    });
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${serverPort}/`);
        if (response.ok) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      } catch {
        // Keep polling until Vite is ready or the timeout fires.
      }
    }, 250);
  });

  return child;
}
