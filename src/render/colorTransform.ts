import type { ColorTransform } from "../data/timelineTypes";

const SVG_NS = "http://www.w3.org/2000/svg";
const FILTER_ROOT_ID = "mmtour-color-transform-filters";

/**
 * Apply a SWF colour transform's RGB tint (per-channel `out = in*mult + add`) to
 * a media element via an SVG `feComponentTransfer` filter. Alpha is handled by
 * the element's `opacity` (the Player folds the alpha multiplier into
 * `node.opacity`), so this only touches R/G/B.
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

  media.style.filter = `url(#${ensureColorTransformFilter(rm, gm, bm, ra, ga, ba)})`;
}

function ensureColorTransformFilter(rm: number, gm: number, bm: number, ra: number, ga: number, ba: number): string {
  const id = filterId(rm, gm, bm, ra, ga, ba);
  if (document.getElementById(id)) return id;

  let root = document.getElementById(FILTER_ROOT_ID) as SVGSVGElement | null;
  if (!root) {
    root = document.createElementNS(SVG_NS, "svg");
    root.id = FILTER_ROOT_ID;
    root.setAttribute("width", "0");
    root.setAttribute("height", "0");
    root.setAttribute("aria-hidden", "true");
    root.style.position = "absolute";
    root.style.width = "0";
    root.style.height = "0";
    root.style.overflow = "hidden";
    document.body.append(root);
  }

  const filter = document.createElementNS(SVG_NS, "filter");
  filter.id = id;
  // SWF colour transforms operate on gamma (sRGB) channel values, not linearised ones.
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const transfer = document.createElementNS(SVG_NS, "feComponentTransfer");
  transfer.append(channel("feFuncR", rm, ra), channel("feFuncG", gm, ga), channel("feFuncB", bm, ba));
  filter.append(transfer);
  root.append(filter);
  return id;
}

function channel(name: "feFuncR" | "feFuncG" | "feFuncB", slope: number, intercept: number): SVGElement {
  const node = document.createElementNS(SVG_NS, name);
  node.setAttribute("type", "linear");
  node.setAttribute("slope", String(slope));
  node.setAttribute("intercept", String(intercept));
  return node;
}

function filterId(...values: number[]): string {
  return `mmtour-ct-${values.map((value) => String(Math.round(value * 100000)).replace("-", "n")).join("-")}`;
}
