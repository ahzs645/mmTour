// Embedded-font family helpers for the comparison render modes' extracted text.

import type { TimelineAsset } from "./frameModeTypes";

export function fontFamiliesForAsset(asset: TimelineAsset) {
  const fileName = asset.src?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  const familyFromFile = fileName.replace(/^\d+_/, "").replace(/_/g, " ").trim();
  return [...new Set([
    familyFromFile,
    familyFromFile.replace(/\s+/g, ""),
    "Franklin Gothic Medium",
    "Franklin Gothic",
    "FranklinGothic",
    "XP Franklin Gothic",
  ].filter(Boolean))];
}

export function extractedFontFamilyStack() {
  return [
    '"Franklin Gothic Medium"',
    '"Franklin Gothic"',
    '"FranklinGothic"',
    '"XP Franklin Gothic"',
    '"Arial Narrow"',
    "Arial",
    "sans-serif",
  ].join(", ");
}
