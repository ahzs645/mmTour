import type { ColorTransform } from "../data/timelineTypes";

/**
 * Approximate a SWF color transform with CSS. Full multiply+add color
 * transforms need an SVG filter; for the DOM display list we approximate the
 * common cases (brightness multiply + alpha) which covers the tour's fades and
 * dims. Returns the filter string and effective alpha multiplier.
 */
export function applyColorTransform(media: HTMLElement, ct: ColorTransform | undefined) {
  if (!ct) {
    media.style.filter = "";
    media.style.removeProperty("opacity");
    return;
  }

  const brightness = ct.rm ?? ct.gm ?? ct.bm ?? 1;
  const alpha = ct.am ?? 1;
  const hasAdditive = Boolean(ct.ra || ct.ga || ct.ba);
  media.style.filter = hasAdditive ? `brightness(${brightness}) saturate(1.05)` : `brightness(${brightness})`;
  if (alpha !== 1) {
    media.style.opacity = String(alpha);
  } else {
    media.style.removeProperty("opacity");
  }
}
