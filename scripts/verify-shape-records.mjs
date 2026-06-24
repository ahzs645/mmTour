#!/usr/bin/env node
// Phase 4 parity gate for compact shape records (docs/generated-size-and-packing.md):
// for every DefineShape in every bundled SWF, reconstructing the shape from its
// `shapeToRecord` record via `shapeRecordToSvg` must produce a byte-identical SVG to
// the emitter's `defineShapeToSvg`. Byte-identity is stronger than a pixel diff: equal
// strings render identically, and it keeps the DomRenderer mask regex working.
//
// Also reports the record vs SVG size (raw + gzip + brotli) so the Phase 2 win is
// measured against a stable baseline. Bitmap fills use a deterministic stub resolver
// (the actual image is referenced/inlined separately, Phase 1), so equality does not
// depend on decoding bitmaps.

import { readFileSync } from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { parseSwf, swf } from "swf-parser";
import { defineShapeToSvg } from "../src/convert/svgEmit.ts";
import { shapeToRecord } from "../src/convert/shapeRecord.ts";
import { shapeRecordToSvg } from "../src/render/shapeRecordToSvg.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const scenes = process.argv.slice(2).length
  ? process.argv.slice(2).map((s) => s.replace(/\.swf$/i, ""))
  : ["A-tour", "intro", "nav", "segment1", "segment2", "segment3", "segment4", "segment5"];

// Deterministic bitmap resolver: identical for both renders, so byte-equality tests the
// record's geometry/style fidelity, not bitmap bytes.
const bitmapFill = (id) => ({ width: 120, height: 80, ref: `generated/images/${id}.png` });

const br = (b) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 8 } }).length;
let totalShapes = 0;
let mismatches = 0;
let svgRaw = 0;
let recordRaw = 0;
const svgParts = [];
const recordParts = [];
const failures = [];

for (const scene of scenes) {
  const bytes = new Uint8Array(readFileSync(join(root, "public", `${scene}.swf`)));
  const movie = parseSwf(bytes);
  let sceneShapes = 0;
  let sceneMismatch = 0;
  for (const tag of movie.tags) {
    if (tag.type !== swf.TagType.DefineShape) continue;
    sceneShapes += 1;
    totalShapes += 1;
    let expected;
    try {
      expected = defineShapeToSvg(tag, { bitmapFill }).svg;
    } catch (error) {
      failures.push(`${scene} shape ${tag.id}: emitter threw ${error.message}`);
      continue;
    }
    const record = shapeToRecord(tag);
    const actual = shapeRecordToSvg(record, { bitmapFill });
    if (actual !== expected) {
      sceneMismatch += 1;
      mismatches += 1;
      if (failures.length < 6) failures.push(`${scene} shape ${tag.id}: record SVG != emitter SVG\n  expected: ${snippet(expected, actual)}\n  actual:   ${snippet(actual, expected)}`);
    }
    const recordJson = JSON.stringify(record);
    svgRaw += Buffer.byteLength(expected);
    recordRaw += Buffer.byteLength(recordJson);
    svgParts.push(expected);
    recordParts.push(recordJson);
  }
  console.log(`${scene}: ${sceneShapes} shapes, ${sceneMismatch} mismatch${sceneMismatch === 1 ? "" : "es"}`);
}

const svgBuf = Buffer.from(svgParts.join("\n"));
const recordBuf = Buffer.from(`[${recordParts.join(",")}]`);
console.log(`\nshapes: ${totalShapes}, mismatches: ${mismatches}`);
console.log("size (verbose emitter SVG, no minify):");
console.log(`  svg     raw ${mib(svgRaw)}  gzip ${mib(gzipSync(svgBuf, { level: 9 }).length)}  brotli ${mib(br(svgBuf))}`);
console.log(`  record  raw ${mib(recordRaw)}  gzip ${mib(gzipSync(recordBuf, { level: 9 }).length)}  brotli ${mib(br(recordBuf))}`);

if (failures.length) {
  console.error("\nFAIL:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("\nOK — every shape record reconstructs byte-identical SVG.");

function mib(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MiB`;
}

function snippet(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `…${a.slice(Math.max(0, i - 20), i + 40)}…`;
}
