import { useState } from 'react';
import { GsapTourPlayer } from './components/GsapTourPlayer';
import { GsapPlayer } from './components/GsapPlayer';
import { NavOverlay } from './components/NavOverlay';
import { ReferenceFramePlayer } from './components/ReferenceFramePlayer';
import { RufflePlayer } from './components/RufflePlayer';
import './App.css';

const BUSINESS_REFERENCE_FRAME = 39;
const BUSINESS_TOTAL_FRAMES = 142;

function App() {
  const params = new URLSearchParams(window.location.search);
  const requestedMode = params.get('mode');
  const hasFrameParam = params.has('frame');
  const hasAutoplayParam = params.has('autoplay');
  const initialMode: 'compare' | 'ruffle' | 'gsap' =
    requestedMode === 'ruffle' || requestedMode === 'gsap' || requestedMode === 'compare'
      ? requestedMode
      : 'compare';
  const requestedScene = params.get('scene');
  const initialScene: 'business' | 'menu' = requestedScene === 'menu' ? 'menu' : 'business';
  const requestedFrame = (() => {
    const value = params.get('frame');
    if (value === null) return null;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  })();
  const autoplay = params.get('autoplay') !== '0';
  const gsapInitialFrame = hasFrameParam ? requestedFrame : null;
  const gsapAutoplay = hasAutoplayParam ? autoplay : true;

  const [mode, setMode] = useState<'compare' | 'ruffle' | 'gsap'>(initialMode);
  const [scene, setScene] = useState<'business' | 'menu'>(initialScene);
  const [compareRunId, setCompareRunId] = useState(0);
  const businessInitialFrame = gsapInitialFrame ?? BUSINESS_REFERENCE_FRAME;
  const businessAutoplay = hasFrameParam ? gsapAutoplay : false;

  const renderBusinessOverlay = () => (
    <div className="app-stage-overlay">
      <NavOverlay
        currentFrame={0}
        totalFrames={1}
        isPlaying={false}
        mode="segment"
        activeSegment={4}
        onSkipIntro={() => {}}
        onSegmentClick={() => {}}
        onExitTour={() => {}}
      />
    </div>
  );

  const subtitle = scene === 'business'
    ? 'Business compare pins both sides to extracted segment4 frame 39 with the XP chrome layered over it, so the subsection page is judged against the same exact frame instead of two drifting live players.'
    : 'Menu compare keeps the full A-tour Ruffle reference beside the GSAP-parsed nav menu so the original SWF-owned labels, button states, and attract-loop transitions can be matched directly instead of through rebuilt HTML overlays.';

  return (
    <div className="app">
      <div className="app-shell">
        <div className="app-toolbar">
          <div>
            <div className="app-title">Windows XP Tour Comparison</div>
            <div className="app-subtitle">{subtitle}</div>
          </div>

          <div className="app-toolbar-controls">
            <div className="app-scene-switch">
              <button
                className={`app-mode-btn ${scene === 'business' ? 'active' : ''}`}
                onClick={() => setScene('business')}
                type="button"
              >
                Business
              </button>
              <button
                className={`app-mode-btn ${scene === 'menu' ? 'active' : ''}`}
                onClick={() => setScene('menu')}
                type="button"
              >
                Menu
              </button>
            </div>

            <div className="app-mode-switch">
              {mode === 'compare' ? (
                <button
                  className="app-mode-btn"
                  onClick={() => setCompareRunId((id) => id + 1)}
                  type="button"
                >
                  Restart Compare
                </button>
              ) : null}
              <button
                className={`app-mode-btn ${mode === 'compare' ? 'active' : ''}`}
                onClick={() => setMode('compare')}
                type="button"
              >
                Compare
              </button>
              <button
                className={`app-mode-btn ${mode === 'ruffle' ? 'active' : ''}`}
                onClick={() => setMode('ruffle')}
                type="button"
              >
                Ruffle
              </button>
              <button
                className={`app-mode-btn ${mode === 'gsap' ? 'active' : ''}`}
                onClick={() => setMode('gsap')}
                type="button"
              >
                GSAP Parsed
              </button>
            </div>
          </div>
        </div>

        {mode === 'compare' ? (
          <div className="app-compare-grid">
            <section className="app-pane">
              <div className="app-pane-label">
                {scene === 'business'
                  ? 'Reference frame (segment4 frame 39 + XP chrome)'
                  : 'Ruffle reference (A-tour.swf)'}
              </div>
              {scene === 'business' ? (
                <ReferenceFramePlayer
                  key={`compare-ref-business-${compareRunId}`}
                  frame={BUSINESS_REFERENCE_FRAME}
                  totalFrames={BUSINESS_TOTAL_FRAMES}
                  srcBase="/segment-assets/4/frames"
                  overlay={renderBusinessOverlay()}
                />
              ) : (
                <RufflePlayer
                  key={`compare-ruffle-${scene}-${compareRunId}`}
                  swfUrl="/A-tour.swf"
                  overlay={undefined}
                />
              )}
            </section>
            <section className="app-pane">
              <div className="app-pane-label">
                {scene === 'business'
                  ? 'GSAP parsed segment4.swf at frame 39 + XP chrome'
                  : 'GSAP parsed nav menu'}
              </div>
              {scene === 'business' ? (
                <GsapPlayer
                  key={`compare-gsap-business-${compareRunId}`}
                  showControls={false}
                  showOverlay={false}
                  overlay={renderBusinessOverlay()}
                  initialSegment={4}
                  initialFrame={businessInitialFrame}
                  autoplay={businessAutoplay}
                />
              ) : (
                <GsapTourPlayer
                  key={`compare-gsap-menu-${compareRunId}`}
                  showControls={false}
                  initialFrame={gsapInitialFrame}
                  autoplay={gsapAutoplay}
                  screen="menu"
                />
              )}
            </section>
          </div>
        ) : mode === 'ruffle' ? (
          <RufflePlayer
            swfUrl={scene === 'business' ? '/segment4.swf' : '/A-tour.swf'}
            overlay={scene === 'business' ? renderBusinessOverlay() : undefined}
          />
        ) : (
          scene === 'business' ? (
            <GsapPlayer
              showControls
              showOverlay={false}
              overlay={renderBusinessOverlay()}
              initialSegment={4}
              initialFrame={businessInitialFrame}
              autoplay={businessAutoplay}
            />
          ) : (
            <GsapTourPlayer initialFrame={gsapInitialFrame} autoplay={gsapAutoplay} screen="menu" />
          )
        )}
      </div>
    </div>
  );
}

export default App;
