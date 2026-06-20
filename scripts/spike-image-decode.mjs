// Spike test: decode every DefineBitmap in a SWF with the pure-TS image decoder
// (src/convert/imageDecoder) and pixel-diff it against FFDec's golden PNG
// (public/generated/<scene>/images/<id>.png).
//
//   node scripts/spike-image-decode.mjs [scene] [id ...]
//
// JPEGs are reconstructed to standalone bytes in Node; lossless images are
// unpacked to RGBA and PNG-encoded with pngjs. Decoding + comparison runs in
// Chrome (Playwright) — the same platform decoder a browser-native converter
// would use — so the JPEG pixels come from the real codec.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSwf } from "swf-parser";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { collectBitmaps, isJpegBitmap, mergeJpeg, decodeLossless } from "../src/convert/index.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const scene = process.argv[2] ?? "segment5";
const onlyIds = process.argv.slice(3).map(Number);

const swfPath = join(root, "public", `${scene}.swf`);
const goldDir = join(root, "public/generated", scene, "images");
const outDir = join(root, "verification/spike-img", scene);
if (!existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);
mkdirSync(outDir, { recursive: true });

const movie = parseSwf(new Uint8Array(readFileSync(swfPath)));
const { bitmaps, jpegTables } = collectBitmaps(movie);
const targets = onlyIds.length ? bitmaps.filter((b) => onlyIds.includes(b.id)) : bitmaps;

// --- Node stage: produce `mine` bytes for each bitmap ---------------------
const items = [];
for (const tag of targets) {
  const goldPath = join(goldDir, `${tag.id}.png`);
  let mineFile;
  let kind;
  if (isJpegBitmap(tag)) {
    kind = tag.mediaType === "image/jpeg" ? "jpeg" : "partial-jpeg";
    const bytes = mergeJpeg(tag.data, tag.mediaType === "image/x-swf-partial-jpeg" ? jpegTables : undefined);
    mineFile = join(outDir, `${tag.id}.mine.jpg`);
    writeFileSync(mineFile, bytes);
  } else {
    kind = tag.mediaType.replace("image/x-swf-", "");
    const img = await decodeLossless(tag);
    const png = new PNG({ width: img.width, height: img.height });
    png.data = Buffer.from(img.rgba);
    mineFile = join(outDir, `${tag.id}.mine.png`);
    writeFileSync(mineFile, PNG.sync.write(png));
  }
  items.push({ id: tag.id, kind, w: tag.width, h: tag.height, mineFile, goldPath, hasGold: existsSync(goldPath) });
}

// --- Browser stage: decode mine + gold, pixel-diff ------------------------
const browser = await chromium.launch();
const page = await browser.newPage();

let pass = 0;
let fail = 0;
let noGold = 0;
const rows = [];

for (const it of items) {
  if (!it.hasGold) {
    noGold++;
    rows.push({ id: it.id, status: "no-gold", note: it.kind });
    continue;
  }
  const mineUrl = dataUrl(it.mineFile);
  const goldUrl = dataUrl(it.goldPath);
  const res = await page.evaluate(diffInPage, { a: mineUrl, b: goldUrl });
  const ok = res.ok && res.diffPct <= 1.5;
  if (ok) pass++;
  else fail++;
  rows.push({
    id: it.id,
    status: ok ? "PASS" : "FAIL",
    note: `${res.aw}x${res.ah} vs ${res.bw}x${res.bh}  ${res.diffPct.toFixed(2)}% diff (meanΔ ${res.meanDelta.toFixed(2)}) ${it.kind}`,
  });
}

await browser.close();

rows.sort((a, b) => a.id - b.id);
for (const r of rows) console.log(`${String(r.id).padStart(4)}  ${r.status.padEnd(8)} ${r.note}`);
const comparable = pass + fail;
console.log(
  `\nscene=${scene}  bitmaps=${targets.length}  comparable=${comparable}  PASS=${pass}  FAIL=${fail}  no-gold=${noGold}` +
    (comparable ? `  (${((pass / comparable) * 100).toFixed(1)}% pixel match vs FFDec)` : ""),
);
console.log(`outputs in ${outDir}`);

function dataUrl(file) {
  const ext = file.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${ext};base64,${readFileSync(file).toString("base64")}`;
}

// Runs in the browser: decode both images and compare pixels.
async function diffInPage({ a, b }) {
  async function load(url) {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
  }
  const ia = await load(a);
  const ib = await load(b);
  const w = Math.min(ia.w, ib.w);
  const h = Math.min(ia.h, ib.h);
  let differing = 0;
  let total = 0;
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (ia.w * y + x) * 4;
      const j = (ib.w * y + x) * 4;
      const d = (Math.abs(ia.data[i] - ib.data[j]) + Math.abs(ia.data[i + 1] - ib.data[j + 1]) + Math.abs(ia.data[i + 2] - ib.data[j + 2])) / 3;
      sum += d;
      total++;
      if (d > 8) differing++;
    }
  }
  return {
    ok: ia.w === ib.w && ia.h === ib.h,
    aw: ia.w, ah: ia.h, bw: ib.w, bh: ib.h,
    diffPct: total ? (differing / total) * 100 : 100,
    meanDelta: total ? sum / total : 255,
  };
}
