#!/usr/bin/env node
// Verify the section-prefetch: load the A-tour shell, watch network for each
// segment's timeline.json, and confirm they are fetched EARLY (when the nav loads)
// — before any category is clicked — so a section change paints instantly.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5173/";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 2000 } });

const t0 = Date.now();
const seg = [];
const errors = [];
page.on("request", (r) => {
  const u = r.url();
  const m = u.match(/\/generated\/(segment\d+|nav|intro)\/timeline\.json/);
  if (m) seg.push({ scene: m[1], t: Date.now() - t0 });
});
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("EXC: " + e.message));

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#sceneSelect", { timeout: 60000 });
const val = await page.$eval("#sceneSelect", (sel) => Array.from(sel.options).find((o) => /a-tour/i.test(o.textContent ?? ""))?.value ?? "");
await page.selectOption("#sceneSelect", val);
await page.waitForTimeout(400);
await page.selectOption("#renderMode", "player").catch(() => {});
await page.waitForTimeout(400);
const playBtn = await page.$("#playBtn");
if (playBtn) { const t = await playBtn.textContent(); if (/^play/i.test((t ?? "").trim())) await playBtn.click(); }

// Wait for Skip Intro to appear, then click it (this is where the menu/nav settles).
await page.waitForSelector('.player-instance[data-character="109"] img.player-hit', { timeout: 280000, state: "attached" });
const skipT = Date.now() - t0;
await page.locator('.player-instance[data-character="109"] img.player-hit').first().click({ timeout: 15000 });

// Wait for a category button to be clickable — the point a user could trigger a section change.
await page.waitForSelector('.player-instance[data-character="120"] img.player-hit, .player-instance[data-character="122"] img.player-hit', { timeout: 120000, state: "attached" });
const catReadyT = Date.now() - t0;
await page.waitForTimeout(500);

const prefetchedBeforeClick = [...new Set(seg.filter((s) => /segment/.test(s.scene)).map((s) => s.scene))];
console.log("\n=== timeline.json fetches (scene @ ms since load) ===");
for (const s of seg) console.log(`  ${s.scene} @ ${s.t}ms`);
console.log(`\nskip-intro available @ ${skipT}ms; category clickable @ ${catReadyT}ms`);
console.log(`\nsegments prefetched BEFORE a category was clickable: [${prefetchedBeforeClick.join(", ")}] (${prefetchedBeforeClick.length}/5)`);
console.log(`all-5 warm before user can click a section: ${prefetchedBeforeClick.length === 5 ? "YES ✅" : "NO ❌"}`);
console.log(`console errors during run: ${errors.length}`);
for (const e of errors.slice(0, 8)) console.log("  ! " + e);

await browser.close();
