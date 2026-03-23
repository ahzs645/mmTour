import { useRef, useEffect, useState, type ReactNode } from 'react';
import { parseSwfFile } from '../engine/SwfParser';
import { GsapSwfRenderer } from '../engine/GsapSwfRenderer';

interface GsapStageProps {
  swfUrl: string;
  onRendererReady?: (renderer: GsapSwfRenderer | null) => void;
  overlay?: ReactNode;
}

export function GsapStage({ swfUrl, onRendererReady, overlay }: GsapStageProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GsapSwfRenderer | null>(null);
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stageSize, setStageSize] = useState({ width: 640, height: 480 });

  // Parse SWF and create renderer
  useEffect(() => {
    let destroyed = false;

    async function init() {
      try {
        setLoading(true);
        setError(null);
        onRendererReady?.(null);

        // Parse SWF binary directly
        const movie = await parseSwfFile(swfUrl);
        if (destroyed) return;

        setStageSize({ width: movie.width, height: movie.height });

        // Create renderer
        if (!stageRef.current) return;
        stageRef.current.innerHTML = '';

        const renderer = new GsapSwfRenderer(movie, stageRef.current);
        rendererRef.current = renderer;
        renderer.seekToFrame(0);

        setLoading(false);
        onRendererReady?.(renderer);
      } catch (err) {
        console.error('[SwfParser] Failed:', err);
        if (!destroyed) {
          onRendererReady?.(null);
          setError(err instanceof Error ? err.message : 'Failed to parse SWF');
          setLoading(false);
        }
      }
    }

    init();
    return () => {
      destroyed = true;
      rendererRef.current?.destroy();
      rendererRef.current = null;
      onRendererReady?.(null);
    };
  }, [swfUrl, onRendererReady]);

  // Responsive scaling
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const updateScale = () => {
      const rect = wrapper.getBoundingClientRect();
      const availableWidth = rect.width - 40;
      const availableHeight = rect.height - 40;
      if (availableWidth > 0 && availableHeight > 0) {
        const scaleX = availableWidth / stageSize.width;
        const scaleY = availableHeight / stageSize.height;
        setScale(Math.min(scaleX, scaleY, 2));
      }
    };

    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(updateScale));
    resizeObserver.observe(wrapper);
    requestAnimationFrame(updateScale);
    return () => resizeObserver.disconnect();
  }, [stageSize]);

  return (
    <div ref={wrapperRef} className="gsap-stage-wrapper">
      <div
        className="gsap-stage"
        style={{
          width: `${stageSize.width * scale}px`,
          height: `${stageSize.height * scale}px`,
          overflow: 'hidden',
          background: '#fff',
          boxShadow: '0 4px 30px rgba(0, 0, 0, 0.5)',
          borderRadius: '4px',
          position: 'relative',
        }}
      >
        <div
          ref={stageRef}
          style={{
            position: 'relative',
            width: `${stageSize.width}px`,
            height: `${stageSize.height}px`,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        />
        {overlay}

        {loading && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(255,255,255,0.95)', zIndex: 100,
          }}>
            <div style={{ textAlign: 'center', color: '#666' }}>
              <div style={{ fontSize: 16, marginBottom: 12 }}>Parsing SWF...</div>
              <div style={{ fontSize: 12, color: '#999' }}>Converting Flash to GSAP timeline</div>
            </div>
          </div>
        )}

        {error && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(255,255,255,0.95)', zIndex: 100,
          }}>
            <div style={{ textAlign: 'center', color: '#c33', padding: 20 }}>
              <div style={{ fontSize: 16, marginBottom: 8 }}>Error</div>
              <div style={{ fontSize: 12, color: '#999' }}>{error}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
