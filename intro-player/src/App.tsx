import { useState } from 'react';
import { GsapTourPlayer } from './components/GsapTourPlayer';
import { RufflePlayer } from './components/RufflePlayer';
import './App.css';

function App() {
  const params = new URLSearchParams(window.location.search);
  const requestedMode = params.get('mode');
  const hasFrameParam = params.has('frame');
  const hasAutoplayParam = params.has('autoplay');
  const initialMode: 'compare' | 'ruffle' | 'gsap' =
    requestedMode === 'ruffle' || requestedMode === 'gsap' || requestedMode === 'compare'
      ? requestedMode
      : 'compare';
  const requestedFrame = (() => {
    const value = params.get('frame');
    if (value === null) return null;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  })();
  const autoplay = params.get('autoplay') !== '0';
  const gsapInitialFrame = hasFrameParam ? requestedFrame : 384;
  const gsapAutoplay = hasAutoplayParam ? autoplay : false;
  const ruffleReferenceSwf = '/A-tour.swf';

  const [mode, setMode] = useState<'compare' | 'ruffle' | 'gsap'>(initialMode);
  const [compareRunId, setCompareRunId] = useState(0);

  return (
    <div className="app">
      <div className="app-shell">
        <div className="app-toolbar">
          <div>
            <div className="app-title">Windows XP Tour Comparison</div>
            <div className="app-subtitle">
              Compare mode keeps the full A-tour Ruffle reference beside the GSAP-parsed nav menu so the original SWF-owned header, labels, and button states can be matched directly instead of through rebuilt HTML overlays.
            </div>
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

        {mode === 'compare' ? (
          <div className="app-compare-grid">
            <section className="app-pane">
              <div className="app-pane-label">Ruffle reference (A-tour.swf)</div>
              <RufflePlayer key={`compare-ruffle-${compareRunId}`} swfUrl={ruffleReferenceSwf} />
            </section>
            <section className="app-pane">
              <div className="app-pane-label">GSAP parsed nav menu</div>
              <GsapTourPlayer
                key={`compare-gsap-${compareRunId}`}
                showControls={false}
                initialFrame={gsapInitialFrame}
                autoplay={gsapAutoplay}
                screen="menu"
              />
            </section>
          </div>
        ) : mode === 'ruffle' ? (
          <RufflePlayer swfUrl={ruffleReferenceSwf} />
        ) : (
          <GsapTourPlayer initialFrame={gsapInitialFrame} autoplay={gsapAutoplay} screen="menu" />
        )}
      </div>
    </div>
  );
}

export default App;
