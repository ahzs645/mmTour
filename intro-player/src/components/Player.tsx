import { useState, useEffect, useRef, useCallback } from 'react';
import { useTimeline } from '../hooks/useTimeline';
import { Stage } from './Stage';
import { DebugPanel } from './DebugPanel';
import type { DisplayObject, Transform, FrameData } from '../types';
import './Player.css';

const DEFAULT_TRANSFORM: Transform = {
  sx: 1, sy: 1, r0: 0, r1: 0, tx: 0, ty: 0
};

export function Player() {
  const { data, svgCache, spriteImages, loading, loadingStatus, loadingProgress } = useTimeline();
  const [displayList, setDisplayList] = useState<Record<number, DisplayObject>>({});
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [disableColorTransforms, setDisableColorTransforms] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(true);
  const [highlightedDepth, setHighlightedDepth] = useState<number | null>(null);

  const displayListRef = useRef<Record<number, DisplayObject>>({});
  const animationRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);

  // Process a single frame's commands
  const processFrame = useCallback((frame: FrameData, dl: Record<number, DisplayObject>) => {
    const newDL = { ...dl };

    for (const depth of frame.remove) {
      delete newDL[depth];
    }

    for (const place of frame.place) {
      const depth = place.d;

      if (place.m && newDL[depth]) {
        const updated = { ...newDL[depth] };
        if (place.t) updated.transform = place.t;
        if (place.ct) updated.colorTransform = place.ct;
        if (place.c && place.c !== updated.characterId) {
          updated.characterId = place.c;
          if (place.cd !== undefined) updated.clipDepth = place.cd;
        }
        newDL[depth] = updated;
      } else if (place.c) {
        newDL[depth] = {
          characterId: place.c,
          transform: place.t || DEFAULT_TRANSFORM,
          colorTransform: place.ct,
          clipDepth: place.cd,
        };
      }
    }

    return newDL;
  }, []);

  const buildDisplayList = useCallback((targetFrame: number): Record<number, DisplayObject> => {
    if (!data) return {};

    let dl: Record<number, DisplayObject> = {};
    for (let i = 0; i <= targetFrame; i++) {
      dl = processFrame(data.timeline[i], dl);
    }
    return dl;
  }, [data, processFrame]);

  const gotoFrame = useCallback((frame: number) => {
    if (!data || frame < 0 || frame >= data.meta.frames) return;

    const newDL = buildDisplayList(frame);
    displayListRef.current = newDL;
    setDisplayList(newDL);
    setCurrentFrame(frame);
  }, [data, buildDisplayList]);

  const animate = useCallback((timestamp: number) => {
    if (!data) return;

    const frameDuration = 1000 / data.meta.fps;

    if (timestamp - lastFrameTimeRef.current >= frameDuration) {
      const nextFrame = currentFrame + 1;

      if (nextFrame >= data.meta.frames) {
        setIsPlaying(false);
        return;
      }

      const newDL = processFrame(data.timeline[nextFrame], displayListRef.current);
      displayListRef.current = newDL;
      setDisplayList(newDL);
      setCurrentFrame(nextFrame);
      lastFrameTimeRef.current = timestamp;
    }

    animationRef.current = requestAnimationFrame(animate);
  }, [data, currentFrame, processFrame]);

  useEffect(() => {
    if (isPlaying && data) {
      lastFrameTimeRef.current = performance.now();
      animationRef.current = requestAnimationFrame(animate);
    } else if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isPlaying, data, animate]);

  useEffect(() => {
    if (data && !loading) {
      gotoFrame(0);
    }
  }, [data, loading, gotoFrame]);

  const handlePlayPause = () => {
    if (currentFrame >= (data?.meta.frames ?? 0) - 1) {
      gotoFrame(0);
    }
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!data) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const frame = Math.floor(percent * data.meta.frames);
    setIsPlaying(false);
    gotoFrame(frame);
  };

  if (loading) {
    return (
      <div className="player-loading">
        <div className="loading-content">
          <h2>Loading Windows XP Tour...</h2>
          <div className="loading-bar">
            <div className="loading-fill" style={{ width: `${loadingProgress}%` }} />
          </div>
          <div className="loading-status">{loadingStatus}</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="player-error">Failed to load timeline data</div>;
  }

  const progressPercent = (currentFrame / data.meta.frames) * 100;
  const currentTime = (currentFrame / data.meta.fps).toFixed(2);
  const totalTime = (data.meta.frames / data.meta.fps).toFixed(2);

  return (
    <div className={`player-layout ${!showDebugPanel ? 'no-debug' : ''}`}>
      <div className="player-main">
        <div className="stage-wrapper">
          <Stage
            width={data.meta.width}
            height={data.meta.height}
            displayList={displayList}
            svgCache={svgCache}
            spriteImages={spriteImages}
            characters={data.characters}
            disableColorTransforms={disableColorTransforms}
            highlightedDepth={highlightedDepth}
          />
        </div>

        <div className="player-controls">
          <div className="controls-row">
            <div className="transport-controls">
              <button onClick={() => { setIsPlaying(false); gotoFrame(0); }} title="Go to start">
                ⏮
              </button>
              <button onClick={() => { setIsPlaying(false); gotoFrame(Math.max(0, currentFrame - 1)); }} title="Previous frame">
                ◀
              </button>
              <button onClick={handlePlayPause} className="play-btn" title={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button onClick={() => { setIsPlaying(false); gotoFrame(Math.min(data.meta.frames - 1, currentFrame + 1)); }} title="Next frame">
                ▶
              </button>
              <button onClick={() => { setIsPlaying(false); gotoFrame(data.meta.frames - 1); }} title="Go to end">
                ⏭
              </button>
            </div>

            <div className="timeline-controls">
              <span className="time-display">{currentTime}s / {totalTime}s</span>
              <div className="progress-bar" onClick={handleSeek}>
                <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
                <div className="progress-handle" style={{ left: `${progressPercent}%` }} />
              </div>
            </div>

            <div className="frame-controls">
              <label>Frame:</label>
              <input
                type="number"
                min={0}
                max={data.meta.frames - 1}
                value={currentFrame}
                onChange={(e) => {
                  const frame = parseInt(e.target.value, 10);
                  if (!isNaN(frame) && frame >= 0 && frame < data.meta.frames) {
                    setIsPlaying(false);
                    gotoFrame(frame);
                  }
                }}
              />
              <span>/ {data.meta.frames - 1}</span>
            </div>
          </div>

          <div className="controls-row secondary">
            <div className="toggle-controls">
              <label>
                <input
                  type="checkbox"
                  checked={disableColorTransforms}
                  onChange={() => setDisableColorTransforms(!disableColorTransforms)}
                />
                Disable Color Transforms
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showDebugPanel}
                  onChange={() => setShowDebugPanel(!showDebugPanel)}
                />
                Show Debug Panel
              </label>
            </div>
            <div className="stats">
              {Object.keys(displayList).length} elements | {Object.keys(svgCache).length} shapes | {data.meta.fps} FPS
            </div>
          </div>
        </div>
      </div>

      {showDebugPanel && (
        <DebugPanel
          currentFrame={currentFrame}
          totalFrames={data.meta.frames}
          displayList={displayList}
          svgCache={svgCache}
          spriteImages={spriteImages}
          characters={data.characters}
          onHighlight={setHighlightedDepth}
          highlightedDepth={highlightedDepth}
        />
      )}
    </div>
  );
}
