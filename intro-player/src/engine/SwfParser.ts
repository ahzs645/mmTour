/**
 * SwfParser - Parses SWF binary using swf-parser and produces
 * structured data ready for GSAP timeline construction.
 */

// ===== Output Types =====

export interface SwfMovie {
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  backgroundColor: string;
  characters: Map<number, SwfCharacter>;
  frames: SwfFrame[];
}

export type SwfCharacter =
  | SwfShapeChar
  | SwfSpriteChar
  | SwfImageChar
  | SwfTextChar
  | SwfFontChar;

export interface SwfShapeChar {
  type: 'shape';
  id: number;
  bounds: SwfRect;
  svgPaths: string; // Pre-rendered SVG content
}

export interface SwfSpriteChar {
  type: 'sprite';
  id: number;
  frameCount: number;
  frames: SwfFrame[];
  imageUrl?: string;
}

export interface SwfImageChar {
  type: 'image';
  id: number;
  width: number;
  height: number;
  dataUrl: string;
}

export interface SwfTextChar {
  type: 'text';
  id: number;
  text: string;
  color: string;
  fontSize: number;
  fontId: number;
  bounds: SwfRect;
  align: number;
  variableName: string;
}

export interface SwfFontChar {
  type: 'font';
  id: number;
  fontName: string;
  isBold: boolean;
  isItalic: boolean;
}

export interface SwfRect {
  xMin: number; xMax: number; yMin: number; yMax: number;
}

export interface SwfFrame {
  placements: SwfPlacement[];
  removals: number[];
}

export interface SwfPlacement {
  depth: number;
  characterId?: number;
  isUpdate: boolean;
  matrix?: SwfMatrix;
  colorTransform?: SwfColorTransform;
  clipDepth?: number;
  ratio?: number;
  name?: string;
}

export interface SwfMatrix {
  a: number; b: number; c: number; d: number; tx: number; ty: number;
}

export interface SwfColorTransform {
  rm: number; gm: number; bm: number; am: number;
  ra: number; ga: number; ba: number; aa: number;
}

// ===== Fixed Point Helpers =====

function fp16(epsilons: number): number {
  return epsilons / 65536;
}

function twipsToPixels(twips: number): number {
  return twips / 20;
}

