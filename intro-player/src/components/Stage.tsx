import { useMemo, useRef, useState, useEffect } from 'react';
import type { DisplayObject, ClipRange, Transform, CharacterData } from '../types';
import { SpriteElement } from './SpriteElement';

interface StageProps {
  width: number;
  height: number;
  displayList: Record<number, DisplayObject>;
  svgCache: Record<string, string>;
  spriteImages: Record<string, string>;
  characters: Record<string, CharacterData>;
  disableColorTransforms?: boolean;
  highlightedDepth?: number | null;
}

const DEFAULT_TRANSFORM: Transform = {
  sx: 1, sy: 1, r0: 0, r1: 0, tx: 0, ty: 0
};

interface MaskInfo extends ClipRange {
  maskCharacterId: string;
  maskDepth: number;
}

// Extract path data from SVG content
function extractPathData(svgContent: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, 'image/svg+xml');
  const path = doc.querySelector('path');
  return path?.getAttribute('d') || null;
}

// Check if SVG has any visible content
function hasVisibleContent(svgContent: string): boolean {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, 'image/svg+xml');
  return doc.querySelector('path, rect, circle, ellipse, polygon, polyline, image, use') !== null;
}

// Extract the internal transform offset from SVG
function extractSvgOffset(svgContent: string): { x: number; y: number } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, 'image/svg+xml');
  const g = doc.querySelector('g[transform]');
  if (g) {
    const transform = g.getAttribute('transform');
    const match = transform?.match(/matrix\([^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([^,]+),\s*([^)]+)\)/);
    if (match) {
      return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
    }
  }
  return { x: 0, y: 0 };
}

// Combine two transforms (outer * inner)
function combineTransforms(outer: Transform, inner: Transform): Transform {
  return {
    sx: outer.sx * inner.sx,
    sy: outer.sy * inner.sy,
    r0: outer.r0 * inner.sx + outer.sx * inner.r0,
    r1: outer.r1 * inner.sy + outer.sy * inner.r1,
    tx: outer.tx + outer.sx * inner.tx + outer.r1 * inner.ty,
    ty: outer.ty + outer.r0 * inner.tx + outer.sy * inner.ty,
  };
}

