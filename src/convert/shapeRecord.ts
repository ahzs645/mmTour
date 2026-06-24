// Phase 2 of the shape-packing work (docs/generated-size-and-packing.md): a compact,
// numeric draw record for a DefineShape, built from the SAME rasterizer the SVG emitter
// uses (shapeRasterizer.ts) — never by re-parsing SVG. Reconstructing it through the
// shared stringifier (rasterizedToShapeSvg) yields byte-identical SVG, so records can
// replace per-shape `.svg` files in a pack with no rendering change.
//
// Geometry is stored in twips (the rasterizer's native integer-ish units); the
// reconstructor reformats to px exactly as the emitter does. Bitmap fills are stored as
// a bitmap id (the image is referenced/inlined separately — see Phase 1).

import { rasterizeShape, type FillPath, type LinePath, type RasterizedShape, type Seg } from "./shapeRasterizer.ts";
import type { ShapeBounds } from "./svgEmit.ts";

type Color = [r: number, g: number, b: number, a: number];
// [scaleX, rotateSkew0, rotateSkew1, scaleY, translateX, translateY]
type Mat = [number, number, number, number, number, number];

type FillStyleRecord =
  | { t: 4; col: Color } // solid
  | { t: 0; bid: number; m: Mat } // bitmap
  | { t: 1 | 2 | 3; sp: number; st: Array<[number, Color]>; m: Mat }; // focal/linear/radial gradient

type LineStyleRecord = { w: number; cap: number; join: number; col: Color | null };

// A segment: [x1, y1, x2, y2] straight, or [x1, y1, x2, y2, cx, cy] quadratic.
type SegRecord = [number, number, number, number] | [number, number, number, number, number, number];

export interface ShapeRecord {
  /** bounds in twips: [xMin, yMin, xMax, yMax]. */
  b: [number, number, number, number];
  /** fills: [contours, style] in paint order. */
  f: Array<[SegRecord[][], FillStyleRecord]>;
  /** lines: [chains, style] in paint order. */
  l: Array<[SegRecord[][], LineStyleRecord]>;
}

export function shapeToRecord(tag: { shape: unknown; bounds: ShapeBounds }): ShapeRecord {
  const { fills, lines } = rasterizeShape(tag.shape);
  return {
    b: [tag.bounds.xMin, tag.bounds.yMin, tag.bounds.xMax, tag.bounds.yMax],
    f: fills.map((fp) => [contoursToRecord(fp.contours), fillStyleToRecord(fp.fill)]),
    l: lines.map((lp) => [contoursToRecord(lp.chains), lineStyleToRecord(lp.line)]),
  };
}

/** Rebuild the rasterizer's structure from a record, so the shared stringifier
 *  (rasterizedToShapeSvg) can render it identically. */
export function recordToRasterized(record: ShapeRecord): { rasterized: RasterizedShape; bounds: ShapeBounds } {
  const fills: FillPath[] = record.f.map(([contours, style], order) => ({
    order,
    contours: contoursFromRecord(contours),
    fill: fillStyleFromRecord(style),
  }));
  const lines: LinePath[] = record.l.map(([chains, style], order) => ({
    order,
    chains: contoursFromRecord(chains),
    line: lineStyleFromRecord(style),
  }));
  const [xMin, yMin, xMax, yMax] = record.b;
  return { rasterized: { fills, lines }, bounds: { xMin, yMin, xMax, yMax } };
}

// --- segment (de)serialization ---

function contoursToRecord(contours: Seg[][]): SegRecord[][] {
  return contours.map((contour) => contour.map(segToRecord));
}

function contoursFromRecord(contours: SegRecord[][]): Seg[][] {
  return contours.map((contour) => contour.map(segFromRecord));
}

function segToRecord(s: Seg): SegRecord {
  return s.cx !== undefined ? [s.x1, s.y1, s.x2, s.y2, s.cx, s.cy!] : [s.x1, s.y1, s.x2, s.y2];
}

function segFromRecord(s: SegRecord): Seg {
  const seg: Seg = { x1: s[0], y1: s[1], x2: s[2], y2: s[3] };
  if (s.length === 6) {
    seg.cx = s[4];
    seg.cy = s[5];
  }
  return seg;
}

// --- style (de)serialization ---

function fillStyleToRecord(fill: any): FillStyleRecord {
  const type = fill?.type;
  if (type === 4) return { t: 4, col: color(fill.color) };
  if (type === 0) return { t: 0, bid: Number(fill.bitmapId), m: matrix(fill.matrix) };
  return {
    t: type,
    sp: fill.gradient.spread,
    st: fill.gradient.colors.map((s: any): [number, Color] => [s.ratio, color(s.color)]),
    m: matrix(fill.matrix),
  };
}

function fillStyleFromRecord(style: FillStyleRecord): any {
  if (style.t === 4) return { type: 4, color: colorObject(style.col) };
  if (style.t === 0) return { type: 0, bitmapId: style.bid, matrix: matrixObject(style.m) };
  return {
    type: style.t,
    gradient: { spread: style.sp, colors: style.st.map(([ratio, col]) => ({ ratio, color: colorObject(col) })) },
    matrix: matrixObject(style.m),
  };
}

function lineStyleToRecord(line: any): LineStyleRecord {
  const resolved = line.fill?.type === 4 ? line.fill.color : line.color;
  return {
    w: fixed(line.width ?? 20),
    cap: line.startCap ?? 0,
    join: joinType(line.join),
    col: resolved ? color(resolved) : null,
  };
}

function lineStyleFromRecord(style: LineStyleRecord): any {
  return { width: style.w, startCap: style.cap, join: style.join, color: style.col ? colorObject(style.col) : undefined };
}

function color(c: any): Color {
  return [c.r, c.g, c.b, c.a ?? 255];
}

function colorObject(c: Color): { r: number; g: number; b: number; a: number } {
  return { r: c[0], g: c[1], b: c[2], a: c[3] };
}

function matrix(m: any): Mat {
  return [fixed(m?.scaleX), fixed(m?.rotateSkew0), fixed(m?.rotateSkew1), fixed(m?.scaleY), m?.translateX ?? 0, m?.translateY ?? 0];
}

function matrixObject(m: Mat): Record<string, number> {
  return { scaleX: m[0], rotateSkew0: m[1], rotateSkew1: m[2], scaleY: m[3], translateX: m[4], translateY: m[5] };
}

// SWF fixed-point / join helpers mirror svgEmit so reconstruction matches exactly.
function fixed(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v?.epsilons === "number") return v.epsilons / 65536;
  if (typeof v?.toValue === "function") return v.toValue();
  return Number(v) || 0;
}

function joinType(j: any): number {
  return (typeof j === "object" && j ? j.type : j) ?? 2;
}
