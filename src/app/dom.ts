// Builds the app shell DOM and exposes the typed element references.
// Importing this module constructs the DOM (side effect) before any ref is read.

import "../styles.css";

function must<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

export function mountConversionLabDom(container: HTMLElement, options: { includeHeader?: boolean } = {}) {
  const includeHeader = options.includeHeader ?? true;
  container.innerHTML = `
  <main class="shell">
    ${includeHeader ? `<header class="topbar">
      <div>
        <h1>Windows XP Tour Conversion Lab</h1>
        <p>Ruffle reference playback beside a GSAP renderer driven by FFDec-extracted SWF assets and timeline matrices.</p>
      </div>
      <div class="topbar-meta">
        <button id="infoBtn" class="info-btn" type="button" aria-haspopup="dialog" title="About this lab — pipeline &amp; scope notes">i</button>
        <div class="source-mark">640 x 480 Flash 5</div>
      </div>
    </header>` : `<button id="infoBtn" class="info-btn native-info-btn" type="button" aria-haspopup="dialog" title="About the comparison renderer">i</button>`}

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
      <label>
        Asset source
        <select id="assetSource">
          <option value="files" selected>Generated files</option>
          <option value="pack">Packed bundle</option>
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
      <article class="panel debug-panel">
        <div class="panel-title">
          <h2>Display List Debug</h2>
          <span id="debugSummary"></span>
        </div>
        <div class="debug-tabs" role="tablist" aria-label="Display list debug views"><button class="debug-tab is-active" data-debug-tab="stage" type="button">On Stage</button><button class="debug-tab" data-debug-tab="labels" type="button">Labels</button><button class="debug-tab" data-debug-tab="actions" type="button">Actions</button><button class="debug-tab" data-debug-tab="live" type="button" title="Live player DOM: nodes in paint order across _levelN layers, with occlusion (what is drawn on top of a node)">Live</button><button class="debug-tab" data-debug-tab="trace" type="button" title="Record your click path through the player (with timing + position) so it can be replayed">Trace</button></div>
        <div id="traceBar" class="trace-bar" hidden>
          <button id="traceRecord" type="button" class="trace-btn">● Record</button>
          <button id="traceClear" type="button" class="trace-btn">Clear</button>
          <button id="traceCopy" type="button" class="trace-btn">Copy JSON</button>
          <span id="traceStatus" class="trace-status"></span>
        </div>
        <div id="liveFilters" class="live-filters" hidden>
          <input id="liveSearch" type="search" placeholder="filter: char id or text…" />
          <span id="liveLevelChips" class="live-chips"></span>
          <select id="liveKind" aria-label="Filter by node kind">
            <option value="">all kinds</option>
            <option value="text">text</option>
            <option value="img">img</option>
            <option value="hit">hit</option>
            <option value="svg">svg</option>
          </select>
          <label class="live-toggle"><input type="checkbox" id="liveHideEmpty" checked /> hide 0×0</label>
          <label class="live-toggle" title="Stop auto-refreshing so the list stays clickable (the view also auto-freezes while your pointer is over the panel)"><input type="checkbox" id="liveFreeze" /> freeze</label>
        </div>
        <div class="debug-body">
          <div id="debugList" class="debug-list"></div>
          <aside id="liveDetail" class="live-detail" hidden></aside>
        </div>
      </article>
    </section>

    <div id="referenceHolder" hidden>
      <span id="referenceName"></span>
      <img id="referenceFrameImage" alt="" />
      <div id="referenceFrameMeta">Frame 0</div>
    </div>

    <dialog id="infoModal" class="info-modal">
      <form method="dialog" class="info-modal-head">
        <h2>About the Conversion Lab</h2>
        <button class="info-close" value="close" type="submit" aria-label="Close">×</button>
      </form>
      <div class="info-modal-body">
        <h3>Asset Pipeline</h3>
        <p>Decompiled Player (default) drives the extracted symbols like Flash: a root playhead plus an independent playhead per sprite, embedded-font text, button hover/click, and sound — played entirely from the decompiled assets, no SWF at runtime. Frame SVG (reference) renders FFDec full-frame SVGs for fidelity comparison; Direct SWF Renderer parses the raw SWF in-browser.</p>
        <h3>Current Scope</h3>
        <p>The fidelity path now exports every SWF frame-by-frame and maps root labels, stops, root frame gotos, waiting loops, and supported button choices. Remaining work is nested MovieClip hit areas, clip-local state, and full button over/down behavior.</p>
      </div>
    </dialog>
  </main>
`;

  select = must<HTMLSelectElement>(container, "#sceneSelect");
  ruffleMount = must<HTMLDivElement>(container, "#ruffleMount");
  assetStage = must<HTMLDivElement>(container, "#assetStage");
  assetWrap = assetStage.parentElement as HTMLDivElement;
  frameStageImage = must<HTMLImageElement>(container, "#frameStageImage");
  frameStageInline = must<HTMLDivElement>(container, "#frameStageInline");
  gsapDisplayLayer = must<HTMLDivElement>(container, "#gsapDisplayLayer");
  directSwfLayer = must<HTMLDivElement>(container, "#directSwfLayer");
  externalLevelLayer = must<HTMLDivElement>(container, "#externalLevelLayer");
  awaitingLoopLayer = must<HTMLDivElement>(container, "#awaitingLoopLayer");
  emptyMessage = must<HTMLDivElement>(container, "#emptyMessage");
  status = must<HTMLSpanElement>(container, "#status");
  restartBtn = must<HTMLButtonElement>(container, "#restartBtn");
  playBtn = must<HTMLButtonElement>(container, "#playBtn");
  frameScrubber = must<HTMLInputElement>(container, "#frameScrubber");
  renderModeSelect = must<HTMLSelectElement>(container, "#renderMode");
  assetSourceSelect = must<HTMLSelectElement>(container, "#assetSource");
  ruffleName = must<HTMLSpanElement>(container, "#ruffleName");
  assetName = must<HTMLSpanElement>(container, "#assetName");
  referenceName = must<HTMLSpanElement>(container, "#referenceName");
  referenceFrameImage = must<HTMLImageElement>(container, "#referenceFrameImage");
  referenceFrameMeta = must<HTMLDivElement>(container, "#referenceFrameMeta");
  debugSummary = must<HTMLSpanElement>(container, "#debugSummary");
  debugList = must<HTMLDivElement>(container, "#debugList");
  playerLayer = must<HTMLDivElement>(container, "#playerLayer");
  infoBtn = must<HTMLButtonElement>(container, "#infoBtn");
  infoModal = must<HTMLDialogElement>(container, "#infoModal");
  liveFilters = must<HTMLDivElement>(container, "#liveFilters");
  liveSearch = must<HTMLInputElement>(container, "#liveSearch");
  liveKind = must<HTMLSelectElement>(container, "#liveKind");
  liveHideEmpty = must<HTMLInputElement>(container, "#liveHideEmpty");
  liveFreeze = must<HTMLInputElement>(container, "#liveFreeze");
  liveLevelChips = must<HTMLSpanElement>(container, "#liveLevelChips");
  liveDetail = must<HTMLElement>(container, "#liveDetail");
  traceBar = must<HTMLDivElement>(container, "#traceBar");
  traceRecord = must<HTMLButtonElement>(container, "#traceRecord");
  traceClear = must<HTMLButtonElement>(container, "#traceClear");
  traceCopy = must<HTMLButtonElement>(container, "#traceCopy");
  traceStatus = must<HTMLSpanElement>(container, "#traceStatus");
}

