import { useState, useRef, useCallback, useEffect } from 'react';
import { GsapStage } from './GsapStage';
import { GsapSwfRenderer } from '../engine/GsapSwfRenderer';
import { NavOverlay } from './NavOverlay';
import { getSegmentById, getSegmentSwfUrl, type TourMode, type TourSegmentId } from './navSegments';
import './GsapPlayer.css';

interface GsapPlayerProps {
  onFrameChangeExternal?: (frame: number, totalFrames: number) => void;
  showControls?: boolean;
  showOverlay?: boolean;
  initialFrame?: number | null;
  autoplay?: boolean;
}

export function GsapPlayer({
  onFrameChangeExternal,
  showControls = true,
  showOverlay = true,
  initialFrame = null,
  autoplay = true,
}: GsapPlayerProps = {}) {
  const rendererRef = useRef<GsapSwfRenderer | null>(null);
  const autoplayOnReadyRef = useRef(false);
  const initialAutoplayPendingRef = useRef(autoplay && initialFrame === null);
  const initialSeekFrameRef = useRef<number | null>(initialFrame);
  const [swfUrl, setSwfUrl] = useState('/intro.swf');
  const [activeSegment, setActiveSegment] = useState<TourSegmentId | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [fps, setFps] = useState(15);
  const mode: TourMode = activeSegment === null ? 'intro' : 'segment';
  const activeSegmentInfo = getSegmentById(activeSegment);

  useEffect(() => {
    setCurrentFrame(0);
    setTotalFrames(0);
    setFps(15);
    setIsPlaying(false);
  }, [swfUrl]);

  useEffect(() => {
    onFrameChangeExternal?.(currentFrame, totalFrames);
  }, [currentFrame, totalFrames, onFrameChangeExternal]);

  const handleRendererReady = useCallback((renderer: GsapSwfRenderer | null) => {
    (window as Window & { __GSAP_RENDERER__?: GsapSwfRenderer | null }).__GSAP_RENDERER__ = renderer;
    rendererRef.current = renderer;
    if (!renderer) {
      setIsPlaying(false);
      return;
    }

    setTotalFrames(renderer.totalFrames);
    setFps(renderer.fps);
    setCurrentFrame(renderer.currentFrame);
    setIsPlaying(renderer.isPlaying);
    renderer.onFrameChange = (frame) => {
      setCurrentFrame(frame);
      if (frame > 0) {
        initialAutoplayPendingRef.current = false;
      }
    };
    renderer.onPlaybackChange = (playing) => setIsPlaying(playing);

    if (initialSeekFrameRef.current !== null) {
      const frame = Math.max(0, Math.min(initialSeekFrameRef.current, renderer.totalFrames - 1));
      initialSeekFrameRef.current = null;
      initialAutoplayPendingRef.current = false;
      renderer.pause();
      renderer.seekToFrame(frame);
      setCurrentFrame(frame);
      setIsPlaying(false);
      return;
    }

    if (autoplayOnReadyRef.current || initialAutoplayPendingRef.current) {
      autoplayOnReadyRef.current = false;
      initialAutoplayPendingRef.current = false;
      setTimeout(() => {
        if (rendererRef.current === renderer) {
          renderer.play();
        }
      }, 0);
    }
  }, []);

  const handlePlayPause = useCallback(() => rendererRef.current?.togglePlay(), []);
  const handleRestart = useCallback(() => {
    rendererRef.current?.restart();
    setCurrentFrame(0);
    setIsPlaying(false);
  }, []);

  const handleFrameStep = useCallback((delta: number) => {
    const r = rendererRef.current;
    if (!r) return;
    r.pause();
    r.seekToFrame(r.currentFrame + delta);
    setIsPlaying(false);
  }, []);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const r = rendererRef.current;
    if (!r) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    r.pause();
    r.seekToFrame(Math.round(progress * (r.totalFrames - 1)));
    setIsPlaying(false);
  }, []);

  const handleSkipIntro = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer || mode !== 'intro') return;
    renderer.pause();
    renderer.seekToFrame(renderer.totalFrames - 1);
    setCurrentFrame(renderer.totalFrames - 1);
    setIsPlaying(false);
  }, [mode]);

  const handleSegmentClick = useCallback((segment: TourSegmentId) => {
    const nextSwfUrl = getSegmentSwfUrl(segment);
    setActiveSegment(segment);

    if (swfUrl === nextSwfUrl && rendererRef.current) {
      rendererRef.current.seekToFrame(0);
      rendererRef.current.play();
      return;
    }

    autoplayOnReadyRef.current = true;
    setSwfUrl(nextSwfUrl);
  }, [swfUrl]);

  const handleExitTour = useCallback(() => {
    autoplayOnReadyRef.current = true;
    setActiveSegment(null);
    setSwfUrl('/intro.swf');
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const r = rendererRef.current;
      if (!r || e.target instanceof HTMLInputElement) return;
      switch (e.code) {
        case 'Space': e.preventDefault(); r.togglePlay(); break;
        case 'KeyR': handleRestart(); break;
        case 'ArrowLeft': e.preventDefault(); handleFrameStep(e.shiftKey ? -15 : -1); break;
        case 'ArrowRight': e.preventDefault(); handleFrameStep(e.shiftKey ? 15 : 1); break;
        case 'Home': e.preventDefault(); r.pause(); r.seekToFrame(0); setIsPlaying(false); break;
        case 'End': e.preventDefault(); r.pause(); r.seekToFrame(r.totalFrames - 1); setIsPlaying(false); break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleRestart, handleFrameStep]);

  const progressPercent = totalFrames > 0 ? (currentFrame / totalFrames) * 100 : 0;
  const currentTime = (currentFrame / fps).toFixed(2);
  const totalTime = (totalFrames / fps).toFixed(2);

  return (
    <div className={`gsap-player-layout ${showControls ? 'gsap-player-layout--with-controls' : 'gsap-player-layout--stage-only'}`}>
      <div className="gsap-player-main">
        <GsapStage
          swfUrl={swfUrl}
          onRendererReady={handleRendererReady}
          overlay={showOverlay ? (
            <NavOverlay
              currentFrame={currentFrame}
              totalFrames={totalFrames}
              isPlaying={isPlaying}
              mode={mode}
              activeSegment={activeSegment}
              onSkipIntro={handleSkipIntro}
              onSegmentClick={handleSegmentClick}
              onExitTour={handleExitTour}
            />
          ) : null}
        />

        {showControls ? (
          <div className="gsap-controls">
            <div className="gsap-controls-row">
              <div className="gsap-transport">
                <button onClick={() => { rendererRef.current?.pause(); rendererRef.current?.seekToFrame(0); setIsPlaying(false); }} title="Start (Home)">&#x23EE;</button>
                <button onClick={() => handleFrameStep(-1)} title="Prev (Left)">&#x25C0;</button>
                <button onClick={handlePlayPause} className="gsap-play-btn" title="Play/Pause (Space)">{isPlaying ? '\u23F8' : '\u25B6'}</button>
                <button onClick={() => handleFrameStep(1)} title="Next (Right)">&#x25B6;</button>
                <button onClick={() => { rendererRef.current?.pause(); rendererRef.current?.seekToFrame(totalFrames - 1); setIsPlaying(false); }} title="End (End)">&#x23ED;</button>
              </div>
              <div className="gsap-timeline">
                <span className="gsap-time">{currentTime}s / {totalTime}s</span>
                <div className="gsap-progress" onClick={handleSeek}>
                  <div className="gsap-progress-fill" style={{ width: `${progressPercent}%` }} />
                  <div className="gsap-progress-handle" style={{ left: `${progressPercent}%` }} />
                </div>
              </div>
              <div className="gsap-frame-input">
                <label>Frame:</label>
                <input type="number" min={0} max={totalFrames - 1} value={currentFrame}
                  onChange={(e) => {
                    const f = parseInt(e.target.value, 10);
                    if (!isNaN(f) && f >= 0 && f < totalFrames) {
                      rendererRef.current?.pause();
                      rendererRef.current?.seekToFrame(f);
                      setIsPlaying(false);
                    }
                  }} />
                <span>/ {totalFrames - 1}</span>
              </div>
            </div>
            <div className="gsap-controls-row gsap-controls-secondary">
              <div className="gsap-stats">
                Frame {currentFrame} | {fps} FPS | swf-parser + GSAP | {activeSegmentInfo ? activeSegmentInfo.label : 'Intro'}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
