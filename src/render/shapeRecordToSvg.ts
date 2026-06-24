// Phase 3 (docs/generated-size-and-packing.md): reconstruct a shape's SVG document
// from its compact draw record (src/convert/shapeRecord.ts). It routes through the same
// stringifier the build emitter uses (rasterizedToShapeSvg), so the output is
// byte-identical to the per-shape `.svg` file — which means the DomRenderer mask path
// (regex over `<g transform="matrix(…)"><path…>`), buttons, and frame mode keep working
// unchanged. The record is the SVG's smaller stored form, nothing more.

import { recordToRasterized, type ShapeRecord } from "../convert/shapeRecord.ts";
import { rasterizedToShapeSvg, type BitmapFillImage } from "../convert/svgEmit.ts";

export type ShapeRecordOptions = {
  /** Resolve a bitmap fill's image (dimensions + href/ref) by character id — same
   *  contract as the emitter's `bitmapFill`. Only needed for shapes with bitmap fills. */
  bitmapFill?: (bitmapId: number) => BitmapFillImage | undefined;
};

export function shapeRecordToSvg(record: ShapeRecord, options: ShapeRecordOptions = {}): string {
  const { rasterized, bounds } = recordToRasterized(record);
  return rasterizedToShapeSvg(rasterized, bounds, options).svg;
}
