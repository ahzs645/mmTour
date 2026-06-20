// Spike test: extract every DefineSound with the pure-TS sound extractor
// (src/convert/soundExtractor) and byte-compare against FFDec's golden file
// (public/generated/<scene>/sounds/<id>_<name>.mp3 | .wav).
//
//   node scripts/spike-sound-extract.mjs [scene] [id ...]
//
// MP3 extraction is lossless (strip the 2-byte seek, keep the frames), so the
// bytes must match FFDec exactly.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSwf } from "swf-parser";
import { collectSounds, extractSound } from "../src/convert/index.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const scene = process.argv[2] ?? "intro";
const onlyIds = process.argv.slice(3).map(Number);

const swfPath = join(root, "public", `${scene}.swf`);
const soundDir = join(root, "public/generated", scene, "sounds");
const outDir = join(root, "verification/spike-sound", scene);
if (!existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);
mkdirSync(outDir, { recursive: true });

const goldById = new Map();
if (existsSync(soundDir)) {
  for (const f of readdirSync(soundDir)) {
    const m = f.match(/^(-?\d+)[_.]/);
    if (m) goldById.set(Number(m[1]), join(soundDir, f));
  }
}

const movie = parseSwf(new Uint8Array(readFileSync(swfPath)));
const sounds = collectSounds(movie);
const targets = onlyIds.length ? sounds.filter((s) => onlyIds.includes(s.id)) : sounds;

let pass = 0, fail = 0, noGold = 0;
const rows = [];
for (const tag of targets) {
  const s = extractSound(tag);
  const mineFile = join(outDir, `${tag.id}.mine.${s.ext}`);
  writeFileSync(mineFile, s.bytes);

  const gold = goldById.get(tag.id);
  if (!gold) {
    noGold++;
    rows.push({ id: tag.id, status: "no-gold", note: `fmt${tag.format} ${s.ext}` });
    continue;
  }
  const goldBytes = new Uint8Array(readFileSync(gold));
  const same = goldBytes.length === s.bytes.length && goldBytes.every((b, i) => b === s.bytes[i]);
  const firstDiff = same ? -1 : goldBytes.findIndex((b, i) => b !== s.bytes[i]);
  if (same) pass++; else fail++;
  rows.push({
    id: tag.id,
    status: same ? "PASS" : "FAIL",
    note: same
      ? `${s.bytes.length} bytes exact (${s.ext})`
      : `mine ${s.bytes.length} vs gold ${goldBytes.length} bytes, first diff @${firstDiff} (${s.ext})`,
  });
}

rows.sort((a, b) => a.id - b.id);
for (const r of rows) console.log(`${String(r.id).padStart(4)}  ${r.status.padEnd(8)} ${r.note}`);
const comparable = pass + fail;
console.log(
  `\nscene=${scene}  sounds=${targets.length}  comparable=${comparable}  PASS=${pass}  FAIL=${fail}  no-gold=${noGold}` +
    (comparable ? `  (${((pass / comparable) * 100).toFixed(1)}% byte-exact vs FFDec)` : ""),
);
console.log(`outputs in ${outDir}`);
