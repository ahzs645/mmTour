// Playwright page helpers for driving the comparison app's Decompiled Player.
// Pure interaction wrappers (no diff math, no reporting) so the player-vs-Ruffle
// harness reads as a sequence of intent, not selector plumbing.

/** Open the app and wait for the scene picker to be interactive. */
export async function openApp(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.locator("#sceneSelect").waitFor({ state: "visible", timeout: 20_000 });
}

/** Every scene in the picker, as `{ value, label }`. */
export function listScenes(page) {
  return page.locator("#sceneSelect option").evaluateAll((nodes) =>
    nodes.map((node) => ({ value: node.value, label: node.textContent ?? "" })),
  );
}

/** Select a scene and let both the Ruffle embed and the player remount. */
export async function selectScene(page, value, settleMs = 1_200) {
  await page.locator("#sceneSelect").selectOption(value);
  await page.waitForTimeout(settleMs);
}

/** Switch the right-hand renderer (`player` | `frame` | `direct`). */
export async function setRenderMode(page, mode, settleMs = 800) {
  await page.locator("#renderMode").selectOption(mode);
  await page.waitForTimeout(settleMs);
}

/**
 * Wait until the Decompiled Player's root playhead holds steady — it hit a `stop()`
 * or a waiting loop and is no longer advancing the root. Nested attract clips keep
 * looping, but the root frame is the stable comparison anchor. Polls the frame
 * scrubber until it repeats for `stableMs`, or returns at `maxMs` for scenes that
 * never settle (a continuous animation like the intro). Returns the observed state.
 */
export async function waitForPlayerStable(page, { stableMs = 1_500, maxMs = 12_000, pollMs = 250 } = {}) {
  const scrubber = page.locator("#frameScrubber");
  const start = Date.now();
  let lastFrame = null;
  let stableSince = Date.now();
  let settled = false;
  while (Date.now() - start < maxMs) {
    const frame = await scrubber.inputValue();
    if (frame === lastFrame) {
      if (Date.now() - stableSince >= stableMs) { settled = true; break; }
    } else {
      lastFrame = frame;
      stableSince = Date.now();
    }
    await page.waitForTimeout(pollMs);
  }
  return { ...(await captureState(page)), settled, waitedMs: Date.now() - start };
}

/** Structural snapshot of the runtime — frame, status, hit areas, Ruffle presence. */
export async function captureState(page) {
  return {
    selectedText: await page.locator("#sceneSelect option:checked").textContent(),
    renderMode: await page.locator("#renderMode").inputValue(),
    frame: await page.locator("#frameScrubber").inputValue(),
    frameMax: await page.locator("#frameScrubber").getAttribute("max"),
    status: await page.locator("#status").textContent(),
    playerHits: await page.locator(".player-hit").count(),
    playerNodes: await page.locator("#playerLayer *").count(),
    rufflePlayers: await page.locator("ruffle-player, ruffle-embed, ruffle-object").count(),
  };
}

/** Screenshot a stage element to `path`; never throws (best-effort capture). */
export async function shootStage(page, selector, path) {
  await page.locator(selector).screenshot({ path }).catch(() => {});
}

/** Pause the player if it is currently playing (Play button toggles label). */
export async function ensurePaused(page) {
  const label = await page.locator("#playBtn").textContent().catch(() => "");
  if (label && /Pause/.test(label)) await page.locator("#playBtn").click().catch(() => {});
}

/** Resume the player if it is paused — so a time-series captures real motion. */
export async function ensurePlaying(page) {
  const label = await page.locator("#playBtn").textContent().catch(() => "");
  if (label && !/Pause/.test(label)) await page.locator("#playBtn").click().catch(() => {});
}
