// Build a faithful, runtime-ready shape bundle per scene: one gzipped JSON that
// inlines the scene's timeline plus every shape/sprite/button SVG verbatim
// (raw markup, so base64 pattern fills and gradients render exactly). External
// media (the standalone image PNGs, audio MP3, fonts) stays separate.
//
// Output (gitignored, like generated-packed/): public/generated-bundles/<scene>.json[.gz]
// Wired into the runtime via createTourPlayer({ assetSource: "bundle" }).
//
// Run: node scripts/build-shape-bundle.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const genDir = join(root, "public/generated");
const outDir = join(root, "public/generated-bundles");
mkdirSync(outDir, { recursive: true });

function collectSvgRefs(value, refs = new Set()) {
  if (typeof value === "string") {
    if (value.startsWith("generated/") && value.endsWith(".svg")) refs.add(value);
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSvgRefs(item, refs);
    return refs;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectSvgRefs(item, refs);
  }
  return refs;
}

const report = [];
for (const scene of readdirSync(genDir)) {
  const timelinePath = join(genDir, scene, "timeline.json");
  if (!existsSync(timelinePath)) continue;

  const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));
  const shapes = {};
  for (const ref of collectSvgRefs(timeline)) {
    const file = join(root, "public", ref);
    if (existsSync(file)) shapes[ref] = readFileSync(file, "utf8");
  }

  const bundle = { format: "mmtour-shape-bundle", version: 1, scene, timeline, shapes };
  const json = JSON.stringify(bundle);
  const gz = gzipSync(Buffer.from(json), { level: 9 });
  writeFileSync(join(outDir, `${scene}.json`), json);
  writeFileSync(join(outDir, `${scene}.json.gz`), gz);

  report.push({ scene, shapes: Object.keys(shapes).length, raw: json.length, gz: gz.length });
  console.log(`${scene}: ${Object.keys(shapes).length} shapes  raw ${(json.length / 1048576).toFixed(2)}MB  gz ${(gz.length / 1048576).toFixed(2)}MB`);
}

const totalGz = report.reduce((a, r) => a + r.gz, 0);
const totalRaw = report.reduce((a, r) => a + r.raw, 0);
console.log(`\nTOTAL: ${report.length} scenes  raw ${(totalRaw / 1048576).toFixed(1)}MB  gz ${(totalGz / 1048576).toFixed(1)}MB`);
