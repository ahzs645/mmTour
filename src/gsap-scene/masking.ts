/**
 * Clip-depth masking for scene tracks.
 *
 * A track carrying a clipDepth masks every track whose depth falls in
 * (maskDepth, clipDepth]. The mask shape's bounding rectangle is transformed
 * from the mask's local space into each masked element's local space and applied
 * as a CSS clip-path. This is exact for affine (rect) masks; non-rectangular
 * mask shapes are approximated by their bounding box.
 */

import type { Affine, RuntimeTrack } from "./types";

interface MaskRange {
  runtime: RuntimeTrack;
  start: number;
  end: number;
}

export class MaskManager {
  /** Recompute and apply masks for the currently visible tracks. */
  update(runtimeTracks: RuntimeTrack[], activeClipDepth: (rt: RuntimeTrack) => number | undefined) {
    const ranges: MaskRange[] = [];
    for (const runtime of runtimeTracks) {
      if (runtime.visible === false) continue;
      const clipDepth = activeClipDepth(runtime);
      if (clipDepth !== undefined) {
        ranges.push({ runtime, start: runtime.track.depth + 1, end: clipDepth });
      }
    }

    for (const runtime of runtimeTracks) {
      const depth = runtime.track.depth;
      // A mask element should not clip itself or other masks.
      const isMask = ranges.some((range) => range.runtime === runtime);
      const range = isMask
        ? undefined
        : ranges.find((r) => depth >= r.start && depth <= r.end && runtime.visible !== false);

      const signature = range
        ? `${range.runtime.track.id}:${matrixKey(range.runtime.state)}:${matrixKey(runtime.state)}`
        : "";
      if (signature === runtime.lastClipSignature) continue;
      runtime.lastClipSignature = signature;

      if (!range) {
        runtime.element.style.clipPath = "";
        continue;
      }
      runtime.element.style.clipPath = clipPathFor(range.runtime, runtime);
    }
  }

  reset(runtimeTracks: RuntimeTrack[]) {
    for (const runtime of runtimeTracks) {
      runtime.element.style.clipPath = "";
      runtime.lastClipSignature = null;
    }
  }
}

function clipPathFor(mask: RuntimeTrack, target: RuntimeTrack): string {
  const origin = mask.track.origin;
  // Mask shape rectangle in the mask element's local space.
  const x0 = -origin.x;
  const y0 = -origin.y;
  const x1 = x0 + (origin.width || 0);
  const y1 = y0 + (origin.height || 0);
  const corners = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];

  const maskMatrix = toAffine(mask.state);
  const targetInverse = invert(toAffine(target.state));
  if (!targetInverse) return "";

  const points = corners.map((corner) => {
    const stage = applyAffine(maskMatrix, corner);
    const local = applyAffine(targetInverse, stage);
    return `${local.x.toFixed(2)}px ${local.y.toFixed(2)}px`;
  });
  return `polygon(${points.join(", ")})`;
}

function toAffine(state: Affine): Affine {
  return { a: state.a, b: state.b, c: state.c, d: state.d, tx: state.tx, ty: state.ty };
}

function applyAffine(m: Affine, p: { x: number; y: number }): { x: number; y: number } {
  return {
    x: m.a * p.x + m.c * p.y + m.tx,
    y: m.b * p.x + m.d * p.y + m.ty,
  };
}

function invert(m: Affine): Affine | null {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-9) return null;
  const id = 1 / det;
  return {
    a: m.d * id,
    b: -m.b * id,
    c: -m.c * id,
    d: m.a * id,
    tx: (m.c * m.ty - m.d * m.tx) * id,
    ty: (m.b * m.tx - m.a * m.ty) * id,
  };
}

function matrixKey(state: Affine): string {
  return `${r(state.a)},${r(state.b)},${r(state.c)},${r(state.d)},${r(state.tx)},${r(state.ty)}`;
}

function r(value: number): number {
  return Math.round(value * 100) / 100;
}
