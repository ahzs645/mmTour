import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { TOUR_SEGMENTS, getSegmentById, type TourMode, type TourSegmentId } from './navSegments';
import './NavOverlay.css';

interface NavOverlayProps {
  currentFrame: number;
  totalFrames: number;
  isPlaying: boolean;
  mode: TourMode;
  activeSegment: TourSegmentId | null;
  onSkipIntro: () => void;
  onSegmentClick: (segment: TourSegmentId) => void;
  onExitTour: () => void;
}

export function NavOverlay({
  currentFrame,
  totalFrames,
  isPlaying,
  mode,
  activeSegment,
  onSkipIntro,
  onSegmentClick,
  onExitTour,
}: NavOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const introProgress = totalFrames > 1 ? currentFrame / (totalFrames - 1) : 0;
  const introComplete = introProgress > 0.95;
  const introHasStarted = currentFrame > 0 || isPlaying;
  const showSkipIntro = mode === 'intro' && !introComplete && introHasStarted;
  const showTabs = mode === 'segment' || introComplete;
  const showBottomBar = mode === 'segment' || introProgress > 0.1 || activeSegment !== null;
  const activeSegmentInfo = getSegmentById(activeSegment);

  // Animate "Skip Intro" - visible during intro playback
  useEffect(() => {
    if (!skipRef.current) return;
    gsap.killTweensOf(skipRef.current);
    if (showSkipIntro) {
      gsap.to(skipRef.current, { autoAlpha: 1, y: 0, duration: 0.5, ease: 'power2.out' });
    } else {
      gsap.set(skipRef.current, { autoAlpha: 0, y: 10 });
    }
  }, [mode, showSkipIntro]);

  // Animate tabs - appear after intro
  useEffect(() => {
    if (!tabsRef.current) return;
    if (showTabs) {
      gsap.to(tabsRef.current, { autoAlpha: 1, y: 0, duration: 0.6, delay: 0.2, ease: 'power2.out' });
    } else {
      gsap.set(tabsRef.current, { autoAlpha: 0, y: -20 });
    }
  }, [showTabs]);

  // Animate bottom bar
  useEffect(() => {
    if (!bottomRef.current) return;
    gsap.to(bottomRef.current, {
      autoAlpha: showBottomBar ? 1 : 0,
      duration: 0.4,
    });
  }, [showBottomBar]);

  return (
    <div ref={overlayRef} className="nav-overlay">
      {/* Blue/white gradient background - top left */}
      <div className="nav-gradient" />

      {/* Decorative curved lines (simplified) */}
      <svg className="nav-curves" viewBox="0 0 640 480" preserveAspectRatio="none">
        <path
          d="M0 80 Q160 60, 320 120 Q480 180, 640 100"
          fill="none"
          stroke="rgba(180,200,230,0.3)"
          strokeWidth="1.5"
        />
        <path
          d="M0 120 Q200 90, 400 160 Q550 210, 640 140"
          fill="none"
          stroke="rgba(180,200,230,0.2)"
          strokeWidth="1"
        />
      </svg>

      {/* Skip Intro button */}
      <button
        ref={skipRef}
        className="nav-skip-intro"
        onClick={onSkipIntro}
        style={{ pointerEvents: showSkipIntro ? 'auto' : 'none' }}
        aria-label="Skip Intro"
        aria-hidden={!showSkipIntro}
        type="button"
      >
        Skip Intro
      </button>

      {/* Section tabs - appear after intro */}
      <div
        ref={tabsRef}
        className="nav-tabs"
        style={{ pointerEvents: showTabs ? 'auto' : 'none' }}
        aria-hidden={!showTabs}
      >
        {TOUR_SEGMENTS.map((seg) => (
          <button
            key={seg.id}
            className={`nav-tab ${activeSegment === seg.id ? 'active' : ''}`}
            style={{
              background: activeSegment === seg.id
                ? `linear-gradient(to bottom, ${seg.tabColor}, ${seg.color})`
                : `linear-gradient(to bottom, ${seg.tabColor}cc, ${seg.color}99)`,
            }}
            onClick={() => onSegmentClick(seg.id)}
            title={seg.label}
            aria-label={seg.label}
            aria-pressed={activeSegment === seg.id}
            type="button"
          />
        ))}
      </div>

      {/* Bottom bar */}
      <div
        ref={bottomRef}
        className="nav-bottom"
        style={{ pointerEvents: showBottomBar ? 'auto' : 'none' }}
        aria-hidden={!showBottomBar}
      >
        <div className="nav-bottom-left">
          {activeSegmentInfo ? (
            <span style={{ color: activeSegmentInfo.color }}>
              {activeSegmentInfo.label}
            </span>
          ) : mode === 'intro' && introHasStarted ? (
            <span style={{ color: '#4f6ca8' }}>Intro</span>
          ) : null}
        </div>
        <div className="nav-bottom-right">
          <button
            className="nav-btn nav-btn-close"
            title="Return to Intro"
            aria-label="Return to Intro"
            onClick={onExitTour}
            disabled={mode !== 'segment'}
            type="button"
          >
            &#x2716;
          </button>
          <button
            className="nav-btn nav-btn-sound"
            title="Sound playback is not implemented yet"
            aria-label="Sound playback not available"
            disabled
            type="button"
          >
            &#x266B;
          </button>
        </div>
      </div>
    </div>
  );
}
