import { useState, useRef, useCallback, useEffect } from 'react';
import { parseSwfFile } from '../engine/SwfParser';
import type { SwfMovie } from '../engine/SwfParser';
import { GsapSwfRenderer } from '../engine/GsapSwfRenderer';
import './GsapPlayer.css';

interface GsapTourPlayerProps {
  onFrameChangeExternal?: (frame: number, totalFrames: number) => void;
  showControls?: boolean;
  initialFrame?: number | null;
  autoplay?: boolean;
  screen?: 'menu' | 'tour';
}

const DEFAULT_STAGE_SIZE = { width: 640, height: 480 };
const MENU_BOOTSTRAP_TICK = 2;

function findLastEmptyRootFrame(movie: SwfMovie): number | null {
  const displayList = new Map<number, number>();
  let lastEmptyFrame: number | null = displayList.size === 0 ? 0 : null;

  movie.frames.forEach((frame, frameIndex) => {
    for (const depth of frame.removals) {
      displayList.delete(depth);
    }

    for (const placement of frame.placements) {
      if (placement.characterId === undefined) continue;
      displayList.set(placement.depth, placement.characterId);
    }

    if (displayList.size === 0) {
      lastEmptyFrame = frameIndex;
    }
  });

  return lastEmptyFrame;
}

