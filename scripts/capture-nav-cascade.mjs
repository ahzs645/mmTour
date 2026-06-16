#!/usr/bin/env node
// Headless smoke test for the overflow→tree-render fix: load the nav scene in the
// decompiled "player" mode and screenshot a range of root frames so we can confirm
// the cascade sprites (now tree-rendered) draw real buttons instead of clipping/blanking.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5173/";
const SCENE = process.env.SCENE ?? "nav";
const FRAMES = (process.env.FRAMES ?? "0,4,8,12,16,20").split(",").map((n) => parseInt(n, 10));
const OUT = path.resolve("verification/nav-cascade");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on("console", (m) => { if (m.type() === "error") console.log("PAGE ERROR:", m.text()); });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", e.message));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector("#sceneSelect", { timeout: 60000 });

// Pick the nav scene.
const val = await page.$eval("#sceneSelect", (sel, scene) => {
  const opt = Array.from(sel.options).find((o) => o.textContent?.toLowerCase().includes(scene));
  return opt?.value ?? "";
}, SCENE);
if (!val) { console.error("no scene option for", SCENE); process.exit(1); }
await page.selectOption("#sceneSelect", val);
await page.waitForTimeout(500);

// Ensure decompiled player mode and pause so the scrubber controls the frame.
await page.selectOption("#renderMode", "player").catch(() => {});
await page.waitForTimeout(300);
const pauseBtn = await page.$("#playBtn");
if (pauseBtn) { const t = await pauseBtn.textContent(); if (/pause/i.test(t ?? "")) await pauseBtn.click(); }

await mkdir(OUT, { recursive: true });
for (const f of FRAMES) {
  await page.$eval("#frameScrubber", (input, frame) => {
    input.value = String(frame);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, f);
  await page.waitForTimeout(250);
  // Count rendered nodes inside the player layer to detect blank frames.
  const count = await page.$$eval("#playerLayer *", (els) => els.length).catch(() => -1);
  const file = path.join(OUT, `${SCENE}-f${String(f).padStart(3, "0")}.png`);
  const layer = await page.$("#playerLayer");
  if (layer) await layer.screenshot({ path: file });
  else await page.screenshot({ path: file });
  console.log(`frame ${f}: ${count} DOM nodes → ${file}`);
}

await browser.close();
