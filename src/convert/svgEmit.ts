// Rasterized shape → SVG document, matching FFDec's layout conventions so the
// output drops into the same `public/generated/<scene>/shapes/<id>.svg` slots:
//  - width/height in px (= bounds size / 20)
//  - a `<g matrix(1,0,0,1,-xMin/20,-yMin/20)>` shifting native coords into the box
//  - path coordinates in px (twips/20)
//  - one `<path fill-rule="evenodd">` per fill style

import { rasterizeShape, type FillPath, type LinePath, type Seg } from "./shapeRasterizer.ts";

const FILL_BITMAP = 0;
const FILL_FOCAL = 1;
const FILL_LINEAR = 2;
const FILL_RADIAL = 3;
const FILL_SOLID = 4;

/** Round to ≤2 decimals and drop the noise that twips/20 never needs. */
function num(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}
const px = (twips: number) => num(twips / 20);

function hex(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
}
const colorHex = (c: any) => `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;

// SWF CapStyle 0=Round 1=None(butt) 2=Square ; JoinStyle 0=Round 1=Bevel 2=Miter
const CAP: Record<number, string> = { 0: "round", 1: "butt", 2: "square" };
const JOIN: Record<number, string> = { 0: "round", 1: "bevel", 2: "miter" };
const joinType = (j: any) => (typeof j === "object" && j ? j.type : j) ?? 2;

export interface ShapeSvgResult {
  svg: string;
  /** Fill styles encountered, for coverage reporting (e.g. ["Solid","LinearGradient"]). */
  fillTypes: string[];
  unsupported: string[];
}

export interface BitmapFillImage {
  width: number;
  height: number;
  href: string;
}

export type BitmapFillResolver = (bitmapId: number) => BitmapFillImage | undefined;

export interface ShapeSvgOptions {
  bitmapFill?: BitmapFillResolver;
}

export function defineShapeToSvg(tag: any, options: ShapeSvgOptions = {}): ShapeSvgResult {
  const { bounds } = tag;
  const w = (bounds.xMax - bounds.xMin) / 20;
  const h = (bounds.yMax - bounds.yMin) / 20;
  const inner = shapeInner(tag, "g", options);

  const defsBlock = inner.defs ? `<defs>${inner.defs}</defs>` : "";
  const g = `<g transform="matrix(1.0, 0.0, 0.0, 1.0, ${num(-bounds.xMin / 20)}, ${num(-bounds.yMin / 20)})">${inner.body}</g>`;
  const svg = `<svg xmlns:xlink="http://www.w3.org/1999/xlink" height="${num(h)}px" width="${num(w)}px" xmlns="http://www.w3.org/2000/svg">${defsBlock}${g}</svg>`;
  return { svg, fillTypes: inner.fillTypes, unsupported: inner.unsupported };
}

export interface ShapeInner {
  /** `<path>` elements in the shape's native px space (twips/20), no origin shift. */
  body: string;
  /** gradient `<def>` contents (no wrapping <defs>); ids are prefixed to stay unique. */
  defs: string;
  fillTypes: string[];
  unsupported: string[];
}

/** Build a shape's paint primitives without the outer <svg>/<g origin> — so a
 *  caller (e.g. the button compositor) can place the shape under its own matrix. */
export function shapeInner(tag: any, idPrefix: string, options: ShapeSvgOptions = {}): ShapeInner {
  const { fills, lines } = rasterizeShape(tag.shape);
  const defs: string[] = [];
  const body: string[] = [];
  const fillTypes: string[] = [];
  const unsupported: string[] = [];
  let gradId = 0;

  for (const fp of fills) {
    const d = fillPathData(fp.contours);
    if (!d) continue;
    const type = fp.fill?.type;
    if (type === FILL_SOLID) {
      fillTypes.push("Solid");
      const c = fp.fill.color;
      const op = c.a < 255 ? ` fill-opacity="${num(c.a / 255)}"` : "";
      body.push(`<path d="${d}" fill="${colorHex(c)}"${op} fill-rule="evenodd" stroke="none"/>`);
    } else if (type === FILL_LINEAR || type === FILL_RADIAL || type === FILL_FOCAL) {
      fillTypes.push(type === FILL_LINEAR ? "LinearGradient" : type === FILL_RADIAL ? "RadialGradient" : "FocalGradient");
      const id = `${idPrefix}_grad${gradId++}`;
      defs.push(gradientDef(id, fp.fill));
      body.push(`<path d="${d}" fill="url(#${id})" fill-rule="evenodd" stroke="none"/>`);
    } else if (type === FILL_BITMAP) {
      fillTypes.push("Bitmap");
      const bitmapId = Number(fp.fill.bitmapId);
      const bitmap = Number.isFinite(bitmapId) ? options.bitmapFill?.(bitmapId) : undefined;
      if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
        const id = `${idPrefix}_bitmap${gradId++}`;
        defs.push(bitmapPatternDef(id, fp.fill, bitmap));
        body.push(`<path d="${d}" fill="url(#${id})" fill-rule="evenodd" stroke="none"/>`);
      } else {
        unsupported.push(`Bitmap fill${Number.isFinite(bitmapId) ? ` ${bitmapId}` : ""}`);
        body.push(`<path d="${d}" fill="#808080" fill-opacity="0" fill-rule="evenodd" stroke="none" data-bitmap-fill="${bitmapId}"/>`);
      }
    }
  }

  for (const lp of lines) {
    const d = linePathData(lp.chains);
    if (!d) continue;
    const st = lp.line;
    const stroke = st.fill?.type === FILL_SOLID ? colorHex(st.fill.color) : st.color ? colorHex(st.color) : "#000000";
    const width = num(Math.max(st.width ?? 20, 20) / 20);
    const cap = CAP[st.startCap] ?? "round";
    const join = JOIN[joinType(st.join)] ?? "round";
    body.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="${cap}" stroke-linejoin="${join}"/>`);
  }

  return { body: body.join(""), defs: defs.join(""), fillTypes, unsupported };
}

