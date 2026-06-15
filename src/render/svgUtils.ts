// Small SVG helpers shared by the inline-SVG button overlay code. These mirror
// the proven walk used by the Frame SVG renderer: accumulate transforms down the
// tree (following <use> references) so nested button artwork can be located in
// stage space.

export function parseSvgMatrix(transform: string | null): DOMMatrix {
  if (!transform) return new DOMMatrix();
  const match = transform.match(/matrix\(([^)]+)\)/);
  if (!match) return new DOMMatrix();
  const parts = match[1].split(/[\s,]+/).filter(Boolean).map((part) => Number.parseFloat(part));
  if (parts.length !== 6 || parts.some((part) => !Number.isFinite(part))) return new DOMMatrix();
  return new DOMMatrix(parts);
}

export function svgHref(element: Element): string {
  return (
    element.getAttribute("href") ??
    element.getAttribute("xlink:href") ??
    element.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
    ""
  );
}

export function ffdecCharacterId(element: Element): string {
  const namespaced =
    element.getAttribute("ffdec:characterId") ??
    element.getAttributeNS("https://www.free-decompiler.com/flash", "characterId");
  if (namespaced) return namespaced;
  for (const attribute of [...element.attributes]) {
    if (attribute.name.toLowerCase().endsWith("characterid")) return attribute.value;
  }
  return "";
}

export function matrixToSvg(matrix: DOMMatrix): string {
  return `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f})`;
}

/**
 * Prefix every internal id (and its #ref / url(#ref) uses) in an SVG string so
 * that multiple inline SVGs on the same page can't collide. FFDec reuses ids
 * like "shape1" across symbols, so without this `<use href="#id">` resolves
 * document-wide to the wrong element and nested art renders incompletely.
 */
export function namespaceSvgIds(svgText: string, prefix: string): string {
  const ids = new Set<string>();
  for (const match of svgText.matchAll(/\sid="([^"]+)"/g)) ids.add(match[1]);
  if (!ids.size) return svgText;

  let out = svgText;
  for (const id of ids) {
    const safe = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out
      .replace(new RegExp(`\\sid="${safe}"`, "g"), ` id="${prefix}${id}"`)
      .replace(new RegExp(`href="#${safe}"`, "g"), `href="#${prefix}${id}"`)
      .replace(new RegExp(`url\\(#${safe}\\)`, "g"), `url(#${prefix}${id})`);
  }
  return out;
}

export function walkVisibleSvgTree(
  element: Element,
  matrix: DOMMatrix,
  visit: (element: Element, matrix: DOMMatrix) => void,
  seen = new Set<string>(),
) {
  const nextMatrix = matrix.multiply(parseSvgMatrix(element.getAttribute("transform")));
  visit(element, nextMatrix);

  const href = svgHref(element);
  if (href.startsWith("#")) {
    const id = href.slice(1);
    if (seen.has(id)) return;
    const referenced = element.ownerDocument.getElementById(id);
    if (referenced) {
      const nextSeen = new Set(seen);
      nextSeen.add(id);
      for (const child of [...referenced.children]) {
        walkVisibleSvgTree(child, nextMatrix, visit, nextSeen);
      }
    }
  }

  if (element.tagName.toLowerCase() !== "use") {
    for (const child of [...element.children]) {
      if (child.tagName.toLowerCase() === "defs") continue;
      walkVisibleSvgTree(child, nextMatrix, visit, seen);
    }
  }
}
