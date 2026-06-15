import type { Matrix } from "../data/timelineTypes";

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/**
 * Compose two SWF affine matrices (parent ∘ child), so a nested instance's
 * matrix is expressed in stage space. SWF matrices are:
 *   [a c tx]
 *   [b d ty]
 *   [0 0  1]
 */
export function multiplyMatrix(parent: Matrix, child: Matrix): Matrix {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
    ty: parent.b * child.tx + parent.d * child.ty + parent.ty,
  };
}