export function Stage({ width, height, displayList, svgCache, spriteImages, characters, disableColorTransforms, highlightedDepth }: StageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const updateScale = () => {
      // Find the stage-wrapper element
      const stageWrapper = document.querySelector('.stage-wrapper');
      if (stageWrapper) {
        const rect = stageWrapper.getBoundingClientRect();
        const availableWidth = rect.width - 80;
        const availableHeight = rect.height - 80;
        if (availableWidth > 0 && availableHeight > 0) {
          const scaleX = availableWidth / width;
          const scaleY = availableHeight / height;
          setScale(Math.min(scaleX, scaleY));
        }
      }
    };

    // Use ResizeObserver on stage-wrapper
    const stageWrapper = document.querySelector('.stage-wrapper');
    if (stageWrapper) {
      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(updateScale);
      });
      resizeObserver.observe(stageWrapper);
      requestAnimationFrame(updateScale);
      return () => resizeObserver.disconnect();
    }
  }, [width, height]);

  const { sortedElements, masks } = useMemo(() => {
    const depths = Object.keys(displayList).map(Number).sort((a, b) => a - b);
    const maskList: MaskInfo[] = [];
    for (const depth of depths) {
      const obj = displayList[depth];
      if (obj?.clipDepth) {
        maskList.push({
          start: depth + 1,
          end: obj.clipDepth,
          maskTransform: obj.transform,
          maskCharacterId: obj.characterId,
          maskDepth: depth
        });
      }
    }
    return { sortedElements: depths, masks: maskList };
  }, [displayList]);

  const getMaskForDepth = (depth: number): MaskInfo | null => {
    return masks.find(m => depth >= m.start && depth <= m.end) || null;
  };

  // Calculate scaled dimensions
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;

  return (
    <div
      ref={containerRef}
      className="stage"
      style={{
        width: `${scaledWidth}px`,
        height: `${scaledHeight}px`,
        overflow: 'hidden',
        background: '#fff',
        boxShadow: '0 4px 30px rgba(0, 0, 0, 0.5)',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: `${width}px`,
          height: `${height}px`,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        <svg width="0" height="0" style={{ position: 'absolute' }}>
          <defs>
            {masks.map(mask => {
              const maskSvg = svgCache[mask.maskCharacterId];
              if (!maskSvg) return null;
              const pathData = extractPathData(maskSvg);
              if (!pathData) return null;
              const svgOffset = extractSvgOffset(maskSvg);
              const t = mask.maskTransform || DEFAULT_TRANSFORM;
              const adjustedTx = t.tx - svgOffset.x;
              const adjustedTy = t.ty - svgOffset.y;
              return (
                <clipPath
                  key={`clip-${mask.maskDepth}`}
                  id={`clip-${mask.maskDepth}`}
                  clipPathUnits="userSpaceOnUse"
                >
                  <path
                    d={pathData}
                    transform={`matrix(${t.sx}, ${t.r0}, ${t.r1}, ${t.sy}, ${adjustedTx + svgOffset.x}, ${adjustedTy + svgOffset.y})`}
                  />
                </clipPath>
              );
            })}
          </defs>
        </svg>

        {sortedElements.map(depth => {
          const obj = displayList[depth];
          if (!obj) return null;
          if (obj.clipDepth) return null;

          const charInfo = characters[obj.characterId];
          const t = obj.transform || DEFAULT_TRANSFORM;

          // Check if this is a sprite with a pre-rendered PNG image
          const spriteImage = spriteImages[obj.characterId];
          const isHighlighted = highlightedDepth === depth;
          if (charInfo?.type === 'sprite' && spriteImage) {
            const am = obj.colorTransform?.am ?? 1;
            return (
              <div
                key={`sprite-${depth}-${obj.characterId}`}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  zIndex: depth,
                  transform: `matrix(${t.sx}, ${t.r0}, ${t.r1}, ${t.sy}, ${t.tx}, ${t.ty})`,
                  transformOrigin: '0 0',
                  pointerEvents: 'none',
                }}
              >
                <img
                  src={spriteImage}
                  alt={`sprite-${obj.characterId}`}
                  style={{
                    opacity: disableColorTransforms ? 1 : am,
                    outline: isHighlighted ? '3px solid #0ff' : undefined,
                    outlineOffset: '-1px',
                  }}
                />
                {isHighlighted && (
                  <div style={{
                    position: 'absolute',
                    top: -20,
                    left: 0,
                    background: '#0ff',
                    color: '#000',
                    padding: '2px 6px',
                    fontSize: 10,
                    fontWeight: 'bold',
                    borderRadius: 3,
                    whiteSpace: 'nowrap'
                  }}>
                    Depth {depth} - Sprite #{obj.characterId}
                  </div>
                )}
              </div>
            );
          }

          // Fall back to SVG rendering for shapes
          let shapeId = obj.characterId;
          let shapeTransform = t;

          if (charInfo?.type === 'sprite' && charInfo.contains) {
            shapeId = charInfo.contains;
            if (charInfo.innerTransform) {
              shapeTransform = combineTransforms(t, charInfo.innerTransform);
            }
          }

          const svgContent = svgCache[shapeId];
          if (!svgContent) return null;
          if (!hasVisibleContent(svgContent)) return null;

          const mask = getMaskForDepth(depth);
          const clipPathId = mask ? `clip-${mask.maskDepth}` : undefined;

          return (
            <SpriteElement
              key={`${depth}-${obj.characterId}-${shapeId}`}
              characterId={shapeId}
              originalCharacterId={obj.characterId}
              depth={depth}
              svgContent={svgContent}
              transform={shapeTransform}
              colorTransform={disableColorTransforms ? undefined : obj.colorTransform}
              clipPathId={clipPathId}
              isHighlighted={isHighlighted}
            />
          );
        })}
      </div>
    </div>
  );
}
