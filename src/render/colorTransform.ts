import type { ColorTransform } from "../data/timelineTypes";

/**
 * Apply a SWF colour transform's RGB tint (per-channel `out = in*mult + add`) to
 * a media element via an inline SVG `feComponentTransfer` filter — exact, not an
 * approximation. Alpha is handled by the element's `opacity` (the Player folds
 * the alpha multiplier into `node.opacity`), so this only touches R/G/B. Example:
 * the tour-shell swoosh's solid #6699cc stroke is lightened toward white, matching
 * Ruffle, instead of rendering bold.
 */
export function applyColorTransform(media: HTMLElement, ct: ColorTransform | undefined) {
  const rm = ct?.rm ?? 1;
  const gm = ct?.gm ?? 1;
  const bm = ct?.bm ?? 1;
  const ra = ct?.ra ?? 0;
  const ga = ct?.ga ?? 0;
  const ba = ct?.ba ?? 0;

  const identity = rm === 1 && gm === 1 && bm === 1 && ra === 0 && ga === 0 && ba === 0;
  if (identity) {
    media.style.removeProperty("filter");
    return;
  }

  // color-interpolation-filters=sRGB: SWF colour transforms operate on gamma
  // (sRGB) channel values, not linearised ones.
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg'>` +
    `<filter id='c' color-interpolation-filters='sRGB'>` +
    `<feComponentTransfer>` +
    `<feFuncR type='linear' slope='${rm}' intercept='${ra}'/>` +
    `<feFuncG type='linear' slope='${gm}' intercept='${ga}'/>` +
    `<feFuncB type='linear' slope='${bm}' intercept='${ba}'/>` +
    `</feComponentTransfer></filter></svg>`;
  media.style.filter = `url("data:image/svg+xml,${encodeURIComponent(svg)}#c")`;
}