export function GsapTourPlayer({
  onFrameChangeExternal,
  showControls = true,
  initialFrame = null,
  autoplay = true,
  screen = 'menu',
}: GsapTourPlayerProps = {}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const navLayerRef = useRef<HTMLDivElement>(null);
  const introLayerRef = useRef<HTMLDivElement>(null);
  const navRendererRef = useRef<GsapSwfRenderer | null>(null);
  const introRendererRef = useRef<GsapSwfRenderer | null>(null);
  const layerSyncRef = useRef(false);
  const menuIntroFrameRef = useRef<number | null>(null);
  const initialAutoplayPendingRef = useRef(autoplay && initialFrame === null);
  const initialSeekFrameRef = useRef<number | null>(initialFrame);

  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stageSize, setStageSize] = useState(DEFAULT_STAGE_SIZE);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [fps, setFps] = useState(15);
  const [isPlaying, setIsPlaying] = useState(false);
  const isMenuScreen = screen === 'menu';

  useEffect(() => {
    onFrameChangeExternal?.(currentFrame, totalFrames);
  }, [currentFrame, totalFrames, onFrameChangeExternal]);

  const getMasterRenderer = useCallback(() => {
    return isMenuScreen
      ? (navRendererRef.current ?? introRendererRef.current)
      : (introRendererRef.current ?? navRendererRef.current);
  }, [isMenuScreen]);

  const getFrameTargets = useCallback((frame: number) => {
    const navRenderer = navRendererRef.current;
    const introRenderer = introRendererRef.current;

    if (isMenuScreen) {
      const navTotalFrames = navRenderer?.totalFrames ?? 0;
      const navFrame = navTotalFrames > 0
        ? Math.max(0, Math.min(frame, navTotalFrames - 1))
        : null;
      const introTotalFrames = introRenderer?.totalFrames ?? 0;
      const introMenuFrame = menuIntroFrameRef.current;
      const introFrame = introTotalFrames > 0
        ? Math.max(
            0,
            Math.min(
              introMenuFrame ?? (navFrame ?? 0),
              introTotalFrames - 1,
            ),
          )
        : null;

      return {
        masterFrame: navFrame ?? (introFrame ?? 0),
        navFrame,
        introFrame,
      };
    }

    const introTotalFrames = introRenderer?.totalFrames ?? 0;
    const introFrame = introTotalFrames > 0
      ? Math.max(0, Math.min(frame, introTotalFrames - 1))
      : null;

    return {
      masterFrame: introFrame ?? 0,
      navFrame: navRenderer ? 0 : null,
      introFrame,
    };
  }, [isMenuScreen]);

  const syncFrame = useCallback((frame: number, pause = true) => {
    const introRenderer = introRendererRef.current;
    const navRenderer = navRendererRef.current;
    const { masterFrame, navFrame, introFrame } = getFrameTargets(frame);

    if (navFrame === null && introFrame === null) return;

    if (pause) {
      introRenderer?.pause();
      navRenderer?.pause();
      setIsPlaying(false);
    }

    layerSyncRef.current = true;

    try {
      if (introRenderer && introFrame !== null && introRenderer.currentFrame !== introFrame) {
        introRenderer.seekToFrame(introFrame);
      }

      if (navRenderer && navFrame !== null && navRenderer.currentFrame !== navFrame) {
        navRenderer.seekToFrame(navFrame);
      }
    } finally {
      layerSyncRef.current = false;
    }

    setCurrentFrame(masterFrame);
  }, [getFrameTargets]);

  useEffect(() => {
    let destroyed = false;

    async function init() {
      setLoading(true);
      setError(null);
      setIsPlaying(false);
      setCurrentFrame(0);
      setTotalFrames(0);
      setFps(15);
      initialAutoplayPendingRef.current = autoplay && initialFrame === null;
      initialSeekFrameRef.current = initialFrame;

      const clearLayer = (layer: HTMLDivElement | null) => {
        if (!layer) return;
        layer.innerHTML = '';
        layer.style.background = 'transparent';
      };

      clearLayer(navLayerRef.current);
      clearLayer(introLayerRef.current);

      try {
        const [navResult, introResult] = await Promise.allSettled([
          parseSwfFile('/nav.swf'),
          isMenuScreen ? Promise.resolve(null) : parseSwfFile('/intro.swf'),
        ]);
        if (destroyed) return;

        const navMovie = navResult.status === 'fulfilled' ? navResult.value : null;
        const introMovie = introResult.status === 'fulfilled' ? introResult.value : null;

        if (!navMovie && !introMovie) {
          const navReason = navResult.status === 'rejected' ? String(navResult.reason) : '';
          const introReason = introResult.status === 'rejected' ? String(introResult.reason) : '';
          throw new Error(`Failed to parse nav.swf and intro.swf. ${navReason} ${introReason}`.trim());
        }

        const nextStageSize = {
          width: Math.max(navMovie?.width ?? 0, introMovie?.width ?? 0, DEFAULT_STAGE_SIZE.width),
          height: Math.max(navMovie?.height ?? 0, introMovie?.height ?? 0, DEFAULT_STAGE_SIZE.height),
        };
        setStageSize(nextStageSize);

        const navRenderer = navMovie && navLayerRef.current
          ? new GsapSwfRenderer(navMovie, navLayerRef.current, {
              hiddenCharacterIds: isMenuScreen ? [8, 56] : [],
            })
          : null;
        const introRenderer = !isMenuScreen && introMovie && introLayerRef.current
          ? new GsapSwfRenderer(introMovie, introLayerRef.current)
          : null;

        menuIntroFrameRef.current = isMenuScreen && introMovie
          ? findLastEmptyRootFrame(introMovie)
          : null;

        if (isMenuScreen && navRenderer) {
          navRenderer.bootstrapMovie({
            tick: MENU_BOOTSTRAP_TICK,
            globals: [{ path: '_level0.bkgd.OSVersion', value: 'Per' }],
            functionName: 'startAddedNav',
          });
        }

        navRendererRef.current = navRenderer;
        introRendererRef.current = introRenderer;

        if (navLayerRef.current) {
          navLayerRef.current.style.background = isMenuScreen
            ? 'transparent'
            : (navMovie?.backgroundColor ?? 'transparent');
        }
        if (introLayerRef.current) {
          introLayerRef.current.style.background = introMovie?.backgroundColor ?? 'transparent';
          introLayerRef.current.style.display = introMovie && !isMenuScreen ? '' : 'none';
        }

        const nextTotalFrames = isMenuScreen
          ? (navRenderer?.totalFrames ?? introRenderer?.totalFrames ?? 0)
          : (introRenderer?.totalFrames ?? navRenderer?.totalFrames ?? 0);
        const nextFps = isMenuScreen
          ? (navRenderer?.fps ?? introRenderer?.fps ?? 15)
          : (introRenderer?.fps ?? navRenderer?.fps ?? 15);
        setTotalFrames(nextTotalFrames);
        setFps(nextFps);

        if (isMenuScreen) {
          if (navRenderer) {
            navRenderer.onFrameChange = (frame) => {
              if (layerSyncRef.current) return;

              const { masterFrame, introFrame } = getFrameTargets(frame);

              if (introRenderer && introFrame !== null && introRenderer.currentFrame !== introFrame) {
                layerSyncRef.current = true;
                try {
                  introRenderer.seekToFrame(introFrame);
                } finally {
                  layerSyncRef.current = false;
                }
              }

              setCurrentFrame(masterFrame);
              if (masterFrame > 0) {
                initialAutoplayPendingRef.current = false;
              }
            };
            navRenderer.onPlaybackChange = (playing) => setIsPlaying(playing);
          }

          if (introRenderer) {
            introRenderer.onFrameChange = undefined;
            introRenderer.onPlaybackChange = undefined;
          }
        } else if (introRenderer) {
          introRenderer.onFrameChange = (frame) => {
            if (layerSyncRef.current) return;
            setCurrentFrame(frame);
            if (frame > 0) {
              initialAutoplayPendingRef.current = false;
            }
          };
          introRenderer.onPlaybackChange = (playing) => setIsPlaying(playing);
          if (navRenderer) {
            navRenderer.onFrameChange = undefined;
            navRenderer.onPlaybackChange = undefined;
          }
        } else if (navRenderer) {
          navRenderer.onFrameChange = (frame) => setCurrentFrame(frame);
          navRenderer.onPlaybackChange = (playing) => setIsPlaying(playing);
        }

        if (isMenuScreen && navRenderer && initialSeekFrameRef.current === null) {
          navRenderer.seekToFrame(MENU_BOOTSTRAP_TICK);
          setCurrentFrame(navRenderer.currentFrame);
          setIsPlaying(navRenderer.isPlaying);
          initialAutoplayPendingRef.current = autoplay;
        } else {
          syncFrame(0);
        }

        (
          window as Window & {
            __GSAP_RENDERERS__?: { nav: GsapSwfRenderer | null; intro: GsapSwfRenderer | null };
          }
        ).__GSAP_RENDERERS__ = { nav: navRenderer, intro: introRenderer };

        setLoading(false);

        if (initialSeekFrameRef.current !== null) {
          const targetFrame = initialSeekFrameRef.current;
          initialSeekFrameRef.current = null;
          initialAutoplayPendingRef.current = false;
          syncFrame(targetFrame);
          return;
        }

        if (initialAutoplayPendingRef.current) {
          initialAutoplayPendingRef.current = false;
          setTimeout(() => {
            if (destroyed) return;
            const autoplayRenderer = isMenuScreen
              ? (navRenderer ?? introRenderer)
              : (introRenderer ?? navRenderer);
            if (isMenuScreen && navRenderer && introRenderer) {
              introRenderer.pause();
            }
            autoplayRenderer?.play();
          }, 0);
        }
      } catch (err) {
        console.error('[GsapTourPlayer] Failed to initialize parsed tour layers:', err);
        if (!destroyed) {
          navRendererRef.current?.destroy();
          introRendererRef.current?.destroy();
          navRendererRef.current = null;
          introRendererRef.current = null;
          setError(err instanceof Error ? err.message : 'Failed to parse tour layers');
          setLoading(false);
        }
      }
    }

    init();

    return () => {
      destroyed = true;
      navRendererRef.current?.destroy();
      introRendererRef.current?.destroy();
      navRendererRef.current = null;
      introRendererRef.current = null;
      menuIntroFrameRef.current = null;
      (
        window as Window & {
          __GSAP_RENDERERS__?: { nav: GsapSwfRenderer | null; intro: GsapSwfRenderer | null };
        }
      ).__GSAP_RENDERERS__ = { nav: null, intro: null };
    };
  }, [autoplay, getFrameTargets, initialFrame, isMenuScreen, syncFrame]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const updateScale = () => {
      const rect = wrapper.getBoundingClientRect();
      const availableWidth = rect.width - 40;
      const availableHeight = rect.height - 40;
      if (availableWidth <= 0 || availableHeight <= 0) return;

      const scaleX = availableWidth / stageSize.width;
      const scaleY = availableHeight / stageSize.height;
      setScale(Math.min(scaleX, scaleY, 2));
    };

    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(updateScale));
    resizeObserver.observe(wrapper);
    requestAnimationFrame(updateScale);
    return () => resizeObserver.disconnect();
  }, [stageSize]);

  const handlePlayPause = useCallback(() => {
    const masterRenderer = getMasterRenderer();
    if (!masterRenderer) return;

    if (masterRenderer.isPlaying) {
      masterRenderer.pause();
      introRendererRef.current?.pause();
      navRendererRef.current?.pause();
      return;
    }

    if (isMenuScreen && masterRenderer === navRendererRef.current) {
      introRendererRef.current?.pause();
    }
    masterRenderer.play();
  }, [getMasterRenderer, isMenuScreen]);

  const handleFrameStep = useCallback((delta: number) => {
    syncFrame(currentFrame + delta);
  }, [currentFrame, syncFrame]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (totalFrames <= 1) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    syncFrame(Math.round(progress * (totalFrames - 1)));
  }, [syncFrame, totalFrames]);

  const handleRestart = useCallback(() => {
    syncFrame(isMenuScreen ? MENU_BOOTSTRAP_TICK : 0);
  }, [isMenuScreen, syncFrame]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const masterRenderer = getMasterRenderer();
      if (!masterRenderer || e.target instanceof HTMLInputElement) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          handlePlayPause();
          break;
        case 'KeyR':
          handleRestart();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          handleFrameStep(e.shiftKey ? -15 : -1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleFrameStep(e.shiftKey ? 15 : 1);
          break;
        case 'Home':
          e.preventDefault();
          syncFrame(isMenuScreen ? MENU_BOOTSTRAP_TICK : 0);
          break;
        case 'End':
          e.preventDefault();
          syncFrame(totalFrames - 1);
          break;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [getMasterRenderer, handleFrameStep, handlePlayPause, handleRestart, syncFrame, totalFrames]);

  const progressPercent = totalFrames > 1 ? (currentFrame / (totalFrames - 1)) * 100 : 0;
  const currentTime = fps > 0 ? (currentFrame / fps).toFixed(2) : '0.00';
  const totalTime = fps > 0 ? (totalFrames / fps).toFixed(2) : '0.00';

  return (
    <div className={`gsap-player-layout ${showControls ? 'gsap-player-layout--with-controls' : 'gsap-player-layout--stage-only'}`}>
      <div className="gsap-player-main">
        <div ref={wrapperRef} className="gsap-stage-wrapper">
          <div
            className="gsap-stage"
            style={{
              width: `${stageSize.width * scale}px`,
              height: `${stageSize.height * scale}px`,
              overflow: 'hidden',
              background: '#ffffff',
              boxShadow: '0 4px 30px rgba(0, 0, 0, 0.5)',
              borderRadius: '4px',
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'relative',
                width: `${stageSize.width}px`,
                height: `${stageSize.height}px`,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                background: '#ffffff',
              }}
            >
              <div
                ref={introLayerRef}
                style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                }}
              />
              <div
                ref={navLayerRef}
                style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                }}
              />
            </div>

            {loading ? (
              <div style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(255,255,255,0.94)',
                zIndex: 100,
              }}>
                <div style={{ textAlign: 'center', color: '#666' }}>
                  <div style={{ fontSize: 16, marginBottom: 12 }}>
                    {isMenuScreen ? 'Parsing nav.swf...' : 'Parsing nav.swf + intro.swf...'}
                  </div>
                  <div style={{ fontSize: 12, color: '#999' }}>
                    {isMenuScreen ? 'Bootstrapping the nav menu timeline to match the original tour state' : 'Building original SWF-owned tour layers'}
                  </div>
                </div>
              </div>
            ) : null}

            {error ? (
              <div style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(255,255,255,0.94)',
                zIndex: 100,
              }}>
                <div style={{ textAlign: 'center', color: '#c33', padding: 20 }}>
                  <div style={{ fontSize: 16, marginBottom: 8 }}>Error</div>
                  <div style={{ fontSize: 12, color: '#999' }}>{error}</div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {showControls ? (
          <div className="gsap-controls">
            <div className="gsap-controls-row">
              <div className="gsap-transport">
                <button onClick={() => syncFrame(isMenuScreen ? MENU_BOOTSTRAP_TICK : 0)} title="Start (Home)" type="button">&#x23EE;</button>
                <button onClick={() => handleFrameStep(-1)} title="Prev (Left)" type="button">&#x25C0;</button>
                <button onClick={handlePlayPause} className="gsap-play-btn" title="Play/Pause (Space)" type="button">{isPlaying ? '\u23F8' : '\u25B6'}</button>
                <button onClick={() => handleFrameStep(1)} title="Next (Right)" type="button">&#x25B6;</button>
                <button onClick={() => syncFrame(totalFrames - 1)} title="End (End)" type="button">&#x23ED;</button>
              </div>
              <div className="gsap-timeline">
                <span className="gsap-time">{currentTime}s / {totalTime}s</span>
                <div className="gsap-progress" onClick={handleSeek}>
                  <div className="gsap-progress-fill" style={{ width: `${progressPercent}%` }} />
                  <div className="gsap-progress-handle" style={{ left: `${progressPercent}%` }} />
                </div>
              </div>
              <div className="gsap-frame-input">
                <label htmlFor="gsap-tour-frame-input">Frame:</label>
                <input
                  id="gsap-tour-frame-input"
                  type="number"
                  min={0}
                  max={Math.max(totalFrames - 1, 0)}
                  value={currentFrame}
                  onChange={(e) => {
                    const frame = parseInt(e.target.value, 10);
                    if (!Number.isNaN(frame)) {
                      syncFrame(frame);
                    }
                  }}
                />
                <span>/ {Math.max(totalFrames - 1, 0)}</span>
              </div>
            </div>
            <div className="gsap-controls-row gsap-controls-secondary">
              <div className="gsap-stats">
                Frame {currentFrame} | {fps} FPS | {isMenuScreen ? 'parsed nav.swf' : 'parsed nav.swf + intro.swf'}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
