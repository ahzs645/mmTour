// Browser-native SWF → SVG shape converter (Route B spike).
//
// Replaces FFDec's `shape:svg` export with pure TypeScript built on the
// open-flash `swf-parser` (already a project dependency, browser-ready). Give it
// raw SWF bytes; get back each DefineShape as an SVG string — no Java, no server.

import { parseSwf, swf } from "swf-parser";
import { defineShapeToSvg, type ShapeSvgResult } from "./svgEmit.ts";

export { rasterizeShape } from "./shapeRasterizer.ts";
export { defineShapeToSvg } from "./svgEmit.ts";
export type { ShapeSvgResult } from "./svgEmit.ts";
export {
  collectBitmaps,
  mergeJpeg,
  inflate,
  decodeLossless,
  bitmapToDataUrl,
  isJpegBitmap,
  isLosslessBitmap,
} from "./imageDecoder.ts";
export type { BitmapSet, RawImage, DecodedImage } from "./imageDecoder.ts";
export { collectFonts, buildTtf } from "./fontBuilder.ts";
export type { FontTag } from "./fontBuilder.ts";
export { collectSounds, extractSound, soundToDataUrl } from "./soundExtractor.ts";
export type { ExtractedSound } from "./soundExtractor.ts";

export interface CollectedShape {
  id: number;
  tag: any;
}

/** Parse SWF bytes and return the movie plus all DefineShape tags. */
export function collectShapes(bytes: Uint8Array): { movie: any; shapes: CollectedShape[] } {
  const movie = parseSwf(bytes);
  const shapes = movie.tags
    .filter((t: any) => t.type === swf.TagType.DefineShape)
    .map((tag: any) => ({ id: tag.id, tag }));
  return { movie, shapes };
}

/** Convenience: SWF bytes → Map of shape id → SVG result. */
export function convertShapes(bytes: Uint8Array): Map<number, ShapeSvgResult> {
  const { shapes } = collectShapes(bytes);
  const out = new Map<number, ShapeSvgResult>();
  for (const { id, tag } of shapes) out.set(id, defineShapeToSvg(tag));
  return out;
}
