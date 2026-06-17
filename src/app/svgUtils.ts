// Pure SVG/matrix helpers shared by the frame/direct comparison render modes.
// No module state — every function is a pure transform over its inputs.

import type { Matrix } from "./frameModeTypes";

export function walkVisibleSvgTree(
  element: Element,
  matrix: DOMMatrix,
  visit: (element: Element, matrix: DOMMatrix) => void,
  seen = new Set<string>(),
) {
  const nextMatrix = matrix.multiply(parseSvgMatrix(element.getAttribute("transform")));
  visit(element, nextMatrix);

  const href = svgHref(element);
  if (href?.startsWith("#")) {
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

export function parseSvgMatrix(transform: string | null) {
  if (!transform) return new DOMMatrix();
  const match = transform.match(/matrix\(([^)]+)\)/);
  if (!match) return new DOMMatrix();
  const parts = match[1].split(/[\s,]+/).filter(Boolean).map((part) => Number.parseFloat(part));
  if (parts.length !== 6 || parts.some((part) => !Number.isFinite(part))) return new DOMMatrix();
  return new DOMMatrix(parts);
}

export function svgHref(element: Element) {
  return (
    element.getAttribute("href") ??
    element.getAttribute("xlink:href") ??
    element.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
    ""
  );
}

export function ffdecCharacterId(element: Element) {
  const namespaced = element.getAttribute("ffdec:characterId") ?? element.getAttributeNS("https://www.free-decompiler.com/flash", "characterId");
  if (namespaced) return namespaced;

  for (const attribute of [...element.attributes]) {
    if (attribute.name.toLowerCase().endsWith("characterid")) return attribute.value;
  }

  return "";
}

export function matrixToSvg(matrix: DOMMatrix) {
  return `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f})`;
}

export function timelineMatrixToSvg(matrix: Matrix) {
  return `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.tx}, ${matrix.ty})`;
}

export function timelineMatrixToDomMatrix(matrix: Matrix) {
  return new DOMMatrix([matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty]);
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]!));
}
