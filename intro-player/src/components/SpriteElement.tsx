import { useMemo } from 'react';
import type { Transform, ColorTransform } from '../types';

interface SpriteElementProps {
  characterId: string;
  originalCharacterId?: string;
  depth: number;
  svgContent: string;
  transform: Transform;
  colorTransform?: ColorTransform;
  clipPathId?: string;
  isHighlighted?: boolean;
}

// Extract the internal transform offset from SVG's g element
function extractSvgOffset(svgContent: string): { x: number; y: number } {
  const match = svgContent.match(/<g[^>]*transform="matrix\([^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([^,]+),\s*([^)]+)\)"/);
  if (match) {
    return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
  }
  return { x: 0, y: 0 };
}

// Extract SVG dimensions
function extractSvgDimensions(svgContent: string): { width: number; height: number } {
  const widthMatch = svgContent.match(/width="([^"]+)"/);
  const heightMatch = svgContent.match(/height="([^"]+)"/);
  return {
    width: widthMatch ? parseFloat(widthMatch[1]) : 100,
    height: heightMatch ? parseFloat(heightMatch[1]) : 100
  };
}

// Extract the inner content of the SVG (everything between <svg> and </svg>)
function extractSvgInner(svgContent: string): string {
  const match = svgContent.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  return match ? match[1] : svgContent;
}

// Make all IDs in SVG unique by adding a prefix
function makeUniqueIds(svgText: string, prefix: string): string {
  const idRegex = /id="([^"]+)"/g;
  const ids: string[] = [];
  let match;
  while ((match = idRegex.exec(svgText)) !== null) {
    ids.push(match[1]);
  }

  let result = svgText;
  for (const oldId of ids) {
    const newId = `${prefix}_${oldId}`;
    result = result.replace(new RegExp(`id="${oldId}"`, 'g'), `id="${newId}"`);
    result = result.replace(new RegExp(`url\\(#${oldId}\\)`, 'g'), `url(#${newId})`);
    result = result.replace(new RegExp(`href="#${oldId}"`, 'g'), `href="#${newId}"`);
    result = result.replace(new RegExp(`xlink:href="#${oldId}"`, 'g'), `xlink:href="#${newId}"`);
  }

  return result;
}

export function SpriteElement({
  characterId,
  originalCharacterId,
  depth,
  svgContent,
  transform,
  colorTransform,
  clipPathId,
  isHighlighted
}: SpriteElementProps) {
  // Extract offset and dimensions from the SVG
  const offset = useMemo(() => extractSvgOffset(svgContent), [svgContent]);
  const dims = useMemo(() => extractSvgDimensions(svgContent), [svgContent]);

  // Process SVG: extract inner content and make IDs unique
  const processedInner = useMemo(() => {
    const inner = extractSvgInner(svgContent);
    return makeUniqueIds(inner, `s${characterId}_d${depth}`);
  }, [svgContent, characterId, depth]);

  const t = transform;

  // Color transform - multipliers and additive terms
  const am = colorTransform?.am ?? 1;
  const rm = colorTransform?.rm ?? 1;
  const gm = colorTransform?.gm ?? 1;
  const bm = colorTransform?.bm ?? 1;
  const ra = (colorTransform?.ra ?? 0) / 255;
  const ga = (colorTransform?.ga ?? 0) / 255;
  const ba = (colorTransform?.ba ?? 0) / 255;

  const needsColorFilter = rm !== 1 || gm !== 1 || bm !== 1 || ra !== 0 || ga !== 0 || ba !== 0;
  const filterId = `color-filter-${characterId}-${depth}`;
  const colorMatrixValues = `${rm} 0 0 0 ${ra}  0 ${gm} 0 0 ${ga}  0 0 ${bm} 0 ${ba}  0 0 0 1 0`;

  const displayId = originalCharacterId && originalCharacterId !== characterId
    ? `${originalCharacterId} -> ${characterId}`
    : characterId;

  // Build the SVG transform that combines the placement transform with offset compensation
  const svgTransform = `matrix(${t.sx}, ${t.r0}, ${t.r1}, ${t.sy}, ${t.tx + offset.x}, ${t.ty + offset.y})`;

  return (
    <>
      <svg
        className="element"
        data-character-id={characterId}
        data-depth={depth}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          overflow: 'visible',
          zIndex: depth,
          opacity: am,
          pointerEvents: 'none',
        }}
        width={dims.width}
        height={dims.height}
      >
        {needsColorFilter && (
          <defs>
            <filter id={filterId}>
              <feColorMatrix type="matrix" values={colorMatrixValues} />
            </filter>
          </defs>
        )}
        <g
          transform={svgTransform}
          filter={needsColorFilter ? `url(#${filterId})` : undefined}
          clipPath={clipPathId ? `url(#${clipPathId})` : undefined}
          style={{
            outline: isHighlighted ? '3px solid #0ff' : undefined,
          }}
          dangerouslySetInnerHTML={{ __html: processedInner }}
        />
      </svg>
      {isHighlighted && (
        <div style={{
          position: 'absolute',
          left: 0,
          top: 0,
          zIndex: 10000 + depth,
          transform: `translate(${t.tx}px, ${t.ty - 20}px)`,
          background: '#0ff',
          color: '#000',
          padding: '2px 6px',
          fontSize: 10,
          fontWeight: 'bold',
          borderRadius: 3,
          whiteSpace: 'nowrap',
          pointerEvents: 'none'
        }}>
          Depth {depth} - Shape #{displayId}
        </div>
      )}
    </>
  );
}
