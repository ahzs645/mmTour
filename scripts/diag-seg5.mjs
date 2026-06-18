#!/usr/bin/env node
// Diagnose the deterministic "Windows XP Basics (segment5) always flashes white".
// Drives A-tour → Skip Intro → click StartHere, then polls the live player state
// (does level4 cover the stage? is the page context still alive?) and logs console.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5173/";
const CHARS = (process.env.CHARS ?? "150,148,138,140").split(",");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 2000 } });
page.on("console", (m) => { const t = m.text(); if (!/send was called before connect/.test(t)) console.log(`[console.${m.type()}] ${t}`.slice(0, 200)); });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
page.on("crash", () => console.log("!!! PAGE CRASHED"));
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("!!! FRAME NAVIGATED ->", f.url()); });

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#sceneSelect", { timeout: 60000 });
const val = await page.$eval("#sceneSelect", (sel) => Array.from(sel.options).find((o) => /a-tour/i.test(o.textContent ?? ""))?.value ?? "");
await page.selectOption("#sceneSelect", val);
await page.waitForTimeout(400);
await page.selectOption("#renderMode", "player").catch(() => {});
await page.waitForTimeout(400);
const playBtn = await page.$("#playBtn");
if (playBtn) { const t = await playBtn.textContent(); if (/^play/i.test((t ?? "").trim())) await playBtn.click(); }

await page.waitForSelector('.player-instance[data-character="109"] img.player-hit', { timeout: 280000, state: "attached" });
await page.locator('.player-instance[data-character="109"] img.player-hit').first().click({ timeout: 15000 });
console.log("clicked Skip Intro");

const catSel = CHARS.map((c) => `.player-instance[data-character="${c}"] img.player-hit`).join(", ");
await page.waitForSelector(catSel, { timeout: 120000, state: "attached" });
await page.waitForTimeout(600);
await page.locator(catSel).first().click({ timeout: 20000 });
console.log("clicked StartHere (segment5) — polling player state...\n");

// Poll ~24s (long enough to reach the nav strip at headless's throttled rate).
// Identify each level by its z-index; report which scene each holds and whether
// any of its images covers the bottom-center point (the bar). White = no level covers.
let prevSig = "";
for (let i = 0; i < 80; i++) {
  let snap;
  try {
    snap = await page.evaluate(() => {
      const root = document.querySelector("#playerLayer").getBoundingClientRect();
      const px = root.left + root.width / 2, py = root.bottom - 10;
      const covers = (r) => r.left <= px && r.right >= px && r.top <= py && r.bottom >= py;
      const levels = Array.from(document.querySelectorAll(".player-level")).map((lv) => {
        const imgs = Array.from(lv.querySelectorAll("img.player-media")).filter((im) => im.getAttribute("src"));
        const scenes = [...new Set(imgs.map((im) => (im.getAttribute("src").match(/generated\/([\w-]+)\//) || [])[1]).filter(Boolean))];
        const bottomImg = imgs.find((im) => covers(im.getBoundingClientRect()));
        const bottomSrc = bottomImg ? bottomImg.getAttribute("src").replace(/^.*\/generated\//, "") : null;
        return { z: +lv.style.zIndex, n: imgs.length, scenes, bottomSrc };
      }).sort((a, b) => a.z - b.z);
      const anyBottom = levels.some((l) => l.bottomSrc);
      return { ok: true, levels, gap: !anyBottom };
    });
  } catch (e) {
    console.log(`t~${i * 300}ms  !!! CONTEXT LOST: ${String(e.message).slice(0, 80)}`);
    break;
  }
  const sig = snap.levels.map((l) => `z${l.z}(${l.scenes.join("/")||"?"}):${l.bottomSrc ? "BAR" : "-"}`).join(" ");
  if (sig !== prevSig || snap.gap) {
    console.log(`t~${String(i * 300).padStart(5)}ms  ${snap.gap ? "WHITE-BOTTOM " : "            "}${sig}`);
    prevSig = sig;
  }
  await page.waitForTimeout(300);
}

await browser.close();
