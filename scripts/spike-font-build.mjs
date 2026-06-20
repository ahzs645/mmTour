// Spike test: build a TTF from each DefineFont with the pure-TS font builder
// (src/convert/fontBuilder) and validate against FFDec's golden .ttf by RENDERING.
//
//   node scripts/spike-font-build.mjs [scene] [id ...]
//
// Both fonts are loaded via FontFace in Chrome and used to render the same text;
// the pixel diff cancels antialiasing (same rasterizer both sides), so any
// difference is a real glyph-outline or advance-width mismatch.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSwf } from "swf-parser";
import { chromium } from "playwright";
import { collectFonts, buildTtf } from "../src/convert/index.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const scene = process.argv[2] ?? "segment4";
const onlyIds = process.argv.slice(3).map(Number);

const swfPath = join(root, "public", `${scene}.swf`);
const fontDir = join(root, "public/generated", scene, "fonts");
const outDir = join(root, "verification/spike-font", scene);
if (!existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);
mkdirSync(outDir, { recursive: true });

const goldById = new Map();
if (existsSync(fontDir)) {
  for (const f of readdirSync(fontDir)) {
    const m = f.match(/^(\d+)_/);
    if (m && f.endsWith(".ttf")) goldById.set(Number(m[1]), join(fontDir, f));
  }
}

const movie = parseSwf(new Uint8Array(readFileSync(swfPath)));
const fonts = collectFonts(movie);
const targets = onlyIds.length ? fonts.filter((f) => onlyIds.includes(f.id)) : fonts;

const SAMPLE = "The quick brown fox JUMPS 0123456789 — Windows XP! @#$%&?";

const items = [];
for (const font of targets) {
  const ttf = buildTtf(font);
  const mineFile = join(outDir, `${font.id}.mine.ttf`);
  writeFileSync(mineFile, ttf);
  items.push({ id: font.id, name: font.fontName, mineFile, gold: goldById.get(font.id), glyphs: font.glyphs.length });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 200 } });

let pass = 0, fail = 0, noGold = 0;
const rows = [];
for (const it of items) {
  if (!it.gold) {
    noGold++;
    rows.push({ id: it.id, status: "no-gold", note: `${it.name} (${it.glyphs} glyphs)` });
    continue;
  }
  const res = await page.evaluate(renderDiff, {
    mine: b64(it.mineFile),
    gold: b64(it.gold),
    text: SAMPLE,
  });
  const ok = res.diffPct <= 0.5;
  if (ok) pass++; else fail++;
  rows.push({ id: it.id, status: ok ? "PASS" : "FAIL", note: `${res.diffPct.toFixed(3)}% diff (meanΔ ${res.meanDelta.toFixed(2)})  ${it.name}` });
}
await browser.close();

rows.sort((a, b) => a.id - b.id);
for (const r of rows) console.log(`${String(r.id).padStart(4)}  ${r.status.padEnd(8)} ${r.note}`);
const comparable = pass + fail;
console.log(
  `\nscene=${scene}  fonts=${targets.length}  comparable=${comparable}  PASS=${pass}  FAIL=${fail}  no-gold=${noGold}` +
    (comparable ? `  (${((pass / comparable) * 100).toFixed(1)}% render match vs FFDec)` : ""),
);
console.log(`TTFs written to ${outDir}`);

function b64(file) {
  return readFileSync(file).toString("base64");
}

async function renderDiff({ mine, gold, text }) {
  function snapshot(data) {
    const arr = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return arr;
  }
  async function rasterize(family, bytes) {
    const face = new FontFace(family, bytes);
    await face.load();
    document.fonts.add(face);
    const c = new OffscreenCanvas(1400, 120);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#000";
    ctx.font = `64px "${family}"`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, 8, 84);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  }
  const a = await rasterize("mineFont", snapshot(mine).buffer);
  const b = await rasterize("ffdecFont", snapshot(gold).buffer);
  let differing = 0, sum = 0, total = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    sum += d;
    if (d > 24) differing++;
  }
  return { diffPct: (differing / total) * 100, meanDelta: sum / total };
}
