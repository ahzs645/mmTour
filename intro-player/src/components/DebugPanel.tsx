import { useState, useMemo } from 'react';
import type { DisplayObject, CharacterData } from '../types';

interface DebugPanelProps {
  currentFrame: number;
  totalFrames: number;
  displayList: Record<number, DisplayObject>;
  svgCache: Record<string, string>;
  spriteImages: Record<string, string>;
  characters: Record<string, CharacterData>;
  onHighlight: (depth: number | null) => void;
  highlightedDepth: number | null;
}

type TabType = 'on-stage' | 'shapes' | 'sprites' | 'clips';

// Component to render an SVG preview that fits in a container
function SvgPreview({ svgContent, size = 60 }: { svgContent: string; size?: number }) {
  // Extract viewBox or dimensions from the SVG
  const processedSvg = useMemo(() => {
    // Parse width and height
    const widthMatch = svgContent.match(/width="([^"]+)"/);
    const heightMatch = svgContent.match(/height="([^"]+)"/);

    const width = widthMatch ? parseFloat(widthMatch[1]) : 100;
    const height = heightMatch ? parseFloat(heightMatch[1]) : 100;

    // Check if there's already a viewBox
    const hasViewBox = svgContent.includes('viewBox');

    // Add viewBox if not present, and set width/height to 100%
    let svg = svgContent;
    if (!hasViewBox) {
      svg = svg.replace(/<svg/, `<svg viewBox="0 0 ${width} ${height}"`);
    }

    // Replace width and height with 100%
    svg = svg.replace(/width="[^"]*"/, 'width="100%"');
    svg = svg.replace(/height="[^"]*"/, 'height="100%"');

    return svg;
  }, [svgContent]);

  return (
    <div
      style={{
        width: size,
        height: size,
        background: '#fff',
        borderRadius: 4,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      dangerouslySetInnerHTML={{ __html: processedSvg }}
    />
  );
}

export function DebugPanel({
  currentFrame,
  totalFrames,
  displayList,
  svgCache,
  spriteImages,
  characters,
  onHighlight,
  highlightedDepth
}: DebugPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>('on-stage');

  // Categorize items on stage
  const stageAnalysis = useMemo(() => {
    const onStage: Array<{
      depth: number;
      obj: DisplayObject;
      charInfo?: CharacterData;
      isClip: boolean;
      isClipped: boolean;
      clipBy?: number;
      shapeId: string;
    }> = [];

    const clips: Array<{
      depth: number;
      characterId: string;
      clipDepth: number;
    }> = [];

    const depths = Object.keys(displayList).map(Number).sort((a, b) => a - b);

    // First pass: identify clips
    for (const depth of depths) {
      const obj = displayList[depth];
      if (obj.clipDepth) {
        clips.push({
          depth,
          characterId: obj.characterId,
          clipDepth: obj.clipDepth
        });
      }
    }

    // Second pass: categorize all items
    for (const depth of depths) {
      const obj = displayList[depth];
      const charInfo = characters[obj.characterId];
      const isClip = !!obj.clipDepth;
      const shapeId = charInfo?.contains || obj.characterId;

      // Check if this depth is clipped by something
      let clipBy: number | undefined;
      for (const clip of clips) {
        if (depth > clip.depth && depth <= clip.clipDepth) {
          clipBy = clip.depth;
          break;
        }
      }

      onStage.push({
        depth,
        obj,
        charInfo,
        isClip,
        isClipped: clipBy !== undefined,
        clipBy,
        shapeId
      });
    }

    return { onStage, clips };
  }, [displayList, characters]);

  // All available shapes (loaded in cache)
  const allShapes = useMemo(() => {
    return Object.keys(svgCache).sort((a, b) => parseInt(a) - parseInt(b));
  }, [svgCache]);

  // All available sprites
  const allSprites = useMemo(() => {
    return Object.entries(characters)
      .filter(([_, char]) => char.type === 'sprite')
      .map(([id, char]) => ({
        id,
        hasImage: !!spriteImages[id],
        contains: char.contains
      }));
  }, [characters, spriteImages]);

  // Check if a shape is currently on stage
  const isShapeOnStage = (shapeId: string): { onStage: boolean; depths: number[] } => {
    const depths: number[] = [];
    for (const [depthStr, obj] of Object.entries(displayList)) {
      const charInfo = characters[obj.characterId];
      if (obj.characterId === shapeId || charInfo?.contains === shapeId) {
        depths.push(parseInt(depthStr));
      }
    }
    return { onStage: depths.length > 0, depths };
  };

  const tabs: { key: TabType; label: string; count: number }[] = [
    { key: 'on-stage', label: 'On Stage', count: stageAnalysis.onStage.length },
    { key: 'shapes', label: 'All Shapes', count: allShapes.length },
    { key: 'sprites', label: 'Sprites', count: allSprites.length },
    { key: 'clips', label: 'Clips', count: stageAnalysis.clips.length },
  ];

  return (
    <div style={{
      background: '#1a1a2e',
      color: '#fff',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      borderLeft: '1px solid #333',
      fontSize: 12
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 15px',
        background: '#0d0d1a',
        borderBottom: '1px solid #333'
      }}>
        <div style={{ fontWeight: 'bold', fontSize: 14, marginBottom: 4 }}>Debug Panel</div>
        <div style={{ color: '#888' }}>Frame {currentFrame} / {totalFrames - 1}</div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #333' }}>
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              flex: 1,
              padding: '10px 8px',
              background: activeTab === tab.key ? '#252540' : 'transparent',
              border: 'none',
              borderBottom: activeTab === tab.key ? '2px solid #0066cc' : '2px solid transparent',
              color: activeTab === tab.key ? '#fff' : '#888',
              cursor: 'pointer',
              fontSize: 11,
              transition: 'all 0.15s'
            }}
          >
            {tab.label} ({tab.count})
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
        {activeTab === 'on-stage' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {stageAnalysis.onStage.map(item => (
              <div
                key={item.depth}
                onClick={() => onHighlight(highlightedDepth === item.depth ? null : item.depth)}
                style={{
                  display: 'flex',
                  gap: 10,
                  padding: 10,
                  background: highlightedDepth === item.depth ? '#335' : item.isClip ? '#432' : '#252540',
                  borderRadius: 6,
                  cursor: 'pointer',
                  borderLeft: item.isClipped ? '3px solid #f90' : item.isClip ? '3px solid #f66' : '3px solid transparent',
                  transition: 'background 0.15s'
                }}
              >
                {/* Preview */}
                {svgCache[item.shapeId] && (
                  <SvgPreview svgContent={svgCache[item.shapeId]} size={50} />
                )}

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontWeight: 'bold' }}>Depth {item.depth}</span>
                    <span style={{ color: '#888' }}>
                      {item.charInfo?.type || 'shape'}
                    </span>
                  </div>

                  <div style={{ color: '#6af', fontSize: 11 }}>
                    #{item.obj.characterId}
                    {item.charInfo?.contains && ` → #${item.charInfo.contains}`}
                  </div>

                  {item.isClip && (
                    <div style={{ color: '#f66', fontSize: 10, marginTop: 4 }}>
                      CLIP: depths {item.depth + 1} to {item.obj.clipDepth}
                    </div>
                  )}

                  {item.isClipped && (
                    <div style={{ color: '#fa0', fontSize: 10, marginTop: 4 }}>
                      Clipped by depth {item.clipBy}
                    </div>
                  )}

                  <div style={{ color: '#666', fontSize: 10, marginTop: 4 }}>
                    pos: ({item.obj.transform?.tx?.toFixed(0)}, {item.obj.transform?.ty?.toFixed(0)})
                    {' '}scale: {item.obj.transform?.sx?.toFixed(2)}
                  </div>
                </div>
              </div>
            ))}

            {stageAnalysis.onStage.length === 0 && (
              <div style={{ color: '#666', textAlign: 'center', padding: 20 }}>
                No elements on stage
              </div>
            )}
          </div>
        )}

        {activeTab === 'shapes' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {allShapes.map(shapeId => {
              const { onStage, depths } = isShapeOnStage(shapeId);
              return (
                <div
                  key={shapeId}
                  onClick={() => {
                    if (depths.length > 0) {
                      onHighlight(highlightedDepth === depths[0] ? null : depths[0]);
                    }
                  }}
                  style={{
                    width: 80,
                    padding: 8,
                    background: onStage ? '#253025' : '#252540',
                    borderRadius: 6,
                    textAlign: 'center',
                    cursor: depths.length > 0 ? 'pointer' : 'default',
                    border: depths.includes(highlightedDepth || -1) ? '2px solid #0ff' : '2px solid transparent'
                  }}
                >
                  <SvgPreview svgContent={svgCache[shapeId]} size={60} />
                  <div style={{ fontSize: 11, marginTop: 6, fontWeight: 'bold' }}>#{shapeId}</div>
                  {onStage && (
                    <div style={{ color: '#6f6', fontSize: 9, marginTop: 2 }}>
                      @depth {depths.join(', ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {activeTab === 'sprites' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {allSprites.map(sprite => {
              const { onStage, depths } = isShapeOnStage(sprite.id);
              return (
                <div
                  key={sprite.id}
                  onClick={() => {
                    if (depths.length > 0) {
                      onHighlight(highlightedDepth === depths[0] ? null : depths[0]);
                    }
                  }}
                  style={{
                    padding: 10,
                    background: onStage ? '#253025' : '#252540',
                    borderRadius: 6,
                    display: 'flex',
                    gap: 12,
                    alignItems: 'center',
                    cursor: depths.length > 0 ? 'pointer' : 'default'
                  }}
                >
                  {sprite.hasImage ? (
                    <img
                      src={spriteImages[sprite.id]}
                      alt={`sprite-${sprite.id}`}
                      style={{
                        width: 60,
                        height: 60,
                        objectFit: 'contain',
                        background: '#fff',
                        borderRadius: 4
                      }}
                    />
                  ) : sprite.contains && svgCache[sprite.contains] ? (
                    <SvgPreview svgContent={svgCache[sprite.contains]} size={60} />
                  ) : (
                    <div style={{
                      width: 60,
                      height: 60,
                      background: '#333',
                      borderRadius: 4,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 9,
                      color: '#666'
                    }}>
                      No preview
                    </div>
                  )}

                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', marginBottom: 4 }}>Sprite #{sprite.id}</div>
                    {sprite.contains && (
                      <div style={{ color: '#6af', fontSize: 11 }}>
                        contains: #{sprite.contains}
                      </div>
                    )}
                    {sprite.hasImage && (
                      <div style={{ color: '#8f8', fontSize: 10, marginTop: 2 }}>
                        Has PNG image
                      </div>
                    )}
                    {onStage ? (
                      <div style={{ color: '#6f6', fontSize: 10, marginTop: 4 }}>
                        On stage at depth {depths.join(', ')}
                      </div>
                    ) : (
                      <div style={{ color: '#666', fontSize: 10, marginTop: 4 }}>Off stage</div>
                    )}
                  </div>
                </div>
              );
            })}

            {allSprites.length === 0 && (
              <div style={{ color: '#666', textAlign: 'center', padding: 20 }}>
                No sprites defined
              </div>
            )}
          </div>
        )}

        {activeTab === 'clips' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {stageAnalysis.clips.map(clip => {
              const affectedElements = Object.entries(displayList)
                .filter(([d]) => {
                  const depth = parseInt(d);
                  return depth > clip.depth && depth <= clip.clipDepth;
                })
                .map(([d, obj]) => ({ depth: parseInt(d), obj }));

              return (
                <div
                  key={clip.depth}
                  onClick={() => onHighlight(highlightedDepth === clip.depth ? null : clip.depth)}
                  style={{
                    padding: 12,
                    background: highlightedDepth === clip.depth ? '#543' : '#432',
                    borderRadius: 6,
                    cursor: 'pointer',
                    borderLeft: '3px solid #f66'
                  }}
                >
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    {svgCache[clip.characterId] && (
                      <SvgPreview svgContent={svgCache[clip.characterId]} size={50} />
                    )}

                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 'bold', marginBottom: 4 }}>
                        Clip at Depth {clip.depth}
                      </div>
                      <div style={{ fontSize: 11, color: '#f99', marginBottom: 4 }}>
                        Shape #{clip.characterId}
                      </div>
                      <div style={{ fontSize: 10, color: '#ff9' }}>
                        Clips depths {clip.depth + 1} to {clip.clipDepth}
                      </div>

                      {affectedElements.length > 0 && (
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #555' }}>
                          <div style={{ fontSize: 10, color: '#aaa', marginBottom: 4 }}>
                            Affected elements:
                          </div>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {affectedElements.map(({ depth, obj }) => (
                              <span
                                key={depth}
                                style={{
                                  background: '#333',
                                  padding: '2px 6px',
                                  borderRadius: 3,
                                  fontSize: 10
                                }}
                              >
                                #{obj.characterId}@{depth}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {stageAnalysis.clips.length === 0 && (
              <div style={{ color: '#666', textAlign: 'center', padding: 20 }}>
                No clip masks on stage at this frame
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '10px 15px',
        borderTop: '1px solid #333',
        background: '#0d0d1a',
        fontSize: 10,
        color: '#666'
      }}>
        Click items to highlight on stage
      </div>
    </div>
  );
}