export let select!: HTMLSelectElement;
export let ruffleMount!: HTMLDivElement;
export let assetStage!: HTMLDivElement;
export let assetWrap!: HTMLDivElement;
export let frameStageImage!: HTMLImageElement;
export let frameStageInline!: HTMLDivElement;
export let gsapDisplayLayer!: HTMLDivElement;
export let directSwfLayer!: HTMLDivElement;
export let externalLevelLayer!: HTMLDivElement;
export let awaitingLoopLayer!: HTMLDivElement;
export let emptyMessage!: HTMLDivElement;
export let status!: HTMLSpanElement;
export let restartBtn!: HTMLButtonElement;
export let playBtn!: HTMLButtonElement;
export let frameScrubber!: HTMLInputElement;
export let renderModeSelect!: HTMLSelectElement;
export let assetSourceSelect!: HTMLSelectElement;
export let ruffleName!: HTMLSpanElement;
export let assetName!: HTMLSpanElement;
export let referenceName!: HTMLSpanElement;
export let referenceFrameImage!: HTMLImageElement;
export let referenceFrameMeta!: HTMLDivElement;
export let debugSummary!: HTMLSpanElement;
export let debugList!: HTMLDivElement;
export let playerLayer!: HTMLDivElement;
export let infoBtn!: HTMLButtonElement;
export let infoModal!: HTMLDialogElement;
export let liveFilters!: HTMLDivElement;
export let liveSearch!: HTMLInputElement;
export let liveKind!: HTMLSelectElement;
export let liveHideEmpty!: HTMLInputElement;
export let liveFreeze!: HTMLInputElement;
export let liveLevelChips!: HTMLSpanElement;
export let liveDetail!: HTMLElement;
export let traceBar!: HTMLDivElement;
export let traceRecord!: HTMLButtonElement;
export let traceClear!: HTMLButtonElement;
export let traceCopy!: HTMLButtonElement;
export let traceStatus!: HTMLSpanElement;
