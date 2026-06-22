// Spike test: convert every DefineShape in a SWF to SVG with the pure-TS
// converter (src/convert) and diff it geometrically against FFDec's committed
// golden SVG (public/generated/<scene>/shapes/<id>.svg).
//
//   node scripts/spike-shape-to-svg.mjs [scene] [id ...]
//
// Geometry is compared order-independently (FFDec and we may start a contour at
// a different vertex / wind the other way): we extract every coordinate pair
// from each <path d>, round, and compare as a multiset (Jaccard), plus the SVG
// box size and the set of solid fill colors. Writes side-by-side SVGs under
// verification/spike/<scene>/ for eyeballing.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseSwf } from "swf-parser";
import { PNG } from "pngjs";
import { collectShapes, defineShapeToSvg, collectBitmaps, isJpegBitmap, mergeJpeg, decodeLossless } from "../src/convert/index.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const scene = process.argv[2] ?? "intro";
const onlyIds = process.argv.slice(3).map(Number);

const swfPath = join(root, "public", `${scene}.swf`);
const goldDir = join(root, "public/generated", scene, "shapes");
const outDir = join(root, "verification/spike", scene);
if (!existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);
mkdirSync(outDir, { recursive: true });

const swfBytes = new Uint8Array(readFileSync(swfPath));
const movie = parseSwf(swfBytes);
const bitmapFill = await bitmapFillResolver(movie);
const { shapes } = collectShapes(swfBytes);
const targets = onlyIds.length ? shapes.filter((s) => onlyIds.includes(s.id)) : shapes;

let pass = 0;
let fail = 0;
let noGold = 0;
const fillTypeTally = new Map();
const rows = [];

for (const { id, tag } of targets) {
  const { svg, fillTypes, unsupported } = defineShapeToSvg(tag, { bitmapFill });
  for (const t of fillTypes) fillTypeTally.set(t, (fillTypeTally.get(t) ?? 0) + 1);
  writeFileSync(join(outDir, `${id}.mine.svg`), svg);

  const goldPath = join(goldDir, `${id}.svg`);
  if (!existsSync(goldPath)) {
    noGold++;
    rows.push({ id, status: "no-gold", note: fillTypes.join("+") || "empty" });
    continue;
  }
  const gold = readFileSync(goldPath, "utf8");
  writeFileSync(join(outDir, `${id}.ffdec.svg`), gold);

  const cmp = compare(svg, gold);
  const ok = cmp.boxOk && cmp.jaccard >= 0.98 && cmp.colorsOk;
  if (ok) pass++;
  else fail++;
  rows.push({
    id,
    status: ok ? "PASS" : "FAIL",
    note: `pts ${cmp.minePts}/${cmp.goldPts} jac ${cmp.jaccard.toFixed(3)} box[${cmp.boxOk ? "=" : "≠"}] col[${cmp.colorsOk ? "=" : "≠"}] ${fillTypes.join("+") || "empty"}${unsupported.length ? " *" + unsupported.join(",") : ""}`,
  });
}

rows.sort((a, b) => a.id - b.id);
for (const r of rows) console.log(`${String(r.id).padStart(4)}  ${r.status.padEnd(8)} ${r.note}`);

console.log("\n— fill coverage —");
for (const [t, n] of [...fillTypeTally].sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${n}`);

const comparable = pass + fail;
console.log(
  `\nscene=${scene}  shapes=${targets.length}  comparable=${comparable}  ` +
    `PASS=${pass}  FAIL=${fail}  no-gold=${noGold}` +
    (comparable ? `  (${((pass / comparable) * 100).toFixed(1)}% geometric match vs FFDec)` : ""),
);
console.log(`SVGs written to ${outDir}`);

async function bitmapFillResolver(movie) {
  const { bitmaps, jpegTables } = collectBitmaps(movie);
  const images = new Map();
  for (const tag of bitmaps) {
    if (isJpegBitmap(tag)) {
      const bytes = mergeJpeg(tag.data, tag.mediaType === "image/x-swf-partial-jpeg" ? jpegTables : undefined);
      images.set(Number(tag.id), { width: Number(tag.width) || 0, height: Number(tag.height) || 0, href: dataUrl("image/jpeg", bytes) });
      continue;
    }
    const img = await decodeLossless(tag);
    const png = new PNG({ width: img.width, height: img.height });
    png.data = Buffer.from(img.rgba);
    images.set(Number(tag.id), { width: img.width, height: img.height, href: dataUrl("image/png", PNG.sync.write(png)) });
  }
  return (id) => images.get(id);
}

function dataUrl(mime, bytes) {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Extract coord pairs from all <path d="..."> in an SVG, per subpath, with the
 *  explicit closing vertex (last == first) dropped so a contour started at a
 *  different vertex / wound the other way still compares equal. */
function pathPoints(svg) {
  const pts = [];
  for (const m of svg.matchAll(/\bd="([^"]*)"/g)) {
    for (const sub of m[1].split(/(?=M)/)) {
      const nums = (sub.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      const sp = [];
      for (let i = 0; i + 1 < nums.length; i += 2) sp.push([nums[i], nums[i + 1]]);
      if (sp.length > 1 && sp[0][0] === sp[sp.length - 1][0] && sp[0][1] === sp[sp.length - 1][1]) sp.pop();
      pts.push(...sp);
    }
  }
  return pts;
}

function bbox(pts) {
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function solidColors(svg) {
  return new Set([...svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase()));
}

function compare(mine, gold) {
  const a = pathPoints(mine);
  const b = pathPoints(gold);
  const key = ([x, y]) => `${Math.round(x * 10) / 10}_${Math.round(y * 10) / 10}`;
  const bagA = new Map();
  const bagB = new Map();
  for (const p of a) bagA.set(key(p), (bagA.get(key(p)) ?? 0) + 1);
  for (const p of b) bagB.set(key(p), (bagB.get(key(p)) ?? 0) + 1);
  let inter = 0;
  let union = 0;
  for (const k of new Set([...bagA.keys(), ...bagB.keys()])) {
    const na = bagA.get(k) ?? 0;
    const nb = bagB.get(k) ?? 0;
    inter += Math.min(na, nb);
    union += Math.max(na, nb);
  }
  const jaccard = union === 0 ? 1 : inter / union;

  const ba = bbox(a);
  const bg = bbox(b);
  const boxOk = (!ba && !bg) || (ba && bg && ba.every((v, i) => Math.abs(v - bg[i]) <= 0.1));

  const ca = solidColors(mine);
  const cg = solidColors(gold);
  // Gradients differ in representation; only require solid colors to match when both have them.
  const colorsOk = cg.size === 0 || [...cg].every((c) => ca.has(c));

  return { jaccard, boxOk: Boolean(boxOk), colorsOk, minePts: a.length, goldPts: b.length };
}