function rgbaToHex(r: number, g: number, b: number, a?: number): string {
  if (a !== undefined && a < 255) {
    return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
  }
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ===== Shape to SVG Converter =====

interface FillStyle {
  type: number;
  color?: { r: number; g: number; b: number; a: number };
  gradient?: {
    colors: Array<{ ratio: number; color: { r: number; g: number; b: number; a: number } }>;
  };
  matrix?: Record<string, unknown>;
}

function shapeToSvg(
  shapeData: { initialStyles: { fill: FillStyle[]; line: unknown[] }; records: unknown[] },
  bounds: SwfRect,
): string {
  const fills = shapeData.initialStyles?.fill || [];
  const width = twipsToPixels(bounds.xMax - bounds.xMin);
  const height = twipsToPixels(bounds.yMax - bounds.yMin);
  const offsetX = twipsToPixels(bounds.xMin);
  const offsetY = twipsToPixels(bounds.yMin);

  // Build SVG paths from shape records
  let currentPath = '';
  let currentFill0 = 0;
  let currentFill1 = 0;
  let curX = 0, curY = 0;

  // Track all paths per fill index
  const fillPaths = new Map<number, string[]>();
  const activeFills: FillStyle[] = [...fills];
  let gradientDefs = '';
  let gradientCount = 0;

  for (const rec of shapeData.records as Array<Record<string, unknown>>) {
    const type = rec.type as number;

    if (type === 1) {
      // StyleChange record
      // Flush current path segments
      if (currentPath) {
        if (currentFill0 > 0) {
          const arr = fillPaths.get(currentFill0) || [];
          arr.push(currentPath);
          fillPaths.set(currentFill0, arr);
        }
        if (currentFill1 > 0) {
          const arr = fillPaths.get(currentFill1) || [];
          arr.push(currentPath);
          fillPaths.set(currentFill1, arr);
        }
      }
      currentPath = '';

      if (rec.moveTo) {
        const mt = rec.moveTo as { x: number; y: number };
        curX = mt.x;
        curY = mt.y;
      }
      // Always start a new sub-path with M at current position
      currentPath = `M${twipsToPixels(curX).toFixed(2)} ${twipsToPixels(curY).toFixed(2)}`;

      if (rec.leftFill !== undefined) currentFill0 = rec.leftFill as number;
      if (rec.rightFill !== undefined) currentFill1 = rec.rightFill as number;
      // Handle new styles mid-shape
      if (rec.newStyles) {
        const ns = rec.newStyles as { fill: FillStyle[]; line: unknown[] };
        // Reset fill indices - new styles replace previous ones
        activeFills.length = 0;
        activeFills.push(...(ns.fill || []));
      }
    } else if (type === 0) {
      // Edge record (straight or curved)
      // Ensure path has a starting M command
      if (!currentPath) {
        currentPath = `M${twipsToPixels(curX).toFixed(2)} ${twipsToPixels(curY).toFixed(2)}`;
      }
      if (rec.controlDelta && rec.delta) {
        // Curved edge (quadratic bezier)
        // controlDelta = control point offset, delta = anchor point offset from control
        const cd = rec.controlDelta as { x: number; y: number };
        const ad = rec.delta as { x: number; y: number };
        const cx = curX + cd.x;
        const cy = curY + cd.y;
        const ax = cx + ad.x;
        const ay = cy + ad.y;
        currentPath += ` Q${twipsToPixels(cx).toFixed(2)} ${twipsToPixels(cy).toFixed(2)} ${twipsToPixels(ax).toFixed(2)} ${twipsToPixels(ay).toFixed(2)}`;
        curX = ax;
        curY = ay;
      } else if (rec.delta) {
        // Straight edge
        const d = rec.delta as { x: number; y: number };
        curX += d.x;
        curY += d.y;
        currentPath += ` L${twipsToPixels(curX).toFixed(2)} ${twipsToPixels(curY).toFixed(2)}`;
      }
    }
  }

  // Flush final path
  if (currentPath) {
    if (currentFill0 > 0) {
      const arr = fillPaths.get(currentFill0) || [];
      arr.push(currentPath);
      fillPaths.set(currentFill0, arr);
    }
    if (currentFill1 > 0) {
      const arr = fillPaths.get(currentFill1) || [];
      arr.push(currentPath);
      fillPaths.set(currentFill1, arr);
    }
  }

  // Generate SVG paths with fills
  let svgPaths = '';
  for (const [fillIdx, pathSegments] of fillPaths) {
    const fillStyle = activeFills[fillIdx - 1]; // 1-indexed
    if (!fillStyle) continue;

    const d = pathSegments.join(' ');
    let fill = 'none';

    if (fillStyle.type === 0 || fillStyle.type === 4) {
      // Solid color
      const c = fillStyle.color;
      if (c) {
        fill = c.a < 255
          ? `rgba(${c.r},${c.g},${c.b},${(c.a / 255).toFixed(3)})`
          : rgbaToHex(c.r, c.g, c.b);
      }
    } else if (fillStyle.type === 1 || fillStyle.type === 2 || fillStyle.type === 3) {
      // Gradient (linear=1, radial=2, focal=3)
      const gradId = `grad_${gradientCount++}`;
      const grad = fillStyle.gradient;
      if (grad) {
        const stops = (grad.colors || [])
          .map((s: { ratio: number; color: { r: number; g: number; b: number; a: number } }) =>
            `<stop offset="${(s.ratio / 255 * 100).toFixed(1)}%" stop-color="${rgbaToHex(s.color.r, s.color.g, s.color.b)}" stop-opacity="${(s.color.a / 255).toFixed(3)}"/>`
          ).join('');

        if (fillStyle.type === 1) {
          // Linear gradient - use matrix for transform
          const m = fillStyle.matrix as Record<string, unknown> | undefined;
          let gradTransform = '';
          if (m) {
            const sx = fp16((m.scaleX as { epsilons: number })?.epsilons || 65536);
            const sy = fp16((m.scaleY as { epsilons: number })?.epsilons || 65536);
            const r0 = fp16((m.rotateSkew0 as { epsilons: number })?.epsilons || 0);
            const r1 = fp16((m.rotateSkew1 as { epsilons: number })?.epsilons || 0);
            const tx = twipsToPixels((m.translateX as number) || 0);
            const ty = twipsToPixels((m.translateY as number) || 0);
            gradTransform = ` gradientTransform="matrix(${sx},${r0},${r1},${sy},${tx},${ty})"`;
          }
          gradientDefs += `<linearGradient id="${gradId}" gradientUnits="userSpaceOnUse" x1="${twipsToPixels(-16384)}" x2="${twipsToPixels(16384)}"${gradTransform}>${stops}</linearGradient>`;
        } else {
          // Radial gradient
          const m = fillStyle.matrix as Record<string, unknown> | undefined;
          let gradTransform = '';
          if (m) {
            const sx = fp16((m.scaleX as { epsilons: number })?.epsilons || 65536);
            const sy = fp16((m.scaleY as { epsilons: number })?.epsilons || 65536);
            const r0 = fp16((m.rotateSkew0 as { epsilons: number })?.epsilons || 0);
            const r1 = fp16((m.rotateSkew1 as { epsilons: number })?.epsilons || 0);
            const tx = twipsToPixels((m.translateX as number) || 0);
            const ty = twipsToPixels((m.translateY as number) || 0);
            gradTransform = ` gradientTransform="matrix(${sx},${r0},${r1},${sy},${tx},${ty})"`;
          }
          gradientDefs += `<radialGradient id="${gradId}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${twipsToPixels(16384)}"${gradTransform}>${stops}</radialGradient>`;
        }
        fill = `url(#${gradId})`;
      }
    }

    svgPaths += `<path d="${d}" fill="${fill}" fill-rule="evenodd" stroke="none"/>`;
  }

  const defs = gradientDefs ? `<defs>${gradientDefs}</defs>` : '';

  // No viewBox - paths use natural twips-to-pixel coordinates.
  // The PlaceObject CSS matrix handles all positioning on stage.
  // Width/height set large enough to contain any shape; overflow:visible ensures nothing is clipped.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(2)}" height="${height.toFixed(2)}" style="overflow:visible;position:absolute;left:0;top:0;width:${width.toFixed(2)}px;height:${height.toFixed(2)}px">${defs}<g class="swf-content" transform="matrix(1, 0, 0, 1, ${(-offsetX).toFixed(2)}, ${(-offsetY).toFixed(2)})">${svgPaths}</g></svg>`;
}

const extractedShapeCache = new Map<string, Promise<string | null>>();
const extractedSpriteCache = new Map<string, Promise<string | null>>();

function getExtractedAssetBase(swfUrl: string, assetType: 'shapes' | 'sprites'): string | null {
  const pathname = (() => {
    try {
      return new URL(swfUrl, window.location.href).pathname;
    } catch {
      return swfUrl;
    }
  })();

  const basePath = (() => {
    switch (pathname) {
      case '/intro.swf':
        return '/intro';
      case '/nav.swf':
        return '/nav';
      case '/segment1.swf':
        return '/segment-assets/1';
      case '/segment3.swf':
        return '/segment-assets/3';
      case '/segment4.swf':
        return '/segment-assets/4';
      case '/segment5.swf':
        return '/segment-assets/5';
      default:
        return null;
    }
  })();

  return basePath ? `${basePath}/${assetType}` : null;
}

function getExtractedShapeBase(swfUrl: string): string | null {
  return getExtractedAssetBase(swfUrl, 'shapes');
}

function getExtractedSpriteBase(swfUrl: string): string | null {
  return getExtractedAssetBase(swfUrl, 'sprites');
}

function normalizeExtractedShapeSvg(svgText: string): string {
  const withoutXml = svgText.replace(/<\?xml[\s\S]*?\?>\s*/i, '');
  return withoutXml.replace(/<g(\s|>)/, '<g class="swf-content"$1');
}

async function loadExtractedShapeSvg(basePath: string | null, id: number): Promise<string | null> {
  if (!basePath) return null;

  const url = `${basePath}/${id}.svg`;
  const cached = extractedShapeCache.get(url);
  if (cached) {
    return cached;
  }

  const request = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }
      const svgText = await response.text();
      if (!/<svg[\s>]/i.test(svgText)) {
        return null;
      }
      return normalizeExtractedShapeSvg(svgText);
    } catch {
      return null;
    }
  })();

  extractedShapeCache.set(url, request);
  return request;
}

