#!/usr/bin/env node
// Definitive in-context test: drive the A-tour shell, skip the intro, then verify the
// post-skip cascade shows the bottom controls (issue #1) and that hovering a category
// button triggers its glow (issue #2). Events are dispatched directly on the rendered
// hit elements (the player layer sits below the viewport fold).
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const OUT = path.resolve("verification/atour");
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on("pageerror", (e) => console.log("EXC:", e.message));

await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
await page.waitForSelector("#sceneSelect");
const val = await page.$eval("#sceneSelect", (sel) => {
  const opt = Array.from(sel.options).find((o) => /a-tour/i.test(o.textContent ?? ""));
  return opt?.value ?? "";
});
if (!val) { console.error("no A-tour option"); process.exit(1); }
await page.selectOption("#sceneSelect", val);
await page.waitForTimeout(500);
await page.selectOption("#renderMode", "player").catch(() => {});
await page.waitForTimeout(500);

const layer = () => page.$("#playerLayer");

// Helper: list interactive hit areas across all level layers, with positions in stage px.
async function hits() {
  return page.$$eval(".player-level .player-hit, #playerLayer .player-hit", (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      // stage-local: subtract the player layer offset
      const layerEl = el.closest("#playerLayer");
      const lr = layerEl?.getBoundingClientRect() ?? { x: 0, y: 0 };
      return { src: (el.getAttribute("src") || "").split("/").slice(-2).join("/"), sx: Math.round(r.x - lr.x), sy: Math.round(r.y - lr.y), w: Math.round(r.width), h: Math.round(r.height) };
    }).filter((h) => h.w > 5),
  );
}

// Let the intro play a bit, then find + click the skip button (its src is the skip-intro art,
// or it sits in the bottom-left ~y>440). Try a few times as the intro loads asynchronously.
let skipped = false;
for (let attempt = 0; attempt < 12 && !skipped; attempt++) {
  await page.waitForTimeout(1000);
  const list = await hits();
  // The skip button is in the lower-left; click the lowest-leftmost sizable hit.
  const skip = list.filter((h) => h.sy > 430 && h.sx < 260 && h.w > 40).sort((a, b) => b.sy - a.sy)[0];
  if (skip) {
    console.log(`attempt ${attempt}: clicking skip candidate`, JSON.stringify(skip));
    await page.evaluate((target) => {
      const els = Array.from(document.querySelectorAll("#playerLayer .player-hit"));
      const el = els.find((e) => { const r = e.getBoundingClientRect(); const lr = e.closest("#playerLayer").getBoundingClientRect(); return Math.abs((r.x - lr.x) - target.sx) < 3 && Math.abs((r.y - lr.y) - target.sy) < 3; });
      if (el) { for (const t of ["pointerdown", "pointerup"]) el.dispatchEvent(new PointerEvent(t, { bubbles: true })); }
    }, skip);
    skipped = true;
  } else {
    console.log(`attempt ${attempt}: hits=${list.length}`, JSON.stringify(list.slice(0, 8)));
  }
}

await page.waitForTimeout(6000); // let the cascade fully settle
const l = await layer();
await l.screenshot({ path: path.join(OUT, "post-skip.png") });
console.log("post-skip hits:", JSON.stringify(await hits()));

// Hover a category button — prefer a wide label strip (w>200) on the left.
const postHits = await hits();
const cat = postHits.filter((h) => h.w > 200 && h.sy < 450).sort((a, b) => a.sy - b.sy)[0]
  ?? postHits.filter((h) => !h.src && h.w > 60).sort((a, b) => a.sy - b.sy)[0];
if (cat) {
  console.log("hovering category button:", JSON.stringify(cat));
  await page.evaluate((target) => {
    const els = Array.from(document.querySelectorAll("#playerLayer .player-hit"));
    const el = els.find((e) => { const r = e.getBoundingClientRect(); const lr = e.closest("#playerLayer").getBoundingClientRect(); return Math.abs((r.x - lr.x) - target.sx) < 3 && Math.abs((r.y - lr.y) - target.sy) < 3; });
    if (el) el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
  }, cat);
  await page.waitForTimeout(800);
  await l.screenshot({ path: path.join(OUT, "post-skip-hover.png") });
} else {
  console.log("no category hover target found");
}

await browser.close();
console.log("done");
