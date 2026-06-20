// Spike test: compose every DefineButton's state SVGs with the pure-TS button
// compositor (src/convert/buttonComposer) and pixel-diff against FFDec's golden
// public/generated/<scene>/buttons/DefineButton2_<id>/<state>.svg.
//
//   node scripts/spike-button-compose.mjs [scene] [id ...]
//
// Renders mine + golden via Playwright and compares pixels. Buttons whose shapes
// use bitmap fills inherit the shape converter's known bitmap gap (flagged).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSwf, swf } from "swf-parser";
import { chromium } from "playwright";
import { collectButtons, composeButton } from "../src/convert/index.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const scene = process.argv[2] ?? "nav";
const onlyIds = process.argv.slice(3).map(Number);

const swfPath = join(root, "public", `${scene}.swf`);
const goldDir = join(root, "public/generated", scene, "buttons");
const outDir = join(root, "verification/spike-button", scene);
if (!existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);
mkdirSync(outDir, { recursive: true });

const movie = parseSwf(new Uint8Array(readFileSync(swfPath)));
const shapesById = new Map();
for (const t of movie.tags) if (t.type === swf.TagType.DefineShape) shapesById.set(t.id, t);
const buttons = collectButtons(movie);
const targets = onlyIds.length ? buttons.filter((b) => onlyIds.includes(b.id)) : buttons;

const STATE_KEY = { "1_up": "stateUp", "2_over": "stateOver", "3_down": "stateDown", "4_hittest": "stateHitTest" };

const browser = await chromium.launch();
const page = await browser.newPage();

let pass = 0, fail = 0, bitmap = 0, overlay = 0, noGold = 0;
const rows = [];
for (const button of targets) {
  const composed = composeButton(button, (id) => shapesById.get(id));
  for (const [stateFile, svg] of Object.entries(composed.states)) {
    const goldPath = join(goldDir, composed.dir, `${stateFile}.svg`);
    if (!existsSync(goldPath)) { noGold++; continue; }
    const mineFile = join(outDir, `${composed.id}_${stateFile}.mine.svg`);
    writeFileSync(mineFile, svg);
    const res = await page.evaluate(diffSvgs, { a: dataUrl(svg), b: dataUrl(readFileSync(goldPath, "utf8")) });
    if (res.empty) continue; // both render nothing — skip

    // classify: a state with ANY non-shape record (editText/sprite) is drawn by
    // the runtime overlay (the pipeline strips baked button text), so the SVG is
    // shape-only by design; a bitmap-fill shape inherits the converter's bitmap
    // gap. Only pure-shape, no-bitmap states are graded strictly against FFDec.
    const stateRecords = button.records.filter((r) => r[STATE_KEY[stateFile]]);
    const hasNonShape = stateRecords.some((r) => !shapesById.has(r.characterId));
    const mineBitmap = /data-bitmap-fill/.test(svg);
    let cat, status;
    if (hasNonShape) { cat = "overlay"; overlay++; status = "OVERLAY"; }
    else if (mineBitmap) { cat = "bitmap"; bitmap++; status = "BITMAP"; }
    else { cat = "vector"; const ok = res.diffPct <= 2; if (ok) pass++; else fail++; status = ok ? "PASS" : "FAIL"; }
    rows.push({ key: `${composed.id}/${stateFile}`, status, note: `${res.diffPct.toFixed(2)}% diff ${res.w}x${res.h}${cat !== "vector" ? ` [${cat}: runtime/bitmap gap]` : ""}` });
  }
}
await browser.close();

rows.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
for (const r of rows) console.log(`${r.key.padEnd(12)} ${r.status.padEnd(8)} ${r.note}`);
const comparable = pass + fail;
console.log(
  `\nscene=${scene}  buttons=${targets.length}  vector-states ${pass}/${comparable} PASS` +
    `  ·  bitmap-shape=${bitmap} (known gap)  ·  editText-overlay=${overlay} (runtime draws)  ·  no-gold=${noGold}` +
    (comparable ? `  → ${((pass / comparable) * 100).toFixed(1)}% vector match vs FFDec` : ""),
);
console.log(`outputs in ${outDir}`);

function dataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

async function diffSvgs({ a, b }) {
  async function render(url) {
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const natW = img.naturalWidth || img.width, natH = img.naturalHeight || img.height;
      if (natW < 1 || natH < 1) return null;
      // scale up so antialiasing is a fair (small) fraction, like the shape diff
      const scale = 300 / Math.max(natW, natH);
      const W = Math.max(1, Math.round(natW * scale)), H = Math.max(1, Math.round(natH * scale));
      if (W <= 1 && H <= 1) return null;
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const x = c.getContext("2d");
      x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
      x.drawImage(img, 0, 0, W, H);
      return { W, H, data: x.getImageData(0, 0, W, H).data };
    } catch {
      return null;
    }
  }
  function ink(img) {
    if (!img) return 0;
    let n = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 250 || img.data[i + 1] < 250 || img.data[i + 2] < 250) n++;
    return n / (img.data.length / 4);
  }
  const ia = await render(a), ib = await render(b);
  // FFDec emits empty-but-sized SVGs for stateless buttons (e.g. a hit-only up
  // state). Treat a blank gold as an empty match for mine's (also blank) output.
  const blank = (img) => !img || ink(img) < 0.005;
  if (blank(ib)) return { diffPct: blank(ia) ? 0 : 100, w: 0, h: 0, empty: blank(ia) };
  if (!ia) return { diffPct: 100, w: 0, h: 0 };
  const W = Math.min(ia.W, ib.W), H = Math.min(ia.H, ib.H);
  let diff = 0, total = 0;
  for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
    const i = (ia.W * y + xx) * 4, j = (ib.W * y + xx) * 4;
    const dd = (Math.abs(ia.data[i] - ib.data[j]) + Math.abs(ia.data[i + 1] - ib.data[j + 1]) + Math.abs(ia.data[i + 2] - ib.data[j + 2])) / 3;
    if (dd > 16) diff++;
    total++;
  }
  return { diffPct: total ? (diff / total) * 100 : 100, w: ia.W, h: ia.H };
}
