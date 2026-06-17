// Pure matrix / colour-transform helpers for the timeline extractor.
// Convert FFDec XML MATRIX / CXFORM tags into the runtime's matrix + colour shapes.

import { hex, number } from "./util.mjs";

export function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
}

export function matrixFromTag(matrix) {
  const hasScale = matrix.hasScale === "true";
  const hasRotate = matrix.hasRotate === "true";
  // SWF MATRIX → SVG/CSS matrix(a,b,c,d,e,f):
  //   x' = ScaleX*x + RotateSkew1*y + tx   → a=ScaleX, c=RotateSkew1
  //   y' = RotateSkew0*x + ScaleY*y  + ty   → b=RotateSkew0, d=ScaleY
  return {
    a: hasScale ? number(matrix.scaleX, 1) : 1,
    b: hasRotate ? number(matrix.rotateSkew0, 0) : 0,
    c: hasRotate ? number(matrix.rotateSkew1, 0) : 0,
    d: hasScale ? number(matrix.scaleY, 1) : 1,
    tx: number(matrix.translateX, 0) / 20,
    ty: number(matrix.translateY, 0) / 20,
  };
}

export function matrixFromSvgTransform(transform) {
  const values = String(transform ?? "")
    .match(/matrix\(([^)]+)\)/)?.[1]
    ?.split(/[,\s]+/)
    .filter(Boolean)
    .map((value) => Number.parseFloat(value));
  if (!values || values.length < 6 || values.some((value) => !Number.isFinite(value))) return identityMatrix();
  const [a, b, c, d, tx, ty] = values;
  return { a, b, c, d, tx, ty };
}

export function multiplyMatrices(left, right) {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    tx: left.a * right.tx + left.c * right.ty + left.tx,
    ty: left.b * right.tx + left.d * right.ty + left.ty,
  };
}

export function opacityFromTag(transform) {
  const mult = number(transform.alphaMultTerm, 256) / 256;
  const add = number(transform.alphaAddTerm, 0) / 255;
  return Math.max(0, Math.min(1, mult + add));
}

/**
 * Extract the RGB part of a CXFORMWITHALPHA as normalized mult (term/256) + add
 * (term/255) per channel. Alpha is handled separately via `opacity`, so this
 * returns only the colour tint (e.g. the tour-shell swoosh's #6699cc stroke is
 * lightened toward white). Returns undefined when the RGB transform is identity.
 */
export function colorTransformFromTag(transform) {
  if (!transform) return undefined;
  const rm = number(transform.redMultTerm, 256) / 256;
  const gm = number(transform.greenMultTerm, 256) / 256;
  const bm = number(transform.blueMultTerm, 256) / 256;
  const ra = number(transform.redAddTerm, 0) / 255;
  const ga = number(transform.greenAddTerm, 0) / 255;
  const ba = number(transform.blueAddTerm, 0) / 255;
  if (rm === 1 && gm === 1 && bm === 1 && ra === 0 && ga === 0 && ba === 0) return undefined;
  const round = (n) => Math.round(n * 1000) / 1000;
  return { rm: round(rm), gm: round(gm), bm: round(bm), ra: round(ra), ga: round(ga), ba: round(ba) };
}

export function colorFromTag(color) {
  if (!color) return "#ffffff";
  const red = Math.max(0, Math.min(255, Math.round(number(color.red, 255))));
  const green = Math.max(0, Math.min(255, Math.round(number(color.green, 255))));
  const blue = Math.max(0, Math.min(255, Math.round(number(color.blue, 255))));
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}
