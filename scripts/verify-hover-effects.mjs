import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = resolve(new URL("..", import.meta.url).pathname);
const outDir = join(root, "verification", "hover-effects");
const port = Number(process.env.VERIFY_HOVER_PORT ?? 5181);
const baseUrl = process.env.VERIFY_URL ?? `http://127.0.0.1:${port}/`;
const shouldStartServer = !process.env.VERIFY_URL;
const scenes = ["nav", "segment1", "segment2", "segment3", "segment4", "segment5"];
const failures = [];
const warnings = [];

mkdirSync(outDir, { recursive: true });

let server;
let browser;

try {
  if (shouldStartServer) server = await startServer(port);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });

  page.on("console", (message) => {
    if (message.type() === "error") warnings.push(`browser console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => failures.push(`browser page error: ${error.message}`));

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.locator("#sceneSelect").waitFor({ state: "visible", timeout: 20_000 });

  const results = [];
  for (const scene of scenes) {
    results.push(await verifySceneHover(page, scene));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    results,
    warnings,
    failures,
  };

  writeFileSync(join(outDir, "hover-effects-report.json"), `${JSON.stringify(report, null, 2)}\n`);

  for (const result of results) {
    console.log(
      `${result.scene}: hoverStates=${result.coveredStateButtons}/${result.expectedStateButtons}, rollOvers=${result.coveredRollOverButtons}/${result.expectedRollOverButtons}, framesScanned=${result.framesScanned}`,
    );
  }
  console.log(`Wrote ${join(outDir, "hover-effects-report.json")}`);

  if (failures.length) {
    for (const failure of failures) console.error(`error: ${failure}`);
    process.exit(1);
  }
} finally {
  await browser?.close();
  if (server) {
    if (server.exitCode === null && !server.killed) {
      server.kill("SIGTERM");
      await new Promise((resolveExit) => server.once("exit", resolveExit));
    }
  }
}

async function verifySceneHover(page, scene) {
  const timeline = JSON.parse(readFileSync(join(root, "public", "generated", scene, "timeline.json"), "utf8"));
  const buttonActions = timeline.control?.buttonActions ?? {};
  const expectedStateButtons = new Set(
    Object.entries(buttonActions)
      .filter(([id, action]) => action.release && hasRenderableState(timeline.assets?.[`button:${id}`]?.states?.over))
      .map(([id]) => id),
  );
  const expectedRollOverButtons = new Set(
    Object.entries(buttonActions)
      .filter(([, action]) => action.rollOver)
      .map(([id]) => id),
  );
  const coveredStates = new Map();
  const coveredRollOvers = new Map();
  const sceneOptionLabel = labelForScene(scene);
  const candidateFrames = framesLikelyToContainButtons(timeline, buttonActions);

  await page.locator("#sceneSelect").selectOption({ label: sceneOptionLabel });
  await page.waitForFunction(
    (max) => document.querySelector("#frameScrubber")?.getAttribute("max") === max,
    String(timeline.frameCount - 1),
    { timeout: 20_000 },
  );

  let framesScanned = 0;
  for (const frame of candidateFrames) {
    if (setsCovered(expectedStateButtons, coveredStates) && setsCovered(expectedRollOverButtons, coveredRollOvers)) break;
    framesScanned += 1;

    await setFrame(page, frame);
    const overlays = await page.evaluate(() => {
      return [...document.querySelectorAll(".flash-button-overlay")].map((element, index) => ({
        index,
        character: element.getAttribute("data-character"),
        hitCharacter: element.getAttribute("data-hit-character"),
        ownerCharacter: element.getAttribute("data-owner-character"),
      }));
    });

    for (const overlay of overlays) {
      const id = overlay.character;
      if (!id) continue;
      if (!expectedStateButtons.has(id) && !expectedRollOverButtons.has(id)) continue;
      if (coveredStates.has(id) && (!expectedRollOverButtons.has(id) || coveredRollOvers.has(id))) continue;

      const hoverResult = await hoverOverlay(page, overlay.index);
      if (expectedStateButtons.has(id)) {
        if (hoverResult.state?.requestedState === "over" && hoverResult.state?.state === "over" && hoverResult.state?.fallbackState === "false") {
          coveredStates.set(id, { frame, overlay, hoverResult });
        } else {
          failures.push(`${scene}: button ${id} at frame ${frame + 1} did not render its extracted over state on hover`);
        }
      }

      if (expectedRollOverButtons.has(id)) {
        if (hoverResult.hoverLoopAppeared || hoverResult.functionOverlayChanged || hoverResult.state?.state === "over") {
          coveredRollOvers.set(id, { frame, overlay, hoverResult });
        } else {
          failures.push(`${scene}: button ${id} at frame ${frame + 1} did not show any rollover effect`);
        }
      }
    }
  }

  for (const id of expectedStateButtons) {
    if (!coveredStates.has(id)) failures.push(`${scene}: never found/tested hover state for button ${id}`);
  }
  for (const id of expectedRollOverButtons) {
    if (!coveredRollOvers.has(id)) failures.push(`${scene}: never found/tested rollOver behavior for button ${id}`);
  }

  return {
    scene,
    expectedStateButtons: expectedStateButtons.size,
    coveredStateButtons: coveredStates.size,
    expectedRollOverButtons: expectedRollOverButtons.size,
    coveredRollOverButtons: coveredRollOvers.size,
    framesScanned,
    coveredStates: Object.fromEntries(coveredStates),
    coveredRollOvers: Object.fromEntries(coveredRollOvers),
  };
}

function hasRenderableState(state) {
  return Boolean(state && state.origin?.width > 0 && state.origin?.height > 0);
}

function framesLikelyToContainButtons(timeline, buttonActions) {
  const ownerSpriteIds = new Set(
    Object.values(buttonActions)
      .flatMap((action) => action.ownerSpriteIds ?? [])
      .map(String),
  );
  const stopFrames = new Set(timeline.control?.stopFrames ?? []);
  const labelFrames = new Set(Object.values(timeline.labels ?? {}));
  const frames = [];

  for (const frame of timeline.frames ?? []) {
    const hasOwner = frame.instances?.some((instance) => ownerSpriteIds.has(String(instance.characterId)));
    const isStopOrLabel = stopFrames.has(frame.index) || labelFrames.has(frame.index);
    if (hasOwner || isStopOrLabel) frames.push(frame.index);
  }

  if (!frames.includes(timeline.entryFrame ?? 0)) frames.unshift(timeline.entryFrame ?? 0);
  return [...new Set(frames)].sort((a, b) => a - b);
}

async function setFrame(page, frame) {
  await page.locator("#frameScrubber").fill(String(frame));
  await page.locator("#frameScrubber").dispatchEvent("input");
  await page.waitForFunction(
    (value) => document.querySelector("#frameScrubber")?.value === value && document.querySelector("#frameStageInline svg"),
    String(frame),
    { timeout: 20_000 },
  );
  await page.waitForTimeout(50);
}

async function hoverOverlay(page, index) {
  await page.evaluate((overlayIndex) => {
    document.querySelector(".flash-button-state-overlay")?.remove();
    const beforeFunctionOverlays = document.querySelectorAll(".function-call-instance").length;
    const beforeHoverLoops = document.querySelectorAll(".hover-loop-instance").length;
    document.documentElement.dataset.beforeFunctionOverlays = String(beforeFunctionOverlays);
    document.documentElement.dataset.beforeHoverLoops = String(beforeHoverLoops);

    const element = document.querySelectorAll(".flash-button-overlay")[overlayIndex];
    element?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: true, view: window }));
    element?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, cancelable: true, view: window }));
  }, index);
  await page.waitForTimeout(125);

  const result = await page.evaluate(() => {
    const state = document.querySelector(".flash-button-state-overlay");
    const beforeFunctionOverlays = Number(document.documentElement.dataset.beforeFunctionOverlays ?? "0");
    const beforeHoverLoops = Number(document.documentElement.dataset.beforeHoverLoops ?? "0");
    const afterFunctionOverlays = document.querySelectorAll(".function-call-instance").length;
    const afterHoverLoops = document.querySelectorAll(".hover-loop-instance").length;

    return {
      state: state
        ? {
            character: state.getAttribute("data-character"),
            requestedState: state.getAttribute("data-requested-state"),
            state: state.getAttribute("data-state"),
            fallbackState: state.getAttribute("data-fallback-state"),
            href: state.getAttribute("href"),
          }
        : null,
      hoverLoopAppeared: afterHoverLoops > beforeHoverLoops,
      functionOverlayChanged: afterFunctionOverlays !== beforeFunctionOverlays,
      beforeFunctionOverlays,
      afterFunctionOverlays,
      beforeHoverLoops,
      afterHoverLoops,
    };
  });

  await page.evaluate((overlayIndex) => {
    const element = document.querySelectorAll(".flash-button-overlay")[overlayIndex];
    element?.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false, cancelable: true, view: window }));
    element?.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, cancelable: true, view: window }));
  }, index).catch(() => {});
  await page.waitForTimeout(25);

  return result;
}

function setsCovered(expected, covered) {
  for (const id of expected) {
    if (!covered.has(id)) return false;
  }
  return true;
}

function labelForScene(scene) {
  if (scene === "nav") return "Navigation - nav.swf";
  if (scene === "segment5") return "Basics - segment5.swf";
  const match = scene.match(/^segment(\d)$/);
  if (match) return `Segment ${match[1]} - ${scene}.swf`;
  return `${scene}.swf`;
}

async function startServer(port) {
  const child = spawn("npm", ["run", "dev", "--", "--port", String(port)], {
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

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Dev server exited early:\n${output}`);
    if (await canFetch(`http://127.0.0.1:${port}/`)) return child;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(`Timed out waiting for dev server:\n${output}`);
}

async function canFetch(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}
