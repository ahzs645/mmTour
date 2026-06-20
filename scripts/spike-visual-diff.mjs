// Pixel-level check: render the spike's SVG and FFDec's golden SVG for the same
// shape and report how many pixels differ. This is what the geometric diff can't
// see — whether reimplemented gradient paint actually lands on the same colors.
//
//   node scripts/spike-visual-diff.mjs [scene] [id ...]
//
// Needs the side-by-side SVGs from spike-shape-to-svg.mjs first.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const scene = process.argv[2] ?? "intro";
const ids = process.argv.slice(3).map(Number);
const dir = join(root, "verification/spike", scene);
const TARGET = 400; // longest side, px

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

for (const id of ids) {
  const minePath = join(dir, `${id}.mine.svg`);
  const goldPath = join(dir, `${id}.ffdec.svg`);
  if (!existsSync(minePath) || !existsSync(goldPath)) {
    console.log(`${String(id).padStart(4)}  skip (missing svg)`);
    continue;
  }
  const a = await render(readFileSync(minePath, "utf8"));
  const b = await render(readFileSync(goldPath, "utf8"));
  const res = diff(a, b);
  console.log(
    `${String(id).padStart(4)}  ${res.diffPct <= 1 ? "MATCH" : "DIFF "}  ` +
      `${res.diffPct.toFixed(2)}% pixels differ  (meanΔ ${res.meanDelta.toFixed(2)}/255)  ${a.width}x${a.height}`,
  );
  if (res.png) writeFileSync(join(dir, `${id}.diff.png`), PNG.sync.write(res.png));
}

await browser.close();

/** Inject a viewBox so width/height scaling is uniform, then screenshot. */
async function render(svg) {
  const wm = svg.match(/width="([\d.]+)px"/);
  const hm = svg.match(/height="([\d.]+)px"/);
  const w = wm ? Number(wm[1]) : TARGET;
  const h = hm ? Number(hm[1]) : TARGET;
  const scale = TARGET / Math.max(w, h);
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  const withViewBox = svg.replace(
    /<svg /,
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" `,
  );
  const sized = withViewBox
    .replace(/width="[\d.]+px"/, `width="${sw}"`)
    .replace(/height="[\d.]+px"/, `height="${sh}"`);
  await page.setViewportSize({ width: sw, height: sh });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:#fff">${sized}</body></html>`,
  );
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: sw, height: sh } });
  return PNG.sync.read(buf);
}

function diff(a, b) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const out = new PNG({ width: w, height: h });
  let differing = 0;
  let total = 0;
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (a.width * y + x) * 4;
      const ib = (b.width * y + x) * 4;
      const io = (w * y + x) * 4;
      const dr = Math.abs(a.data[ia] - b.data[ib]);
      const dg = Math.abs(a.data[ia + 1] - b.data[ib + 1]);
      const db = Math.abs(a.data[ia + 2] - b.data[ib + 2]);
      const d = (dr + dg + db) / 3;
      sum += d;
      total++;
      const hit = d > (Number(process.env.THRESH) || 12);
      if (hit) differing++;
      out.data[io] = hit ? 255 : 0;
      out.data[io + 1] = hit ? 0 : Math.round(a.data[ia + 1] * 0.4);
      out.data[io + 2] = 0;
      out.data[io + 3] = 255;
    }
  }
  return { diffPct: (differing / total) * 100, meanDelta: sum / total, png: out };
}
