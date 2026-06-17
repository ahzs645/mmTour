// DOM element construction from parsed SWF characters (shapes, images, fonts).

import type { SwfFontChar, SwfImageChar, SwfShapeChar } from "./SwfParser";
import { ensureSvgContentGroup, extractSvgOffset, makeIdsUnique } from "./svgDom";

const loadedFontFaces = new Map<string, Promise<void>>();

export function createShapeElement(char: SwfShapeChar, depth: number): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'swf-shape';
  wrapper.dataset.charId = String(char.id);
  wrapper.dataset.depth = String(depth);
  wrapper.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;';

  const parser = new DOMParser();
  const doc = parser.parseFromString(char.svgPaths, 'image/svg+xml');
  const svg = doc.documentElement as unknown as SVGSVGElement;
  ensureSvgContentGroup(svg);
  makeIdsUnique(svg, `swf-shape-${char.id}-depth-${depth}`);
  const offset = extractSvgOffset(svg, {
    x: -char.bounds.xMin,
    y: -char.bounds.yMin,
  });
  wrapper.dataset.offsetX = String(offset.x);
  wrapper.dataset.offsetY = String(offset.y);
  wrapper.style.transformOrigin = `${offset.x}px ${offset.y}px`;
  svg.style.overflow = 'visible';
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  wrapper.appendChild(svg);

  return wrapper;
}

export function createImageElement(char: SwfImageChar, _depth?: number): HTMLElement {
  void _depth;
  const wrapper = document.createElement('div');
  wrapper.className = 'swf-image';
  wrapper.dataset.charId = String(char.id);
  wrapper.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;';

  const img = document.createElement('img');
  img.src = char.dataUrl;
  img.width = char.width;
  img.height = char.height;
  img.draggable = false;
  img.onerror = () => { wrapper.style.display = 'none'; };

  wrapper.appendChild(img);
  return wrapper;
}

export function ensureFontFace(font: SwfFontChar) {
  if (!font.assetUrl || !font.cssFamily || typeof FontFace === 'undefined') {
    return;
  }

  const cacheKey = `${font.cssFamily}::${font.assetUrl}`;
  if (loadedFontFaces.has(cacheKey)) {
    return;
  }

  const fontFace = new FontFace(font.cssFamily, `url("${font.assetUrl}")`, {
    style: font.isItalic ? 'italic' : 'normal',
    weight: font.isBold ? '700' : '400',
  });

  loadedFontFaces.set(cacheKey, fontFace.load()
    .then((loadedFace) => {
      document.fonts.add(loadedFace);
    })
    .catch(() => {
      loadedFontFaces.delete(cacheKey);
    }));
}
