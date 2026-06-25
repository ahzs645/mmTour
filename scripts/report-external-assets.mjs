#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const scene = process.argv[2];
if (!scene) {
  console.error("usage: node scripts/report-external-assets.mjs <scene>");
  process.exit(1);
}

const publicDir = new URL("../public/", import.meta.url);
const generatedDir = new URL(`../public/generated/${scene}/`, import.meta.url);

const textSources = [];
for (const candidate of [
  new URL(`xml/${scene}_en.xml`, publicDir),
  new URL(`xml/${scene}.xml`, publicDir),
  new URL("control-flow.json", generatedDir),
]) {
  if (existsSync(candidate)) textSources.push({ path: candidate, text: readFileSync(candidate, "utf8") });
}

const assetPattern = /(?:src|href|value|rawValue|arguments)"?\s*[:=]\s*"?([^"'<>\s]+\.(?:swf|png|jpe?g|gif|webp|mp3|wav))/gi;
const quotedPattern = /["']([^"']+\.(?:swf|png|jpe?g|gif|webp|mp3|wav))["']/gi;
const refs = new Map();

for (const source of textSources) {
  for (const pattern of [assetPattern, quotedPattern]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source.text))) {
      const normalized = normalizeAssetRef(match[1]);
      if (!normalized) continue;
      const entry = refs.get(normalized) ?? { ref: normalized, sources: new Set() };
      entry.sources.add(source.path.pathname.replace(process.cwd(), "."));
      refs.set(normalized, entry);
    }
  }
}

const rows = [...refs.values()]
  .map((entry) => {
    const localPath = join(publicDir.pathname, entry.ref);
    return {
      ref: entry.ref,
      present: existsSync(localPath),
      sources: [...entry.sources].sort(),
    };
  })
  .sort((a, b) => Number(a.present) - Number(b.present) || a.ref.localeCompare(b.ref));

const missing = rows.filter((row) => !row.present);
const present = rows.filter((row) => row.present);

console.log(`${scene}`);
console.log(`  external asset refs: ${rows.length}`);
console.log(`  present under public/: ${present.length}`);
console.log(`  missing under public/: ${missing.length}`);

if (missing.length) {
  console.log("\nmissing:");
  for (const row of missing) console.log(`  - ${row.ref}`);
}

if (present.length) {
  console.log("\npresent:");
  for (const row of present) console.log(`  - ${row.ref}`);
}

function normalizeAssetRef(ref) {
  const clean = String(ref ?? "")
    .trim()
    .replace(/\\\//g, "/")
    .replace(/^https?:\/\/[^/]+\//i, "")
    .replace(/^\/+/, "");
  if (!clean || clean.startsWith("public/") || clean.startsWith("generated/")) return "";
  return clean;
}
