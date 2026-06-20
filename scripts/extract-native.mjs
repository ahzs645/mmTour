// Java-free replacement for export-ffdec.mjs. Parses each SWF with swf-parser and
// runs the pure-TS converters (src/convert) to populate extracted/<scene>/ with
// the same asset layout FFDec produces — shapes/ images/ fonts/ sounds/ buttons/
// texts/ — so `NATIVE_PARSE=1 build-asset-timeline` + build-control-flow build the
// whole scene with no Java.
//
//   node scripts/extract-native.mjs [scene ...]
//
// Asset fidelity vs FFDec is validated per-type by the spike-* scripts (shapes
// 409/409, images 192/192, fonts 16/16, sounds 152/152, buttons 100% vector).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSwf, swf } from "swf-parser";
import { PNG } from "pngjs";
import {
  collectShapes, defineShapeToSvg,
  collectBitmaps, isJpegBitmap, mergeJpeg, decodeLossless,
  collectFonts, buildTtf,
  collectSounds, extractSound,
  collectButtons, composeButton,
  collectStaticTexts, fontsById, reconstructText,
} from "../src/convert/index.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const scenes = process.argv.slice(2).length
  ? process.argv.slice(2).map((s) => s.replace(/\.swf$/, ""))
  : ["A-tour", "intro", "nav", "segment1", "segment2", "segment3", "segment4", "segment5"];

for (const scene of scenes) {
  const swfPath = ["", "public/"].map((p) => join(root, p, `${scene}.swf`)).find((p) => existsSync(p));
  if (!swfPath) throw new Error(`No ${scene}.swf found`);
  const outDir = join(root, "extracted", scene);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const movie = parseSwf(new Uint8Array(readFileSync(swfPath)));
  const counts = { shapes: 0, images: 0, fonts: 0, sounds: 0, buttons: 0, texts: 0 };

  // --- shapes ---
  const dir = (name) => { const d = join(outDir, name); mkdirSync(d, { recursive: true }); return d; };
  for (const { id, tag } of collectShapes(new Uint8Array(readFileSync(swfPath))).shapes) {
    writeFileSync(join(dir("shapes"), `${id}.svg`), defineShapeToSvg(tag).svg);
    counts.shapes++;
  }

  // --- images (native format: lossless→png, jpeg→jpg) ---
  const { bitmaps, jpegTables } = collectBitmaps(movie);
  for (const tag of bitmaps) {
    if (isJpegBitmap(tag)) {
      const bytes = mergeJpeg(tag.data, tag.mediaType === "image/x-swf-partial-jpeg" ? jpegTables : undefined);
      writeFileSync(join(dir("images"), `${tag.id}.jpg`), bytes);
    } else {
      const img = await decodeLossless(tag);
      const png = new PNG({ width: img.width, height: img.height });
      png.data = Buffer.from(img.rgba);
      writeFileSync(join(dir("images"), `${tag.id}.png`), PNG.sync.write(png));
    }
    counts.images++;
  }

  // --- fonts ---
  for (const font of collectFonts(movie)) {
    const safe = (font.fontName || "Font").replace(/[^\w .-]/g, "");
    writeFileSync(join(dir("fonts"), `${font.id}_${safe}.ttf`), Buffer.from(buildTtf(font)));
    counts.fonts++;
  }

  // --- sounds ---
  for (const tag of collectSounds(movie)) {
    const s = extractSound(tag);
    writeFileSync(join(dir("sounds"), `${tag.id}.${s.ext}`), Buffer.from(s.bytes));
    counts.sounds++;
  }

  // --- buttons (per-state SVGs) ---
  const shapesById = new Map();
  for (const t of movie.tags) if (t.type === swf.TagType.DefineShape) shapesById.set(t.id, t);
  for (const button of collectButtons(movie)) {
    const composed = composeButton(button, (cid) => shapesById.get(cid));
    const bdir = join(dir("buttons"), composed.dir);
    let wrote = false;
    for (const [stateFile, svgStr] of Object.entries(composed.states)) {
      if (!/<path|<image|<use/.test(svgStr)) continue; // skip empty/hit-only states
      mkdirSync(bdir, { recursive: true });
      writeFileSync(join(bdir, `${stateFile}.svg`), svgStr);
      wrote = true;
    }
    if (wrote) counts.buttons++;
  }

  // --- texts: editText literal content + static DefineText reconstructed from glyph indices ---
  for (const t of movie.tags) {
    if (t.type === swf.TagType.DefineDynamicText && t.text != null) {
      writeFileSync(join(dir("texts"), `${t.id}.txt`), String(t.text));
      counts.texts++;
    }
  }
  const fonts = fontsById(movie);
  for (const t of collectStaticTexts(movie)) {
    const text = reconstructText(t, fonts);
    if (text) {
      writeFileSync(join(dir("texts"), `${t.id}.txt`), text);
      counts.texts++;
    }
  }

  console.log(`${scene}: ` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" "));
}