async function loadExtractedSpriteUrl(basePath: string | null, id: number): Promise<string | null> {
  if (!basePath) return null;

  const url = `${basePath}/${id}.png`;
  const cached = extractedSpriteCache.get(url);
  if (cached) {
    return cached;
  }

  const request = (async () => {
    try {
      const response = await fetch(url);
      return response.ok ? url : null;
    } catch {
      return null;
    }
  })();

  extractedSpriteCache.set(url, request);
  return request;
}

// ===== Main Parser =====

export async function parseSwfFile(url: string): Promise<SwfMovie> {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Dynamic import to avoid bundling issues
  const { parseSwf } = await import('swf-parser');
  const movie = parseSwf(bytes);

  const header = movie.header;
  const width = twipsToPixels(header.frameSize.xMax);
  const height = twipsToPixels(header.frameSize.yMax);
  const frameRate = header.frameRate.epsilons / 256;
  const extractedShapeBase = getExtractedShapeBase(url);
  const extractedSpriteBase = getExtractedSpriteBase(url);

  const characters = new Map<number, SwfCharacter>();
  const frames: SwfFrame[] = [];
  const pendingCharacters: Array<Promise<void>> = [];
  let currentFrame: SwfFrame = { placements: [], removals: [] };
  let bgColor = '#ffffff';

  for (const tag of movie.tags) {
    switch (tag.type) {
      case 56: {
        // SetBackgroundColor
        const c = tag.color as { r: number; g: number; b: number };
        bgColor = rgbaToHex(c.r, c.g, c.b);
        break;
      }

      case 22: {
        // DefineShape
        const shapeTag = tag as { id: number; bounds: SwfRect; shape: unknown };
        const bounds = {
          xMin: shapeTag.bounds.xMin,
          xMax: shapeTag.bounds.xMax,
          yMin: shapeTag.bounds.yMin,
          yMax: shapeTag.bounds.yMax,
        };
        const pixelBounds = {
          xMin: twipsToPixels(bounds.xMin),
          xMax: twipsToPixels(bounds.xMax),
          yMin: twipsToPixels(bounds.yMin),
          yMax: twipsToPixels(bounds.yMax),
        };
        const generatedSvg = shapeToSvg(shapeTag.shape as Parameters<typeof shapeToSvg>[0], bounds);
        pendingCharacters.push((async () => {
          const svgPaths = await loadExtractedShapeSvg(extractedShapeBase, shapeTag.id) ?? generatedSvg;
          characters.set(shapeTag.id, {
            type: 'shape',
            id: shapeTag.id,
            bounds: pixelBounds,
            svgPaths,
          });
        })());
        break;
      }

      case 24: {
        // DefineSprite
        const spriteTag = tag as unknown as {
          id: number;
          frameCount: number;
          tags: ReadonlyArray<Record<string, unknown>>;
        };
        const spriteFrames: SwfFrame[] = [];
        let spriteFrame: SwfFrame = { placements: [], removals: [] };

        for (const subTag of (spriteTag.tags || [])) {
          if (subTag.type === 49) {
            spriteFrame.placements.push(parsePlacement(subTag as unknown as Record<string, unknown>));
          } else if (subTag.type === 54) {
            spriteFrame.removals.push(subTag.depth as number);
          } else if (subTag.type === 58) {
            spriteFrames.push(spriteFrame);
            spriteFrame = { placements: [], removals: [] };
          }
          // Shapes inside sprites
          if (subTag.type === 22 && (subTag as { shape?: unknown }).shape) {
            const st = subTag as { id: number; bounds: SwfRect; shape: unknown };
            const pixelBounds = {
              xMin: twipsToPixels(st.bounds.xMin),
              xMax: twipsToPixels(st.bounds.xMax),
              yMin: twipsToPixels(st.bounds.yMin),
              yMax: twipsToPixels(st.bounds.yMax),
            };
            const generatedSvg = shapeToSvg(st.shape as Parameters<typeof shapeToSvg>[0], st.bounds);
            pendingCharacters.push((async () => {
              const svgPaths = await loadExtractedShapeSvg(extractedShapeBase, st.id) ?? generatedSvg;
              characters.set(st.id, {
                type: 'shape',
                id: st.id,
                bounds: pixelBounds,
                svgPaths,
              });
            })());
          }
        }

        pendingCharacters.push((async () => {
          const imageUrl = await loadExtractedSpriteUrl(extractedSpriteBase, spriteTag.id);
          characters.set(spriteTag.id, {
            type: 'sprite',
            id: spriteTag.id,
            frameCount: spriteTag.frameCount,
            frames: spriteFrames,
            imageUrl: imageUrl ?? undefined,
          });
        })());
        break;
      }

      case 5: {
        // DefineBitsJPEG / Image
        const imgTag = tag as { id: number; width: number; height: number; mediaType: string; data: Uint8Array };
        if (imgTag.id && imgTag.data) {
          const buffer = imgTag.data.buffer.slice(
            imgTag.data.byteOffset,
            imgTag.data.byteOffset + imgTag.data.byteLength
          ) as ArrayBuffer;
          const blob = new Blob([buffer], { type: imgTag.mediaType || 'image/jpeg' });
          characters.set(imgTag.id, {
            type: 'image',
            id: imgTag.id,
            width: imgTag.width,
            height: imgTag.height,
            dataUrl: URL.createObjectURL(blob),
          });
        }
        break;
      }

      case 11: {
        // DefineEditText / TextField
        const txtTag = tag as {
          id: number; text: string; color: { r: number; g: number; b: number; a: number };
          fontSize: number; fontId: number; bounds: SwfRect; align: number; variableName: string;
        };
        characters.set(txtTag.id, {
          type: 'text',
          id: txtTag.id,
          text: (txtTag.text || '').replace(/\r/g, '\n'),
          color: rgbaToHex(txtTag.color?.r || 0, txtTag.color?.g || 0, txtTag.color?.b || 0),
          fontSize: twipsToPixels(txtTag.fontSize || 240),
          fontId: txtTag.fontId,
          bounds: {
            xMin: twipsToPixels(txtTag.bounds?.xMin || 0),
            xMax: twipsToPixels(txtTag.bounds?.xMax || 0),
            yMin: twipsToPixels(txtTag.bounds?.yMin || 0),
            yMax: twipsToPixels(txtTag.bounds?.yMax || 0),
          },
          align: txtTag.align || 0,
          variableName: txtTag.variableName || '',
        });
        break;
      }

      case 12: {
        // DefineFont
        const fontTag = tag as { id: number; fontName: string; isBold: boolean; isItalic: boolean };
        characters.set(fontTag.id, {
          type: 'font',
          id: fontTag.id,
          fontName: fontTag.fontName,
          isBold: fontTag.isBold,
          isItalic: fontTag.isItalic,
        });
        break;
      }

      case 49: {
        // PlaceObject
        currentFrame.placements.push(parsePlacement(tag as unknown as Record<string, unknown>));
        break;
      }

      case 54: {
        // RemoveObject
        currentFrame.removals.push((tag as { depth: number }).depth);
        break;
      }

      case 58: {
        // ShowFrame
        frames.push(currentFrame);
        currentFrame = { placements: [], removals: [] };
        break;
      }
    }
  }

  await Promise.all(pendingCharacters);

  return {
    width,
    height,
    frameRate,
    frameCount: frames.length,
    backgroundColor: bgColor,
    characters,
    frames,
  };
}

