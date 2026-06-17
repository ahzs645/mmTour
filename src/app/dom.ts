// Builds the app shell DOM and exposes the typed element references.
// Importing this module constructs the DOM (side effect) before any ref is read.

import "../styles.css";

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app root");

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>Windows XP Tour Conversion Lab</h1>
        <p>Ruffle reference playback beside a GSAP renderer driven by FFDec-extracted SWF assets and timeline matrices.</p>
      </div>
      <div class="source-mark">640 x 480 Flash 5</div>
    </header>

    <section class="controls" aria-label="Playback controls">
      <label>
        Source SWF
        <select id="sceneSelect"></select>
      </label>
      <label>
        GSAP frame
        <input id="frameScrubber" type="range" min="0" max="0" value="0" />
      </label>
      <label>
        Render mode
        <select id="renderMode">
          <option value="player" selected>Decompiled Player</option>
          <option value="frame">Frame SVG (reference)</option>
          <option value="direct">Direct SWF Renderer</option>
        </select>
      </label>
      <button id="playBtn" type="button">Play GSAP</button>
      <button id="restartBtn" type="button">Restart</button>
      <span id="status" class="status">Ready</span>
    </section>

    <section class="comparison-grid">
      <article class="panel">
        <div class="panel-title">
          <h2>Ruffle Reference</h2>
          <span id="ruffleName"></span>
        </div>
        <div id="ruffleMount" class="stage-wrap"></div>
      </article>

      <article class="panel">
        <div class="panel-title">
          <h2>Decompiled Player</h2>
          <span id="assetName"></span>
        </div>
        <div class="stage-wrap">
          <div id="assetStage" class="asset-stage" aria-label="GSAP player using extracted SWF assets">
            <img id="frameStageImage" class="frame-stage-image" alt="" />
            <div id="frameStageInline" class="frame-stage-inline" aria-hidden="true"></div>
            <div id="gsapDisplayLayer" class="gsap-display-layer" aria-hidden="true"></div>
            <div id="playerLayer" class="player-layer" aria-hidden="true" hidden></div>
            <div id="directSwfLayer" class="direct-swf-layer" aria-hidden="true"></div>
            <div id="externalLevelLayer" class="external-level-layer" aria-hidden="true"></div>
            <div id="awaitingLoopLayer" class="awaiting-loop-layer" aria-hidden="true"></div>
            <div id="emptyMessage" class="empty-message">Run FFDec export for this SWF to build its asset timeline.</div>
          </div>
        </div>
      </article>
    </section>

    <section class="analysis-grid">
      <article class="panel reference-panel">
        <div class="panel-title">
          <h2>Static Frame Reference</h2>
          <span id="referenceName"></span>
        </div>
        <div class="reference-frame-stage">
          <img id="referenceFrameImage" class="reference-frame-image" alt="Generated static frame reference" />
          <div id="referenceFrameMeta" class="reference-frame-meta">Frame 0</div>
        </div>
      </article>
      <article class="panel debug-panel">
        <div class="panel-title">
          <h2>Display List Debug</h2>
          <span id="debugSummary"></span>
        </div>
        <div class="debug-tabs" role="tablist" aria-label="Display list debug views">
          <button class="debug-tab is-active" data-debug-tab="stage" type="button">On Stage</button>
          <button class="debug-tab" data-debug-tab="labels" type="button">Labels</button>
          <button class="debug-tab" data-debug-tab="actions" type="button">Actions</button>
        </div>
        <div id="debugList" class="debug-list"></div>
      </article>
      <article class="notes">
        <h2>Asset Pipeline</h2>
        <p>Decompiled Player (default) drives the extracted symbols like Flash: a root playhead plus an independent playhead per sprite, embedded-font text, button hover/click, and sound — played entirely from the decompiled assets, no SWF at runtime. Frame SVG (reference) renders FFDec full-frame SVGs for fidelity comparison; Direct SWF Renderer parses the raw SWF in-browser.</p>
      </article>
      <article class="notes">
        <h2>Current Scope</h2>
        <p>The fidelity path now exports every SWF frame-by-frame and maps root labels, stops, root frame gotos, waiting loops, and supported button choices. Remaining work is nested MovieClip hit areas, clip-local state, and full button over/down behavior.</p>
      </article>
    </section>
  </main>
`;

export const select = must<HTMLSelectElement>("#sceneSelect");
export const ruffleMount = must<HTMLDivElement>("#ruffleMount");
export const assetStage = must<HTMLDivElement>("#assetStage");
export const assetWrap = assetStage.parentElement as HTMLDivElement;
export const frameStageImage = must<HTMLImageElement>("#frameStageImage");
export const frameStageInline = must<HTMLDivElement>("#frameStageInline");
export const gsapDisplayLayer = must<HTMLDivElement>("#gsapDisplayLayer");
export const directSwfLayer = must<HTMLDivElement>("#directSwfLayer");
export const externalLevelLayer = must<HTMLDivElement>("#externalLevelLayer");
export const awaitingLoopLayer = must<HTMLDivElement>("#awaitingLoopLayer");
export const emptyMessage = must<HTMLDivElement>("#emptyMessage");
export const status = must<HTMLSpanElement>("#status");
export const restartBtn = must<HTMLButtonElement>("#restartBtn");
export const playBtn = must<HTMLButtonElement>("#playBtn");
export const frameScrubber = must<HTMLInputElement>("#frameScrubber");
export const renderModeSelect = must<HTMLSelectElement>("#renderMode");
export const ruffleName = must<HTMLSpanElement>("#ruffleName");
export const assetName = must<HTMLSpanElement>("#assetName");
export const referenceName = must<HTMLSpanElement>("#referenceName");
export const referenceFrameImage = must<HTMLImageElement>("#referenceFrameImage");
export const referenceFrameMeta = must<HTMLDivElement>("#referenceFrameMeta");
export const debugSummary = must<HTMLSpanElement>("#debugSummary");
export const debugList = must<HTMLDivElement>("#debugList");
export const playerLayer = must<HTMLDivElement>("#playerLayer");
