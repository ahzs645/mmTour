// Opt-in rendering experiments for the "washed out vs Ruffle" image-sharpness
// investigation (see docs/image-sharpness-vs-ruffle.md). These target the doc's
// own leading hypothesis — that per-instance compositor layers placed at sub-pixel
// transforms are GPU-bilinear-resampled — which the earlier experiments never
// tested directly (they all acted on the *stage*, not the instances).
//
// Everything here is gated behind a `?sharpen=` URL flag and is a no-op by
// default, so renders can be A/B-measured with scripts/measure-sharpness.mjs
// without changing production behaviour.
//
//   ?sharpen=nowill   drop `will-change` so instances aren't promoted to their
//                     own GPU texture (browser paints them into the shared stage
//                     buffer with its high-quality rasteriser instead).
//   ?sharpen=snap     round each instance's translation to a whole *device* pixel
//                     so there is no sub-pixel boundary to resample.
//   ?sharpen=all      both of the above.

export type SharpnessFlags = {
  /** Strip `will-change` from instance layers (toggled via a root class). */
  noWillChange: boolean;
  /** Snap translation-only instances to integer device pixels. */
  snapTranslate: boolean;
};

function readFlags(): SharpnessFlags {
  if (typeof location === "undefined") return { noWillChange: false, snapTranslate: false };
  const tokens = new URLSearchParams(location.search).get("sharpen")?.split(/[,\s]+/) ?? [];
  const has = (t: string) => tokens.includes(t) || tokens.includes("all");
  return { noWillChange: has("nowill"), snapTranslate: has("snap") };
}

export const sharpnessFlags: SharpnessFlags = readFlags();

/** Toggle the root class the `will-change` override in styles.css keys off of. */
export function applySharpnessFlagsToRoot(): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("exp-sharpen-nowill", sharpnessFlags.noWillChange);
}

// The instance matrices are in stage (640×480) space, applied *before* the stage's
// own `transform: scale(--stage-scale)` and the display's devicePixelRatio. So a
// whole stage unit is `stageScale * dpr` device pixels — snapping to integer stage
// units would still land on a fractional device pixel. Track the live stage scale
// (frameMode.syncAssetStageScale feeds it) so we can snap in true device space.
let stageScale = 1;
export function setStageScale(scale: number): void {
  if (Number.isFinite(scale) && scale > 0) stageScale = scale;
}

/**
 * Snap a stage-space translation to a whole device pixel when `?sharpen=snap` is
 * on; otherwise return it untouched. Only meaningful for translation-only
 * instances (a rotated/scaled instance carries its own sub-pixel edges that a
 * translation snap can't remove), but a sub-pixel position shift is imperceptible
 * either way, so we apply it unconditionally when the flag is set.
 */
export function snapTranslate(tx: number, ty: number): [number, number] {
  if (!sharpnessFlags.snapTranslate) return [tx, ty];
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const unit = stageScale * dpr;
  if (!(unit > 0)) return [tx, ty];
  return [Math.round(tx * unit) / unit, Math.round(ty * unit) / unit];
}
