#!/usr/bin/env node
// Verify the browser convert UI persists imported .mmtour.pack source bytes in
// IndexedDB and can replay the imported scene after a page reload.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://127.0.0.1:4174/mmTour/convert-play.html";
const sample = process.env.SAMPLE ?? "segment4";
const tmp = mkdtempSync(join(tmpdir(), "mmtour-pack-"));

const browser = await chromium.launch();
const exporter = await browser.newContext({ acceptDownloads: true });
const importer = await browser.newContext();

try {
  const packPath = await exportSamplePack(exporter, sample);
  const result = await importReloadAndPlay(importer, packPath);
  console.log(JSON.stringify(result, null, 2));
  if (!result.packRows) fail("no pack-backed history rows after import");
  if (!result.playerVisible) fail("pack-backed history row did not play after reload");
  if (!result.playerMedia) fail("played pack did not render any player media");
  if (!result.playerHits) fail("played pack did not expose any player hit areas");
  console.log("OK");
} finally {
  await browser.close();
}

async function exportSamplePack(context, name) {
  const page = await context.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto(base, { waitUntil: "load", timeout: 30_000 });
  await page.getByRole("button", { name, exact: true }).click();
  await page.waitForSelector(".card:not(.busy)", { timeout: 120_000 });
  await page.locator(".card", { has: page.locator("h3", { hasText: `${name}.swf` }) }).first().locator(".export").click({ trial: true });
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.locator(".card", { has: page.locator("h3", { hasText: `${name}.swf` }) }).first().locator(".export").click();
  const download = await downloadPromise;
  const path = join(tmp, await download.suggestedFilename());
  await download.saveAs(path);
  await page.close();
  return path;
}

async function importReloadAndPlay(context, packPath) {
  const page = await context.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto(base, { waitUntil: "load", timeout: 30_000 });
  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator("#drop").click();
  const chooser = await chooserPromise;
  await chooser.setFiles(packPath);
  await page.waitForFunction(() => [...document.querySelectorAll(".hrow em")].some((node) => node.textContent === "pack"), null, { timeout: 30_000 });
  await stalePackCompiledVersion(page);

  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => [...document.querySelectorAll(".hrow em")].some((node) => node.textContent === "pack"), null, { timeout: 30_000 });
  await page.locator(".hrow", { has: page.locator("em", { hasText: "pack" }) }).first().getByRole("button", { name: /^Play / }).click();
  await page.waitForFunction(() => document.querySelector("#player-wrap")?.classList.contains("on"), null, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll("#player .player-media").length > 0, null, { timeout: 30_000 });
  await page.waitForTimeout(1_800);

  const result = await page.evaluate(() => ({
    packRows: [...document.querySelectorAll(".hrow em")].filter((node) => node.textContent === "pack").length,
    playerVisible: document.querySelector("#player-wrap")?.classList.contains("on") ?? false,
    playerMedia: document.querySelectorAll("#player .player-media").length,
    playerHits: document.querySelectorAll("#player .player-hit").length,
    historyRows: [...document.querySelectorAll(".hrow")].map((row) => row.textContent?.replace(/\s+/g, " ").trim()),
  }));
  await page.close();
  return result;
}

async function stalePackCompiledVersion(page) {
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const open = indexedDB.open("mmtour-converts");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("converts", "readwrite");
        const store = tx.objectStore("converts");
        const all = store.getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = () => {
          const row = all.result.find((record) => record.sourceType === "pack");
          if (!row?.compiled) {
            reject(new Error("pack row with compiled data not found"));
            return;
          }
          row.compiled.version = -1;
          store.put(row);
        };
        tx.oncomplete = () => {
          db.close();
          resolve(undefined);
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}
