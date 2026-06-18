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

// Start the in-page coverage recorder at rAF frequency (catches sub-frame
// teardown blanks). Probe 5 points across the bar width — the white can be
// off-center where the nav bar extends but the segment bar doesn't.
await page.evaluate(() => {
  const layer = document.querySelector("#playerLayer");
  const rect = layer.getBoundingClientRect();
  const py = rect.bottom - 10;
  const xs = [0.12, 0.31, 0.5, 0.69, 0.88].map((f) => rect.left + rect.width * f);
  window.__t0 = performance.now();
  window.__samples = [];
  window.__gaps = [];
  const coversPt = (r, px) => r.left <= px && r.right >= px && r.top <= py && r.bottom >= py;
  let running = true;
  window.__stop = () => { running = false; };
  const tick = () => {
    if (!running) return;
    const levels = Array.from(document.querySelectorAll(".player-level")).map((lv) => {
      const imgs = Array.from(lv.querySelectorAll("img.player-media")).filter((im) => im.getAttribute("src"));
      return { z: lv.style.zIndex, imgs };
    });
    // For each x-point, is it covered by ANY image in ANY level?
    const uncovered = xs.filter((px) => !levels.some((l) => l.imgs.some((im) => coversPt(im.getBoundingClientRect(), px))));
    const t = Math.round(performance.now() - window.__t0);
    if (uncovered.length) {
      const detail = levels.map((l) => `z${l.z}:[${l.imgs.filter((im) => xs.some((px) => coversPt(im.getBoundingClientRect(), px))).map((im) => im.getAttribute("src").replace(/^.*\/generated\//, "")).join("|") || "-"}]`).join("  ");
      window.__gaps.push({ t, nUncovered: uncovered.length, detail });
    }
    window.__samples.push({ t, uncovered: uncovered.length });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// Sample for ~20s: at the throttled headless rate the nav exit (384→437) takes
// ~13s, so the toolbar-strip window (frames 432-437) lands ~12-15s after the click.
const layerEl = await page.$("#playerLayer");
for (let i = 0; i < 40; i++) {
  const ms = await page.evaluate(() => Math.round(performance.now() - window.__t0));
  if (layerEl) await layerEl.screenshot({ path: path.join(OUT, `s${String(i).padStart(2, "0")}_${String(ms).padStart(5, "0")}ms.png`) }).catch(() => {});
  await page.waitForTimeout(400);
}
await page.evaluate(() => window.__stop());
const { samples, gaps } = await page.evaluate(() => ({ samples: window.__samples, gaps: window.__gaps }));

console.log(`\n=== rAF coverage over bar width (${samples.length} frames sampled) ===`);
console.log(`frames with ANY uncovered point: ${samples.filter((s) => s.uncovered).length} / ${samples.length}`);
if (gaps.length) {
  console.log(`\n!!! ${gaps.length} uncovered frames (white showing through the bottom bar):`);
  for (const g of gaps) console.log(`  t=${String(g.t).padStart(5)}ms  ${g.nUncovered}/5 points white   ${g.detail}`);
} else {
  console.log("no uncovered frames — bottom bar fully continuous across the transition.");
}

await browser.close();
