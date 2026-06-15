/**
 * Applies SWF color transforms to DOM media using exact feColorMatrix filters.
 *
 * A SWF color transform is pixel * mult + add per channel. CSS filters cannot
 * express that directly, so we attach a hidden <svg><defs> with one <filter>
 * per track and reference it via `filter: url(#id)`. Alpha is handled by the
 * element's tweened opacity, so the matrix only multiplies/adds RGB.
 */

import type { RuntimeTrack, SceneColorTransform } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

export class ColorTransformManager {
  private defs: SVGDefsElement;

  constructor(host: HTMLElement) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.position = "absolute";
    svg.style.width = "0";
    svg.style.height = "0";
    svg.style.overflow = "hidden";
    this.defs = document.createElementNS(SVG_NS, "defs");
    svg.append(this.defs);
    host.append(svg);
  }

  apply(runtime: RuntimeTrack, ct: SceneColorTransform | null | undefined) {
    const signature = ct ? JSON.stringify(ct) : "";
    if (signature === runtime.lastColorSignature) return;
    runtime.lastColorSignature = signature;

    const rm = ct?.rm ?? 1;
    const gm = ct?.gm ?? 1;
    const bm = ct?.bm ?? 1;
    const ra = (ct?.ra ?? 0) / 255;
    const ga = (ct?.ga ?? 0) / 255;
    const ba = (ct?.ba ?? 0) / 255;
    const needsFilter = rm !== 1 || gm !== 1 || bm !== 1 || ra !== 0 || ga !== 0 || ba !== 0;

    if (!needsFilter) {
      runtime.media.style.filter = "";
      this.removeFilter(runtime.track.id);
      return;
    }

    const filterId = `scene-color-${runtime.track.id}`;
    let filter = this.defs.querySelector(`#${filterId}`) as SVGFilterElement | null;
    if (!filter) {
      filter = document.createElementNS(SVG_NS, "filter");
      filter.setAttribute("id", filterId);
      filter.setAttribute("color-interpolation-filters", "sRGB");
      this.defs.append(filter);
    }
    filter.innerHTML =
      `<feColorMatrix type="matrix" values="${rm} 0 0 0 ${ra} 0 ${gm} 0 0 ${ga} 0 0 ${bm} 0 ${ba} 0 0 0 1 0"/>`;
    runtime.media.style.filter = `url(#${filterId})`;
  }

  private removeFilter(trackId: string) {
    this.defs.querySelector(`#scene-color-${trackId}`)?.remove();
  }

  clear() {
    this.defs.replaceChildren();
  }
}
