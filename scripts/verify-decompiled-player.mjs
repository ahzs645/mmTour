import { chromium } from "playwright";

const URL = process.env.APP_URL ?? "http://127.0.0.1:5174/";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push(String(err)));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#renderMode");

// Pick segment1 (rich nested animation), switch to the decompiled player.
await page.selectOption("#sceneSelect", { label: "Segment 1 - segment1.swf" }).catch(() => {});
await page.waitForTimeout(1500);
await page.selectOption("#renderMode", "player");
await page.waitForTimeout(300);

const mountedCount = await page.$$eval("#playerLayer .player-instance", (n) => n.length);

// Start playback and sample sprite image srcs over time.
await page.click("#playBtn");

async function sampleSprites() {
  return page.$$eval("#playerLayer .player-instance img", (imgs) =>
    imgs.map((img) => img.getAttribute("src")).filter((s) => s && s.includes("/sprites/")),
  );
}

const t0 = await sampleSprites();
await page.waitForTimeout(700);
const t1 = await sampleSprites();

// Read the player's reported frame from the status line, then let the root reach
// a stop, and confirm sprite frames STILL change afterwards (independent loops).
const statusMid = await page.textContent("#status");
await page.waitForTimeout(1500);
const t2 = await sampleSprites();
const statusLate = await page.textContent("#status");

const spritesChanged_early = JSON.stringify(t0) !== JSON.stringify(t1);
const spritesChanged_late = JSON.stringify(t1) !== JSON.stringify(t2);

await page.screenshot({ path: "scripts/_player-verify.png" });
await browser.close();

console.log(JSON.stringify({
  mountedCount,
  spriteSamples: { t0: t0.length, t1: t1.length, t2: t2.length },
  spritesChanged_early,
  spritesChanged_late,
  statusMid: statusMid?.trim(),
  statusLate: statusLate?.trim(),
  consoleErrors: errors.slice(0, 8),
}, null, 2));

if (mountedCount === 0) { console.error("FAIL: player mounted no instances"); process.exit(1); }
if (!spritesChanged_early) { console.error("FAIL: sprites did not animate at all"); process.exit(1); }
console.log("OK");