function fillPathData(contours: Seg[][]): string {
  const parts: string[] = [];
  for (const contour of contours) {
    if (!contour.length) continue;
    const first = contour[0];
    let d = `M${px(first.x1)} ${px(first.y1)}`;
    for (const s of contour) {
      d += s.cx !== undefined ? ` Q${px(s.cx)} ${px(s.cy!)} ${px(s.x2)} ${px(s.y2)}` : ` L${px(s.x2)} ${px(s.y2)}`;
    }
    parts.push(`${d}Z`);
  }
  return parts.join(" ");
}

function linePathData(chains: Seg[][]): string {
  const parts: string[] = [];
  for (const chain of chains) {
    if (!chain.length) continue;
    const first = chain[0];
    let d = `M${px(first.x1)} ${px(first.y1)}`;
    for (const s of chain) {
      d += s.cx !== undefined ? ` Q${px(s.cx)} ${px(s.cy!)} ${px(s.x2)} ${px(s.y2)}` : ` L${px(s.x2)} ${px(s.y2)}`;
    }
    parts.push(d);
  }
  return parts.join(" ");
}

// SWF gradients are defined over a ±16384-twip square mapped by the fill matrix.
// Working in px (the path space), that square is ±819.2 (=16384/20); the matrix
// maps gradient px → shape px with scale/skew unchanged and translate /20.
// Field order matches the codebase matrix convention: b=rotateSkew0, c=rotateSkew1.
const GRAD_EXTENT = 16384 / 20; // 819.2

const SPREAD = ["pad", "reflect", "repeat"];

/** Round to ≤4 decimals (matrix scale/skew terms are tiny). */
function mnum(v: number): string {
  const r = Math.round(v * 1e4) / 1e4;
  return Object.is(r, -0) ? "0" : String(r);
}

function gradientDef(id: string, fill: any): string {
  const m = fill.matrix;
  const transform =
    `gradientTransform="matrix(${mnum(fixed(m.scaleX))} ${mnum(fixed(m.rotateSkew0))} ` +
    `${mnum(fixed(m.rotateSkew1))} ${mnum(fixed(m.scaleY))} ${mnum(m.translateX / 20)} ${mnum(m.translateY / 20)})"`;
  const spread = `spreadMethod="${SPREAD[fill.gradient.spread] ?? "pad"}"`;
  const stops = fill.gradient.colors
    .map((s: any) => `<stop offset="${num(s.ratio / 255)}" stop-color="${colorHex(s.color)}"${s.color.a < 255 ? ` stop-opacity="${num(s.color.a / 255)}"` : ""}/>`)
    .join("");
  if (fill.type === FILL_LINEAR) {
    return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${-GRAD_EXTENT}" y1="0" x2="${GRAD_EXTENT}" y2="0" ${spread} ${transform}>${stops}</linearGradient>`;
  }
  // Radial (and focal, approximated as radial for the spike): centered, r = extent.
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${GRAD_EXTENT}" ${spread} ${transform}>${stops}</radialGradient>`;
}

function bitmapPatternDef(id: string, fill: any, bitmap: BitmapFillImage): string {
  const m = fill.matrix;
  const transform =
    `patternTransform="matrix(${mnum(fixed(m?.scaleX) / 20)} ${mnum(fixed(m?.rotateSkew0) / 20)} ` +
    `${mnum(fixed(m?.rotateSkew1) / 20)} ${mnum(fixed(m?.scaleY) / 20)} ${mnum((m?.translateX ?? 0) / 20)} ${mnum((m?.translateY ?? 0) / 20)})"`;
  return (
    `<pattern id="${id}" patternUnits="userSpaceOnUse" overflow="visible" ` +
    `viewBox="0 0 ${num(bitmap.width)} ${num(bitmap.height)}" width="${num(bitmap.width)}" height="${num(bitmap.height)}" ${transform}>` +
    `<image width="${num(bitmap.width)}" height="${num(bitmap.height)}" style="image-rendering:optimizeQuality" xlink:href="${escapeAttr(bitmap.href)}"/>` +
    `</pattern>`
  );
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fixed(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v?.epsilons === "number") return v.epsilons / 65536;
  if (typeof v?.toValue === "function") return v.toValue();
  return Number(v) || 0;
}
