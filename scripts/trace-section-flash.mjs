#!/usr/bin/env node
// Shell trace for the "bottom bar flashes white on section change" bug.
// Drives A-tour in player mode → Skip Intro → click a category button, while
// sampling every .player-level layer's coverage of the bottom-center point so we
// can see, frame by frame, when the bar leaves and what (if anything) is behind it.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5173/";
// ConnectedHome → segment3 (the occlusion-doc section); 120 = icon hit, 122 = label hit.
const CATEGORY_CHARS = (process.env.CHARS ?? "120,122").split(",");
const OUT = path.resolve("verification/section-flash");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 2000 } });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", e.message));

// SLOW=<ms>: delay the segment's image responses to mimic a real browser's
// image-decode latency on a fresh (uncached) segment load — exposing any blank
// frame a reload paints before its <img>s decode. (Headless's instant local
// decode hides it.) timeline.json is left fast so the layer still builds promptly.
if (process.env.SLOW) {
  const ms = Number(process.env.SLOW) || 600;
  await page.route(/\/generated\/segment\d+\/.*\.(svg|png)(\?.*)?$/i, async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#sceneSelect", { timeout: 60000 });

// Select the Tour Shell scene + decompiled player mode.
const val = await page.$eval("#sceneSelect", (sel) => {
  const opt = Array.from(sel.options).find((o) => /a-tour/i.test(o.textContent ?? ""));
  return opt?.value ?? "";
});
if (!val) { console.error("no A-tour option"); process.exit(1); }
await page.selectOption("#sceneSelect", val);
await page.waitForTimeout(400);
await page.selectOption("#renderMode", "player").catch(() => {});
await page.waitForTimeout(400);
// Make sure it's playing.
const playBtn = await page.$("#playBtn");
if (playBtn) { const t = await playBtn.textContent(); if (/^play/i.test((t ?? "").trim())) await playBtn.click(); }

// Debug: every 8s log which interactive characters + frame label are on stage.
const dbg = setInterval(async () => {
  try {
    const chars = await page.$$eval(".player-instance[data-character]", (els) => Array.from(new Set(els.map((e) => e.getAttribute("data-character")))).join(","));
    const lbl = await page.$eval("#frameStatus, #statusLabel, #frameLabel", (e) => e.textContent).catch(() => "");
    console.log(`  [dbg] chars=[${chars}] ${lbl ?? ""}`);
  } catch {}
}, 8000);

// locator.click() auto-scrolls the target into the viewport — the stage renders
// far down the page, so raw mouse coords would land off-screen and do nothing.
const clickSel = async (sel, label) => {
  console.log(`waiting for ${label} (${sel}) ...`);
  await page.waitForSelector(sel, { timeout: 280000, state: "attached" });
  await page.waitForTimeout(800); // let it settle onto its stop frame
  await page.locator(sel).first().click({ timeout: 20000 });
  console.log(`clicked ${label}`);
};

await clickSel('.player-instance[data-character="109"] img.player-hit', "Skip Intro");
// after skip, the nav cascade settles; click whichever target category is present
const catSel = CATEGORY_CHARS.map((c) => `.player-instance[data-character="${c}"] img.player-hit`).join(", ");
await clickSel(catSel, `category [${CATEGORY_CHARS.join(",")}]`);
clearInterval(dbg);

await mkdir(OUT, { recursive: true });
await page.evaluate(() => { window.__t0 = performance.now(); });

// Dense screenshots through the transition. We analyse the actual PIXELS at the
// bottom (white vs the periwinkle bar) afterwards — an image being present in the
// DOM doesn't mean it's painting the bar, so trust pixels, not element coverage.
const layerEl = await page.$("#playerLayer");
const shots = [];
for (let i = 0; i < 80; i++) {
  const ms = await page.evaluate(() => Math.round(performance.now() - window.__t0));
  const file = path.join(OUT, `s${String(i).padStart(2, "0")}_${String(ms).padStart(5, "0")}ms.png`);
  if (layerEl) { await layerEl.screenshot({ path: file }).catch(() => {}); shots.push({ ms, file }); }
  await page.waitForTimeout(200);
}
await browser.close();

// --- Pixel analysis: classify the bottom strip of each shot as white vs bar -----
const { PNG } = await import("pngjs");
const { readFileSync } = await import("node:fs");
const classify = (file) => {
  const png = PNG.sync.read(readFileSync(file));
  const { width, height, data } = png;
  const y0 = Math.max(0, height - 18), y1 = height - 3; // bottom strip, above the very edge
  let white = 0, peri = 0, total = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = Math.floor(width * 0.1); x < width * 0.9; x += 4) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      total++;
      if (r > 235 && g > 235 && b > 235) white++;
      else if (b > 150 && b > r + 30 && g > 90 && g < 200) peri++; // ~#6687ff periwinkle bar
    }
  }
  return { whitePct: Math.round((white / total) * 100), periPct: Math.round((peri / total) * 100) };
};

console.log("\n=== bottom-strip pixel classification (white% vs periwinkle-bar%) ===");
let prev = "";
for (const s of shots) {
  const c = classify(s.file);
  const tag = c.whitePct > 60 ? "  <<< MOSTLY WHITE (flash?)" : c.periPct > 40 ? "  bar" : "";
  const sig = `${c.whitePct >= 60 ? "WHITE" : c.periPct >= 40 ? "BAR" : "other"}`;
  if (sig !== prev || tag) console.log(`  t=${String(s.ms).padStart(5)}ms  white=${String(c.whitePct).padStart(3)}%  peri=${String(c.periPct).padStart(3)}%${tag}`);
  prev = sig;
}
const whiteShots = shots.map((s) => ({ ...s, c: classify(s.file) })).filter((s) => s.c.whitePct > 60);
console.log(`\nshots with bottom MOSTLY WHITE: ${whiteShots.length}/${shots.length}`);
if (whiteShots.length) console.log("  white at:", whiteShots.map((s) => s.ms + "ms").join(", "));
