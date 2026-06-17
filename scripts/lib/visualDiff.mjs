// Pure screenshot-comparison helpers shared by the Ruffle verification scripts.
// No module state: plain functions over PNG buffers / file paths. The two render
// verifiers (frame-SVG vs Ruffle, and Decompiled Player vs Ruffle) both diff stage
// screenshots the same way, so the pixel math lives here once.

import { existsSync, readFileSync } from "node:fs";
import { PNG } from "pngjs";

/** Read a PNG file into a pngjs image. */
export function readPng(path) {
  return PNG.sync.read(readFileSync(path));
}

/**
 * Mean absolute per-channel difference between two images over their overlapping
 * region, after rejecting frames that are effectively blank (a blank Ruffle stage
 * — still loading — or a blank generated stage would otherwise read as "identical"
 * or "wildly different" and pollute the signal). Returns `{ status: "ok", ... }`
 * with `meanAbsoluteDifference` when both sides carry content, else `status:"skipped"`.
 */
export function diffImages(left, right) {
  const width = Math.min(left.width, right.width);
  const height = Math.min(left.height, right.height);
  if (width <= 0 || height <= 0) return { status: "skipped", reason: "empty image" };

  const leftBlank = imageBlankness(left, width, height);
  const rightBlank = imageBlankness(right, width, height);
  if (leftBlank.isBlank) return { status: "skipped", reason: "blank Ruffle reference", ruffleBlankness: leftBlank, generatedBlankness: rightBlank };
  if (rightBlank.isBlank) return { status: "skipped", reason: "blank generated output", ruffleBlankness: leftBlank, generatedBlankness: rightBlank };

  let total = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const li = (y * left.width + x) * 4;
      const ri = (y * right.width + x) * 4;
      total += Math.abs(left.data[li] - right.data[ri]);
      total += Math.abs(left.data[li + 1] - right.data[ri + 1]);
      total += Math.abs(left.data[li + 2] - right.data[ri + 2]);
    }
  }

  return {
    status: "ok",
    comparedWidth: width,
    comparedHeight: height,
    ruffleBlankness: leftBlank,
    generatedBlankness: rightBlank,
    meanAbsoluteDifference: total / (width * height * 3),
  };
}

/** File-path wrapper around {@link diffImages} — skips cleanly if either file is missing. */
export function compareScreenshotFiles(leftPath, rightPath) {
  if (!existsSync(leftPath) || !existsSync(rightPath)) return { status: "skipped", reason: "missing screenshot" };
  return diffImages(readPng(leftPath), readPng(rightPath));
}

/**
 * A frame is "blank" when its non-transparent pixels carry almost no colour
 * variance — i.e. a flat fill with nothing drawn (a stage that has not rendered
 * yet). Used to reject such frames from comparison.
 */
export function imageBlankness(image, width = image.width, height = image.height) {
  let maxDistance = 0;
  let nonTransparentPixels = 0;
  const sums = [0, 0, 0];
  const squaredSums = [0, 0, 0];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * image.width + x) * 4;
      if ((image.data[i + 3] ?? 255) < 8) continue;
      nonTransparentPixels += 1;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = image.data[i + channel] ?? 0;
        sums[channel] += value;
        squaredSums[channel] += value * value;
      }
    }
  }

  if (!nonTransparentPixels) return { isBlank: true, averageStandardDeviation: 0, maxDistance, nonTransparentPixels };

  const means = sums.map((sum) => sum / nonTransparentPixels);
  const standardDeviations = squaredSums.map((sum, channel) =>
    Math.sqrt(Math.max(0, sum / nonTransparentPixels - means[channel] * means[channel])),
  );
  const averageStandardDeviation = standardDeviations.reduce((total, value) => total + value, 0) / standardDeviations.length;
  maxDistance = Math.max(...standardDeviations);

  return { isBlank: averageStandardDeviation < 3, averageStandardDeviation, maxDistance, nonTransparentPixels };
}
