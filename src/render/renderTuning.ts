// Image-sharpness fix (docs/image-sharpness-vs-ruffle.md §10). Measurement showed
// that promoting each on-stage instance to its own GPU compositor layer via
// `will-change: transform, opacity` made the layer bilinear-resampled at its
// sub-pixel transform offset, costing ~8% of edge sharpness vs rendering the same
// content as a single SVG buffer (the "washed out vs Ruffle" symptom). The default
// is therefore NO `will-change` on instances (see styles.css).
//
// This opt-in restores the old behaviour for an A/B comparison (sharpness regression
// check, or to feel out animation smoothness): open the app with `?willchange`.

/** Re-add `will-change` to instance layers when `?willchange` is in the URL. */
export function applySharpnessFlagsToRoot(): void {
  if (typeof document === "undefined" || typeof location === "undefined") return;
  const restore = new URLSearchParams(location.search).has("willchange");
  document.documentElement.classList.toggle("exp-willchange", restore);
}
