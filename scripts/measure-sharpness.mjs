// Sharpness / luminance / contrast metric for the "washed out vs Ruffle"
// investigation (docs/image-sharpness-vs-ruffle.md). The earlier numbers in that
// doc came from throwaway scripts; this commits the metric so any A/B is
// repeatable — e.g. baseline vs `?sharpen=…`, or our render vs the source asset.
//
// Usage (run from the repo root so `pngjs` resolves):
//   node scripts/measure-sharpness.mjs <image.png>            # one image
//   node scripts/measure-sharpness.mjs <a.png> <b.png>        # A/B + ratio
//
// The "sharpness" number is the mean absolute luminance gradient (horizontal +
// vertical neighbour differences) over opaque pixels — a high-frequency-energy
// proxy. It is a per-pixel mean, so the ratio is meaningful even when the two
// images differ in size (e.g. a dpr=2 capture vs dpr=1). Higher = crisper.

import { readPng } from "./lib/visualDiff.mjs";

const REC709 = [0.2126, 0.7152, 0.0722];

/** Per-channel mean/stdev (contrast) and mean luminance over opaque pixels. */
function colorStats(img) {
  const sums = [0, 0, 0];
  const sq = [0, 0, 0];
  let lumSum = 0;
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if ((img.data[i + 3] ?? 255) < 8) continue;
    n += 1;
    let lum = 0;
    for (let c = 0; c < 3; c += 1) {
      const v = img.data[i + c] ?? 0;
      sums[c] += v;
      sq[c] += v * v;
      lum += v * REC709[c];
    }
    lumSum += lum;
  }
  if (!n) return { opaquePixels: 0, meanLuminance: 0, channelMean: [0, 0, 0], channelStdev: [0, 0, 0] };
  const mean = sums.map((s) => s / n);
  const stdev = sq.map((s, c) => Math.sqrt(Math.max(0, s / n - mean[c] * mean[c])));
  return { opaquePixels: n, meanLuminance: lumSum / n, channelMean: mean, channelStdev: stdev };
}

/** Mean absolute luminance gradient (right + down neighbour) over opaque pixels. */
function sharpness(img) {
  const { width, height, data } = img;
  const lum = (i) => data[i] * REC709[0] + data[i + 1] * REC709[1] + data[i + 2] * REC709[2];
  let total = 0;
  let n = 0;
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const i = (y * width + x) * 4;
      if ((data[i + 3] ?? 255) < 8) continue;
      const right = i + 4;
      const down = i + width * 4;
      total += Math.abs(lum(i) - lum(right)) + Math.abs(lum(i) - lum(down));
      n += 1;
    }
  }
  return n ? total / n : 0;
}

function describe(path) {
  const img = readPng(path);
  const c = colorStats(img);
  const s = sharpness(img);
  const fmt = (a) => `[${a.map((v) => v.toFixed(1)).join(", ")}]`;
  console.log(`\n${path}  (${img.width}×${img.height}, ${c.opaquePixels} opaque px)`);
  console.log(`  mean luminance : ${c.meanLuminance.toFixed(2)}`);
  console.log(`  channel mean   : ${fmt(c.channelMean)}`);
  console.log(`  channel stdev  : ${fmt(c.channelStdev)}  (contrast)`);
  console.log(`  sharpness      : ${s.toFixed(4)}  (mean |∇luma|)`);
  return { path, sharpness: s, ...c };
}

const [a, b] = process.argv.slice(2);
if (!a) {
  console.error("usage: node scripts/measure-sharpness.mjs <image.png> [other.png]");
  process.exit(1);
}

const left = describe(a);
if (b) {
  const right = describe(b);
  const ratio = left.sharpness ? right.sharpness / left.sharpness : 0;
  console.log(`\nsharpness ratio  B / A = ${ratio.toFixed(4)}  (1.0 = equal; >1 means B is crisper)`);
  console.log(`mean-luminance Δ  B − A = ${(right.meanLuminance - left.meanLuminance).toFixed(2)}`);
}
console.log();