function parsePlacement(tag: Record<string, unknown>): SwfPlacement {
  const placement: SwfPlacement = {
    depth: tag.depth as number,
    isUpdate: tag.isUpdate as boolean || false,
  };

  if (tag.characterId !== undefined && tag.characterId !== null) {
    placement.characterId = tag.characterId as number;
  }

  if (tag.matrix) {
    const m = tag.matrix as Record<string, unknown>;
    placement.matrix = {
      a: fp16((m.scaleX as { epsilons: number })?.epsilons ?? 65536),
      b: fp16((m.rotateSkew0 as { epsilons: number })?.epsilons ?? 0),
      c: fp16((m.rotateSkew1 as { epsilons: number })?.epsilons ?? 0),
      d: fp16((m.scaleY as { epsilons: number })?.epsilons ?? 65536),
      tx: twipsToPixels((m.translateX as number) ?? 0),
      ty: twipsToPixels((m.translateY as number) ?? 0),
    };
  }

  if (tag.colorTransform) {
    const ct = tag.colorTransform as Record<string, { epsilons: number } | number>;
    const mult = (value: { epsilons: number } | number | undefined) => {
      if (typeof value === 'object' && value && 'epsilons' in value) {
        return value.epsilons / 256;
      }
      return typeof value === 'number' ? value / 256 : 1;
    };
    placement.colorTransform = {
      rm: mult(ct.redMult as { epsilons: number } | number | undefined),
      gm: mult(ct.greenMult as { epsilons: number } | number | undefined),
      bm: mult(ct.blueMult as { epsilons: number } | number | undefined),
      am: mult(ct.alphaMult as { epsilons: number } | number | undefined),
      ra: (ct.redAdd as number) ?? 0,
      ga: (ct.greenAdd as number) ?? 0,
      ba: (ct.blueAdd as number) ?? 0,
      aa: (ct.alphaAdd as number) ?? 0,
    };
  }

  if (tag.clipDepth) {
    placement.clipDepth = tag.clipDepth as number;
  }

  if (typeof tag.ratio === 'number') {
    placement.ratio = tag.ratio;
  }

  if (tag.name) {
    placement.name = tag.name as string;
  }

  return placement;
}
