// Pure SVG/DOM helpers for the Direct SWF renderer: id uniquification, content-group
// wrapping, offset extraction, descendant SVG target collection, element offset.

export function getElementOffset(element: HTMLElement): { x: number; y: number } {
  return {
    x: parseFloat(element.dataset.offsetX || '0'),
    y: parseFloat(element.dataset.offsetY || '0'),
  };
}

export function getDescendantSvgTargets(element: HTMLElement): Array<{ svg: SVGSVGElement; group: SVGGElement }> {
  return Array.from(element.querySelectorAll('svg'))
    .map((svg) => {
      const group = Array.from(svg.children).find((child) => {
        return child instanceof SVGGElement && child.classList.contains('swf-content');
      }) as SVGGElement | undefined;
      if (!group) return null;
      return {
        svg: svg as SVGSVGElement,
        group,
      };
    })
    .filter((target): target is { svg: SVGSVGElement; group: SVGGElement } => target !== null);
}

export function makeIdsUnique(svg: Element, prefix: string) {
  const idMap = new Map<string, string>();

  svg.querySelectorAll('[id]').forEach((el) => {
    const oldId = el.getAttribute('id');
    if (!oldId) return;
    const newId = `${prefix}-${oldId}`;
    el.setAttribute('id', newId);
    idMap.set(oldId, newId);
  });

  svg.querySelectorAll('*').forEach((el) => {
    for (const attr of ['fill', 'stroke', 'clip-path', 'mask', 'filter']) {
      const value = el.getAttribute(attr);
      if (!value?.startsWith('url(#')) continue;

      const oldId = value.match(/url\(#([^)]+)\)/)?.[1];
      if (oldId && idMap.has(oldId)) {
        el.setAttribute(attr, `url(#${idMap.get(oldId)})`);
      }
    }

    const style = el.getAttribute('style');
    if (style?.includes('url(#')) {
      const updatedStyle = style.replace(/url\(#([^)]+)\)/g, (full, oldId: string) => {
        return idMap.has(oldId) ? `url(#${idMap.get(oldId)})` : full;
      });
      el.setAttribute('style', updatedStyle);
    }

    for (const attr of ['href', 'xlink:href']) {
      const value = el.getAttribute(attr);
      if (!value?.startsWith('#')) continue;

      const oldId = value.slice(1);
      if (idMap.has(oldId)) {
        el.setAttribute(attr, `#${idMap.get(oldId)}`);
      }
    }
  });
}

export function ensureSvgContentGroup(svg: SVGSVGElement): SVGGElement {
  const existing = svg.querySelector('g.swf-content');
  if (existing) {
    return existing as SVGGElement;
  }

  const contentGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  contentGroup.setAttribute('class', 'swf-content');

  const nodesToMove = Array.from(svg.childNodes).filter((node) => {
    return !(node instanceof SVGDefsElement);
  });

  for (const node of nodesToMove) {
    contentGroup.appendChild(node);
  }

  svg.appendChild(contentGroup);
  return contentGroup;
}

export function extractSvgOffset(
  svg: SVGSVGElement,
  fallback: { x: number; y: number },
): { x: number; y: number } {
  if (svg.getAttribute('data-swf-use-bounds-offset') === 'true') {
    return fallback;
  }

  const contentGroup = svg.querySelector('g.swf-content');
  const transform = contentGroup?.getAttribute('transform');
  if (transform) {
    const match = transform.match(
      /matrix\([^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([^,]+),\s*([^)]+)\)/,
    );
    if (match) {
      return {
        x: parseFloat(match[1]),
        y: parseFloat(match[2]),
      };
    }
  }

  const viewBox = svg.getAttribute('viewBox');
  if (viewBox) {
    const [minX, minY] = viewBox.split(/[\s,]+/).slice(0, 2).map(Number);
    if (Number.isFinite(minX) && Number.isFinite(minY)) {
      return {
        x: -minX,
        y: -minY,
      };
    }
  }

  return fallback;
}
