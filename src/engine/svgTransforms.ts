// SVG viewport / colour-transform application + owned-target collection.

import type { DisplayEntry } from "./GsapSwfRenderer.types";
import type { SwfMatrix } from "./SwfParser";
import { getDescendantSvgTargets, getElementOffset } from "./svgDom";

export function getViewportTransform(element: HTMLElement, matrix: SwfMatrix): SwfMatrix {
  const offset = getElementOffset(element);
  return {
    a: matrix.a,
    b: matrix.b,
    c: matrix.c,
    d: matrix.d,
    tx: matrix.tx - (matrix.a * offset.x + matrix.c * offset.y),
    ty: matrix.ty - (matrix.b * offset.x + matrix.d * offset.y),
  };
}

export function applyColorTransform(entry: DisplayEntry, depth: number) {
  const ct = entry.colorTransform;
  const svgTargets = getDescendantSvgTargets(entry.element);

  if (!ct) {
    entry.element.style.opacity = '1';
    svgTargets.forEach(({ svg, group }, index) => {
      group.removeAttribute('filter');
      svg.querySelector(`#swf-color-${depth}-${index}`)?.remove();
    });
    return;
  }

  const rm = ct.rm ?? 1;
  const gm = ct.gm ?? 1;
  const bm = ct.bm ?? 1;
  const am = ct.am ?? 1;
  const ra = (ct.ra ?? 0) / 255;
  const ga = (ct.ga ?? 0) / 255;
  const ba = (ct.ba ?? 0) / 255;
  const aa = (ct.aa ?? 0) / 255;
  const needsFilter = rm !== 1 || gm !== 1 || bm !== 1 || am !== 1 || ra !== 0 || ga !== 0 || ba !== 0 || aa !== 0;

  if (!svgTargets.length || !needsFilter) {
    entry.element.style.opacity = String(Math.max(0, Math.min(1, am)));
    svgTargets.forEach(({ svg, group }, index) => {
      group.removeAttribute('filter');
      svg.querySelector(`#swf-color-${depth}-${index}`)?.remove();
    });
    return;
  }

  entry.element.style.opacity = '1';

  svgTargets.forEach(({ svg, group }, index) => {
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      svg.insertBefore(defs, svg.firstChild);
    }

    const filterId = `swf-color-${depth}-${index}`;
    let filterEl = svg.querySelector(`#${filterId}`) as SVGFilterElement | null;
    if (!filterEl) {
      filterEl = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
      filterEl.setAttribute('id', filterId);
      defs.appendChild(filterEl);
    }

    filterEl.innerHTML = `<feColorMatrix type="matrix" values="${rm} 0 0 0 ${ra} 0 ${gm} 0 0 ${ga} 0 0 ${bm} 0 ${ba} 0 0 0 ${am} ${aa}"/>`;
    group.setAttribute('filter', `url(#${filterId})`);
  });
}

export function getOwnedSvgTargets(element: HTMLElement): Array<{ svg: SVGSVGElement; group: SVGGElement }> {
  return getDescendantSvgTargets(element).filter(({ svg }) => {
    return svg.closest('[data-char-id]') === element;
  });
}
