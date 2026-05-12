import { gsap } from "gsap";
import { GsapDisplayListRenderer, type GsapDisplayDebugEntry } from "./gsap-display-list-renderer";
import { GsapSwfRenderer } from "./engine/GsapSwfRenderer";
import { parseSwfFile } from "./engine/SwfParser";
import { scenes, type TourScene } from "./data";
import "./styles.css";

declare global {
  interface Window {
    RufflePlayer?: {
      newest: () => {
        createPlayer: () => RuffleElement;
      };
    };
  }
}

type RuffleElement = HTMLElement & {
  load?: (config: { url: string }) => Promise<void>;
  ruffle?: () => {
    load: (config: { url: string } | string) => Promise<void>;
  };
};

type Matrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
};

type TimelineAsset = {
  id: number;
  kind: "shape" | "sprite" | "image" | "text" | "button" | "font" | "sound";
  src?: string;
  frames?: string[];
  states?: Record<string, { src: string; origin: TimelineAsset["origin"] }>;
  origin: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type TimelineFrame = {
  index: number;
  label: string;
  instances: Array<{
    depth: number;
    characterId: number;
    placedFrame: number;
    matrix: Matrix;
    opacity: number;
    name: string;
    clipDepth?: number;
    colorTransform?: {
      rm?: number;
      gm?: number;
      bm?: number;
      am?: number;
      ra?: number;
      ga?: number;
      ba?: number;
      aa?: number;
    };
  }>;
};

type ControlAction = {
  target?: string;
  command?: "stop" | "play" | "gotoAndPlay" | "gotoAndStop" | "doRelease" | "loadMovieNum" | "loadVariables" | "playVO" | "markSndSegment" | "attachSound" | "stopSound" | "callFunctions";
  label?: string;
  frame?: number;
  frameExpression?: string;
  level?: string | number;
  swf?: string;
  sound?: string;
  soundSrc?: string;
  soundRole?: "voiceover" | "music";
  segment?: string;
  ramp?: string;
  exitNavigation?: {
    variable: string;
    value: string;
    swf: string;
    exitLabel?: string;
    exitFrame: number;
  };
  functionCalls?: Array<{
    target: string;
    functionName: string;
    arguments?: string;
  }>;
  nestedSection?: {
    label: string;
    frame: number;
  };
  rootFunctionSound?: {
    sound: string;
    soundSrc: string;
    functionName: string;
    arguments?: string;
    sourceFunction: string;
  };
  targetPlacement?: {
    characterId: number;
    matrix: Matrix;
    width?: number;
    height?: number;
  };
  source: string;
  supported?: boolean;
  reason?: string;
  functionName?: string;
  functionBranchCondition?: string;
  branchCondition?: string;
  executionContext?: "timeline" | "function" | "branch";
};

type RenderedLoopItem = {
  element: HTMLDivElement;
  image: HTMLImageElement;
  asset: TimelineAsset & { frames: string[] };
  instance: TimelineFrame["instances"][number];
  spriteFrame: number;
  stopped: boolean;
};

type ButtonControl = {
  ownerSpriteIds?: number[];
  release?: ControlAction;
  rollOver?: ControlAction;
  rollOut?: ControlAction;
};

type ButtonDefinition = {
  id: number;
  states?: {
    up?: ButtonStateRecord[];
    over?: ButtonStateRecord[];
    down?: ButtonStateRecord[];
    hitTest?: ButtonStateRecord[];
  };
  hitAreas?: ButtonStateRecord[];
};

type ButtonStateRecord = {
  characterId: number;
  depth: number;
  matrix: Matrix;
};

type DynamicTextControl = {
  characterId: number;
  variableName: string;
  normalizedVariableName: string;
  text: string;
  fontHeight?: number;
  leading?: number;
  color?: string;
  align?: "left" | "center" | "right" | "justify";
  multiline?: boolean;
  wordWrap?: boolean;
  html?: boolean;
};

type RuntimeGlobalValue = string | number | boolean;
type SceneEntryTarget = {
  label?: string;
  frame?: number;
  frameExpression?: string;
};

type AssetTimeline = {
  scene: string;
  source: string;
  dimensions: { width: number; height: number };
  backgroundColor: string;
  fps: number;
  frameCount: number;
  duration: number;
  entryFrame?: number;
  labels?: Record<string, number>;
  control?: {
    stopFrames?: number[];
    spriteStopFrames?: Record<string, number[]>;
    spriteLocalDefaults?: Record<string, Record<string, RuntimeGlobalValue>>;
    frameActions?: Array<{
      frame: number;
      source: string;
      actions: ControlAction[];
    }>;
    spriteActions?: Array<{
      spriteId: number;
      frame: number;
      source: string;
      actions: ControlAction[];
    }>;
    dynamicTexts?: Record<string, DynamicTextControl>;
    buttonActions?: Record<string, ButtonControl>;
    buttonDefinitions?: ButtonDefinition[];
    soundLibrary?: Record<string, { name: string; src: string }>;
    globalDefaults?: Record<string, RuntimeGlobalValue>;
    nestedSectionTargets?: Record<string, { label: string; frame: number }>;
    nestedMovieClips?: Array<{
      spriteId: number;
      labels?: Record<string, number>;
    }>;
    segmentNavigation?: Array<{ swf: string }>;
  };
  frameSvgs: string[];
  assets: Record<string, TimelineAsset>;
  frames: TimelineFrame[];
};

type RenderedInstance = {
  characterId: number;
  element: HTMLDivElement;
  content: HTMLElement;
};

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
          <option value="frame" selected>Frame SVG</option>
          <option value="asset">Asset Timeline</option>
          <option value="gsap">GSAP Display List</option>
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
          <h2>GSAP Asset Timeline</h2>
          <span id="assetName"></span>
        </div>
        <div class="stage-wrap">
          <div id="assetStage" class="asset-stage" aria-label="GSAP player using extracted SWF assets">
            <img id="frameStageImage" class="frame-stage-image" alt="" />
            <div id="frameStageInline" class="frame-stage-inline" aria-hidden="true"></div>
            <div id="gsapDisplayLayer" class="gsap-display-layer" aria-hidden="true"></div>
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
        <p>Frame SVG mode uses FFDec-exported root SVG frames from the original SWF vectors, bitmaps, and text. Asset Timeline mode exposes placed symbols for inspection. GSAP Display List mode keeps those symbols as live DOM nodes and updates them through GSAP.</p>
      </article>
      <article class="notes">
        <h2>Current Scope</h2>
        <p>The fidelity path now exports every SWF frame-by-frame and maps root labels, stops, root frame gotos, waiting loops, and supported button choices. Remaining work is nested MovieClip hit areas, clip-local state, and full button over/down behavior.</p>
      </article>
    </section>
  </main>
`;

const select = must<HTMLSelectElement>("#sceneSelect");
const ruffleMount = must<HTMLDivElement>("#ruffleMount");
const assetStage = must<HTMLDivElement>("#assetStage");
const assetWrap = assetStage.parentElement as HTMLDivElement;
const frameStageImage = must<HTMLImageElement>("#frameStageImage");
const frameStageInline = must<HTMLDivElement>("#frameStageInline");
const gsapDisplayLayer = must<HTMLDivElement>("#gsapDisplayLayer");
const directSwfLayer = must<HTMLDivElement>("#directSwfLayer");
const externalLevelLayer = must<HTMLDivElement>("#externalLevelLayer");
const awaitingLoopLayer = must<HTMLDivElement>("#awaitingLoopLayer");
const emptyMessage = must<HTMLDivElement>("#emptyMessage");
const status = must<HTMLSpanElement>("#status");
const restartBtn = must<HTMLButtonElement>("#restartBtn");
const playBtn = must<HTMLButtonElement>("#playBtn");
const frameScrubber = must<HTMLInputElement>("#frameScrubber");
const renderModeSelect = must<HTMLSelectElement>("#renderMode");
const ruffleName = must<HTMLSpanElement>("#ruffleName");
const assetName = must<HTMLSpanElement>("#assetName");
const referenceName = must<HTMLSpanElement>("#referenceName");
const referenceFrameImage = must<HTMLImageElement>("#referenceFrameImage");
const referenceFrameMeta = must<HTMLDivElement>("#referenceFrameMeta");
const debugSummary = must<HTMLSpanElement>("#debugSummary");
const debugList = must<HTMLDivElement>("#debugList");

renderModeSelect.selectedIndex = 0;
renderModeSelect.value = "frame";

let activeScene = scenes.find((scene) => scene.swf === "segment4.swf") ?? scenes[0];
let rufflePlayer: RuffleElement | null = null;
let timeline: gsap.core.Timeline | null = null;
let activeAssetTimeline: AssetTimeline | null = null;
let directSwfRenderer: GsapSwfRenderer | null = null;
let directSwfScene = "";
let directSwfLoad: Promise<GsapSwfRenderer | null> | null = null;
let renderedInstances = new Map<number, RenderedInstance>();
let activeDebugTab: "stage" | "labels" | "actions" = "stage";
let highlightedDepth: number | null = null;
let isGsapPlaying = false;
let isAwaitingSelection = false;
let isNestedSectionActive = false;
let frameSvgRequest = 0;
let assetTimelineVersion = 0;
let awaitingLoopTimer = 0;
let awaitingLoopTick = 0;
let hoverSpriteTimer = 0;
let hoverSpriteElement: HTMLDivElement | null = null;
let buttonStateElement: SVGImageElement | null = null;
let currentVoiceover: HTMLAudioElement | null = null;
let currentMusic: HTMLAudioElement | null = null;
let lastSoundFrameKey = "";
let lastFrameFunctionCallKey = "";
let lastPlayedFrameIndex = -1;
let lastPlayedScene = "";
const playedSpriteSoundKeys = new Set<string>();
const runtimeGlobals: Record<string, RuntimeGlobalValue> = {};
const loadedLevelSwfs: Record<number, string> = { 4: activeScene.swf };
const hiddenHoverSources: SVGGraphicsElement[] = [];
const hiddenAwaitingSources: SVGGraphicsElement[] = [];
let isRunningExtractedAction = false;
const frameSvgCache = new Map<string, string>();
const assetTimelineCache = new Map<string, AssetTimeline>();
const loadedFontFaceKeys = new Set<string>();
const gsapDisplayRenderer = new GsapDisplayListRenderer(gsapDisplayLayer);
const externalLevels = new Map<number, {
  swf: string;
  frame: number;
  element: HTMLDivElement;
  image: HTMLImageElement;
  timeline?: AssetTimeline;
}>();
const pendingExternalLevelCalls = new Map<number, NonNullable<ControlAction["functionCalls"]>>();
const stageResizeObserver = new ResizeObserver(syncAssetStageScale);

select.innerHTML = scenes.map((scene, index) => `<option value="${index}">${scene.label} - ${scene.swf}</option>`).join("");
select.value = String(scenes.indexOf(activeScene));

select.addEventListener("change", () => {
  activeScene = scenes[Number(select.value)] ?? scenes[0];
  void loadScene(activeScene);
});

restartBtn.addEventListener("click", () => {
  if (isDirectRenderMode()) {
    void restartDirectRenderer();
  } else {
    goToFrame(activeAssetTimeline?.entryFrame ?? 0, false);
  }
  void loadRuffle(activeScene).catch((error) => {
    console.warn(`Ruffle reference failed to reload ${activeScene.swf}`, error);
  });
});

playBtn.addEventListener("click", () => {
  if (isDirectRenderMode()) {
    void toggleDirectRendererPlayback();
    return;
  }

  if (!timeline || isAwaitingSelection) return;
  if (isGsapPlaying) {
    isGsapPlaying = false;
    updatePlayButton();
    timeline.pause();
    return;
  }

  const currentFrame = Number(frameScrubber.value);
  const startFrame = activeAssetTimeline && shouldStopAtFrame(activeAssetTimeline, currentFrame)
    ? Math.min(currentFrame + 1, activeAssetTimeline.frameCount - 1)
    : currentFrame;
  goToFrame(startFrame, true);
});

frameScrubber.addEventListener("input", () => {
  if (isDirectRenderMode()) {
    isGsapPlaying = false;
    updatePlayButton();
    void renderDirectSwfFrame(Number(frameScrubber.value));
    return;
  }

  if (!activeAssetTimeline || !timeline) return;
  isGsapPlaying = false;
  playBtn.textContent = "Play GSAP";
  const frame = Number(frameScrubber.value);
  goToFrame(frame, false);
});

renderModeSelect.addEventListener("change", () => {
  if (!activeAssetTimeline) return;
  renderFrame(activeAssetTimeline, Number(frameScrubber.value));
});

document.querySelectorAll<HTMLButtonElement>(".debug-tab").forEach((button) => {
  button.addEventListener("click", () => {
    activeDebugTab = (button.dataset.debugTab as typeof activeDebugTab | undefined) ?? "stage";
    document.querySelectorAll<HTMLButtonElement>(".debug-tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab === button);
    });
    if (isDirectRenderMode() && directSwfRenderer) {
      updateDirectDebugPanel(directSwfRenderer);
      return;
    }
    updateDebugPanel();
  });
});

void loadScene(activeScene);
stageResizeObserver.observe(assetWrap);

async function loadScene(scene: TourScene, entryTarget?: SceneEntryTarget, preserveExternalLevels = false, autoPlay = false) {
  status.textContent = `Loading ${scene.swf}`;
  ruffleName.textContent = `${scene.length.toFixed(2)}s`;
  await loadAssetTimeline(scene, entryTarget, preserveExternalLevels, autoPlay);
  void loadRuffle(scene).catch((error) => {
    console.warn(`Ruffle reference failed to load ${scene.swf}`, error);
  });
}

async function navigateToSceneBySwf(swf: string, entryTarget?: SceneEntryTarget) {
  const targetScene = scenes.find((scene) => scene.swf.toLowerCase() === swf.toLowerCase());
  if (!targetScene) {
    status.textContent = `Missing generated scene for ${swf}`;
    return;
  }

  activeScene = targetScene;
  if (/^segment\d+\.swf$/i.test(targetScene.swf)) loadedLevelSwfs[4] = targetScene.swf;
  select.value = String(scenes.indexOf(activeScene));
  await loadScene(activeScene, entryTarget, true, true);
}

async function loadRuffle(scene: TourScene) {
  await waitForRuffle();
  rufflePlayer = window.RufflePlayer!.newest().createPlayer();
  rufflePlayer.classList.add("ruffle-player");
  rufflePlayer.setAttribute("width", "640");
  rufflePlayer.setAttribute("height", "480");
  ruffleMount.replaceChildren(rufflePlayer);
  const url = `/${scene.swf}`;
  if (rufflePlayer.ruffle) {
    await rufflePlayer.ruffle().load({ url });
  } else if (rufflePlayer.load) {
    await rufflePlayer.load({ url });
  } else {
    throw new Error("Ruffle player exposes no load API");
  }
}

function isDirectRenderMode() {
  return renderModeSelect.value === "direct";
}

function destroyDirectRenderer() {
  directSwfRenderer?.destroy();
  directSwfRenderer = null;
  directSwfScene = "";
  directSwfLoad = null;
}

async function ensureDirectRenderer(scene: TourScene) {
  if (directSwfRenderer && directSwfScene === scene.swf) return directSwfRenderer;
  if (directSwfLoad && directSwfScene === scene.swf) return directSwfLoad;

  destroyDirectRenderer();
  directSwfScene = scene.swf;
  status.textContent = `Parsing ${scene.swf} directly`;

  directSwfLoad = parseSwfFile(`/${scene.swf}`)
    .then((movie) => {
      directSwfLayer.replaceChildren();
      const renderer = new GsapSwfRenderer(movie, directSwfLayer, {
        hiddenCharacterIds: scene.swf === "nav.swf" ? [8, 56] : [],
      });
      if (scene.swf === "nav.swf") {
        renderer.bootstrapMovie({
          tick: 2,
          globals: [{ path: "_level0.bkgd.OSVersion", value: "Per" }],
          functionName: "startAddedNav",
        });
      }
      renderer.onFrameChange = (frame) => {
        if (!isDirectRenderMode()) return;
        frameScrubber.max = String(renderer.totalFrames - 1);
        frameScrubber.value = String(frame);
        status.dataset.mode = renderer.isPlaying ? "playing" : "stopped";
        status.textContent = `${renderer.isPlaying ? "Playing" : "Ready at"} direct ${scene.swf} frame ${frame + 1}`;
        updateDirectDebugPanel(renderer, frame);
        updatePlayButton();
      };
      renderer.onPlaybackChange = (playing) => {
        if (!isDirectRenderMode()) return;
        isGsapPlaying = playing;
        status.dataset.mode = playing ? "playing" : "stopped";
        status.textContent = `${playing ? "Playing" : "Ready at"} direct ${scene.swf} frame ${renderer.currentFrame + 1}`;
        updatePlayButton();
      };
      directSwfRenderer = renderer;
      return renderer;
    })
    .catch((error) => {
      console.warn(`Direct SWF renderer failed to parse ${scene.swf}`, error);
      status.dataset.mode = "stopped";
      status.textContent = `Direct renderer failed for ${scene.swf}`;
      directSwfRenderer = null;
      return null;
    })
    .finally(() => {
      directSwfLoad = null;
    });

  return directSwfLoad;
}

async function renderDirectSwfFrame(frameIndex: number) {
  const renderer = await ensureDirectRenderer(activeScene);
  if (!renderer || !isDirectRenderMode() || directSwfScene !== activeScene.swf) return;

  frameScrubber.max = String(renderer.totalFrames - 1);
  const frame = Math.max(0, Math.min(renderer.totalFrames - 1, frameIndex));
  renderer.seekToFrame(frame);
  updateDirectDebugPanel(renderer, frame);
}

async function toggleDirectRendererPlayback() {
  const renderer = await ensureDirectRenderer(activeScene);
  if (!renderer || !isDirectRenderMode()) return;

  if (renderer.isPlaying) {
    renderer.pause();
    isGsapPlaying = false;
  } else {
    renderer.play();
    isGsapPlaying = true;
  }
  updatePlayButton();
}

async function restartDirectRenderer() {
  const renderer = await ensureDirectRenderer(activeScene);
  if (!renderer || !isDirectRenderMode()) return;

  renderer.restart();
  frameScrubber.max = String(renderer.totalFrames - 1);
  frameScrubber.value = "0";
  isGsapPlaying = false;
  updateDirectDebugPanel(renderer, 0);
  updatePlayButton();
}

function updateDirectDebugPanel(renderer: GsapSwfRenderer, frameIndex = renderer.currentFrame) {
  if (!isDirectRenderMode()) return;

  const entries: GsapDisplayDebugEntry[] = renderer.getAllElements()
    .map(({ depth, charId, element }) => {
      element.dataset.depth = String(depth);
      return {
        depth,
        characterId: charId,
        kind: element.classList.contains("swf-text")
          ? "text"
          : element.classList.contains("swf-image")
            ? "image"
            : element.classList.contains("swf-sprite")
              ? "sprite"
              : "shape",
        name: "",
        placedFrame: frameIndex,
        isMask: element.style.visibility === "hidden",
        opacity: Number.parseFloat(element.style.opacity || "1"),
        src: "",
      };
    });

  debugSummary.textContent = `${entries.length} direct items`;
  if (activeDebugTab === "stage") {
    renderStageDebug(activeAssetTimeline, entries);
  } else if (activeDebugTab === "labels") {
    if (activeAssetTimeline) {
      renderLabelDebug(activeAssetTimeline, frameIndex);
    } else {
      renderDirectMetadataDebug(renderer, "Direct SWF labels are evaluated internally by the renderer.");
    }
  } else {
    if (activeAssetTimeline) {
      renderActionDebug(activeAssetTimeline, frameIndex);
    } else {
      renderDirectMetadataDebug(renderer, "Direct SWF ActionScript is parsed at runtime for timeline control.");
    }
  }
  referenceFrameMeta.textContent = `Direct frame ${frameIndex + 1}`;
  applyDepthHighlight();
}

function renderDirectMetadataDebug(renderer: GsapSwfRenderer, message: string) {
  debugList.replaceChildren();
  const item = document.createElement("div");
  item.className = "debug-empty";
  item.textContent = `${message} ${renderer.totalFrames} frames @ ${renderer.fps} fps.`;
  debugList.append(item);
}

async function loadAssetTimeline(scene: TourScene, entryTarget?: SceneEntryTarget, preserveExternalLevels = false, autoPlay = false) {
  timeline?.kill();
  activeAssetTimeline = null;
  isGsapPlaying = false;
  lastPlayedFrameIndex = -1;
  lastPlayedScene = "";
  destroyDirectRenderer();
  stopAwaitingLoop();
  stopCurrentVoiceover();
  lastSoundFrameKey = "";
  lastFrameFunctionCallKey = "";
  playedSpriteSoundKeys.clear();
  renderedInstances = new Map();
  assetStage.querySelectorAll(".asset-instance").forEach((node) => node.remove());
  gsapDisplayRenderer.clear();
  directSwfLayer.hidden = true;
  directSwfLayer.replaceChildren();
  externalLevelLayer.hidden = false;
  highlightedDepth = null;
  frameStageImage.removeAttribute("src");
  frameStageInline.replaceChildren();
  referenceFrameImage.removeAttribute("src");
  referenceName.textContent = "No generated frame";
  referenceFrameMeta.textContent = "Frame 0";
  debugSummary.textContent = "";
  debugList.replaceChildren();
  if (!preserveExternalLevels) clearExternalLevels();
  clearButtonVisualState();
  awaitingLoopLayer.replaceChildren();
  assetStage.style.background = "#ffffff";
  emptyMessage.hidden = false;
  assetName.textContent = "No generated timeline";
  frameScrubber.max = "0";
  frameScrubber.value = "0";

  const loadedTimeline = await fetchAssetTimeline(scene.swf);
  if (!loadedTimeline) {
    status.textContent = `No extracted asset timeline for ${scene.swf}`;
    return;
  }

  activeAssetTimeline = loadedTimeline;
  await loadExtractedFonts(activeAssetTimeline);
  if (!activeAssetTimeline.frameSvgs?.length) {
    activeAssetTimeline.frameSvgs = Array.from(
      { length: activeAssetTimeline.frameCount },
      (_, index) => `generated/${activeAssetTimeline!.scene}/frames/${index + 1}.svg`,
    );
  }
  assetTimelineVersion += 1;
  renderModeSelect.selectedIndex = 0;
  renderModeSelect.value = "frame";
  assetStage.style.background = activeAssetTimeline.backgroundColor ?? "#ffffff";
  frameScrubber.max = String(activeAssetTimeline.frameCount - 1);
  const entryFrame = resolveSceneEntryFrame(activeAssetTimeline, entryTarget);
  frameScrubber.value = String(entryFrame);
  emptyMessage.hidden = true;
  assetName.textContent = `${activeAssetTimeline.frameCount} frames @ ${activeAssetTimeline.fps} fps`;
  buildGsapAssetPlayer(activeAssetTimeline);
  goToFrame(entryFrame, autoPlay);
}

async function fetchAssetTimeline(swf: string) {
  const cacheKey = swf.toLowerCase();
  const cached = assetTimelineCache.get(cacheKey);
  if (cached) return cached;

  const sceneName = swf.replace(/\.swf$/i, "");
  const response = await fetch(`/generated/${sceneName}/timeline.json?v=${Date.now()}`);
  if (!response.ok) return null;

  const assetTimeline = (await response.json()) as AssetTimeline;
  if (!assetTimeline.frameSvgs?.length) {
    assetTimeline.frameSvgs = Array.from(
      { length: assetTimeline.frameCount },
      (_, index) => `generated/${assetTimeline.scene}/frames/${index + 1}.svg`,
    );
  }
  assetTimelineCache.set(cacheKey, assetTimeline);
  return assetTimeline;
}

async function loadExtractedFonts(assetTimeline: AssetTimeline) {
  if (!("fonts" in document)) return;

  const fontAssets = Object.values(assetTimeline.assets ?? {})
    .filter((asset) => asset.kind === "font" && asset.src);
  if (!fontAssets.length) return;

  const loads: Promise<void>[] = [];
  for (const asset of fontAssets) {
    const families = fontFamiliesForAsset(asset);
    for (const family of families) {
      const key = `${family}:${asset.src}`;
      if (loadedFontFaceKeys.has(key)) continue;
      loadedFontFaceKeys.add(key);
      const face = new FontFace(family, `url(/${asset.src})`, {
        style: "normal",
        weight: family.includes("Medium") ? "700" : "400",
      });
      loads.push(face.load().then((loadedFace) => {
        document.fonts.add(loadedFace);
      }));
    }
  }

  await Promise.allSettled(loads);
}

function fontFamiliesForAsset(asset: TimelineAsset) {
  const fileName = asset.src?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  const familyFromFile = fileName.replace(/^\d+_/, "").replace(/_/g, " ").trim();
  return [...new Set([
    familyFromFile,
    familyFromFile.replace(/\s+/g, ""),
    "Franklin Gothic Medium",
    "Franklin Gothic",
    "FranklinGothic",
    "XP Franklin Gothic",
  ].filter(Boolean))];
}

function extractedFontFamilyStack() {
  return [
    '"Franklin Gothic Medium"',
    '"Franklin Gothic"',
    '"FranklinGothic"',
    '"XP Franklin Gothic"',
    '"Arial Narrow"',
    "Arial",
    "sans-serif",
  ].join(", ");
}

function buildGsapAssetPlayer(assetTimeline: AssetTimeline) {
  const state = { frame: 0 };
  const setFrame = () => {
    const frame = Math.round(state.frame);
    frameScrubber.value = String(frame);
    renderFrame(assetTimeline, frame);
  };

  setFrame();
  timeline = gsap.timeline({ repeat: -1, paused: true });
  timeline.to(state, {
    frame: assetTimeline.frames.length - 1,
    duration: assetTimeline.duration,
    ease: `steps(${assetTimeline.frames.length - 1})`,
    onUpdate: setFrame,
    onRepeat: setFrame,
  });
}

function processPlaybackFrameActions(
  assetTimeline: AssetTimeline,
  frameIndex: number,
): "continue" | "stopped" | "navigated" | "gotoFrame" {
  if (shouldStopAtFrame(assetTimeline, frameIndex)) {
    timeline?.pause(frameIndex / assetTimeline.fps);
    isGsapPlaying = false;
    if (frameIndex !== Number(frameScrubber.value)) frameScrubber.value = String(frameIndex);
    setFrameStatus(assetTimeline, frameIndex, 0);
    return "stopped";
  }

  const swfLoadActions = rootSwfLoadActionsAtFrame(assetTimeline, frameIndex);
  for (const action of swfLoadActions) rememberLoadedLevel(action, assetTimeline, frameIndex);
  const swfAction = primaryRootSwfNavigation(swfLoadActions);
  if (swfAction?.swf) {
    isRunningExtractedAction = true;
    runtimeGlobals["nav.targSection"] = "";
    queueShellLevelCallsForLoadedScene(assetTimeline, frameIndex, swfAction.swf);
    status.textContent = `Loading ${swfAction.swf}`;
    void navigateToSceneBySwf(swfAction.swf).finally(() => {
      isRunningExtractedAction = false;
    });
    return "navigated";
  }

  const levelGoto = rootLevelGotoAtFrame(assetTimeline, frameIndex);
  if (levelGoto) {
    const targetSwf = loadedLevelSwfs[levelGoto.level];
    if (targetSwf) {
      isRunningExtractedAction = true;
      runtimeGlobals["nav.targSection"] = "";
      status.textContent = `Loading ${targetSwf}`;
      void navigateToSceneBySwf(targetSwf, levelGoto.action).finally(() => {
        isRunningExtractedAction = false;
      });
      return "navigated";
    }
  }

  const extractedAction = rootTimelineActionAtFrame(assetTimeline, frameIndex);
  const targetFrame = extractedAction ? resolveRuntimeFrame(extractedAction, assetTimeline, frameIndex) : -1;
  if (extractedAction && targetFrame >= 0 && targetFrame !== frameIndex) {
    isRunningExtractedAction = true;
    goToFrame(targetFrame, extractedAction.command === "gotoAndPlay");
    isRunningExtractedAction = false;
    return "gotoFrame";
  }

  if (frameIndex !== Math.round(Number(frameScrubber.value))) {
    triggerFrameSounds(assetTimeline, frameIndex);
    runFrameFunctionCalls(assetTimeline, frameIndex);
  }

  return "continue";
}

function renderFrame(assetTimeline: AssetTimeline, index: number) {
  const frame = assetTimeline.frames[Math.max(0, Math.min(assetTimeline.frames.length - 1, index))];
  const mode = renderModeSelect.value;
  updateStaticReference(assetTimeline, frame.index);

  if (mode === "direct") {
    timeline?.pause();
    isGsapPlaying = Boolean(directSwfRenderer?.isPlaying);
    stopAwaitingLoop();
    clearButtonVisualState();
    frameSvgRequest += 1;
    frameStageImage.hidden = true;
    frameStageInline.replaceChildren();
    assetStage.querySelectorAll(".asset-instance").forEach((node) => node.remove());
    renderedInstances.clear();
    gsapDisplayLayer.hidden = true;
    externalLevelLayer.hidden = true;
    awaitingLoopLayer.replaceChildren();
    directSwfLayer.hidden = false;
    void renderDirectSwfFrame(frame.index);
    return;
  }

  directSwfRenderer?.pause();
  directSwfLayer.hidden = true;
  externalLevelLayer.hidden = false;

  if (!isRunningExtractedAction && isGsapPlaying) {
    if (lastPlayedScene !== assetTimeline.scene) {
      lastPlayedScene = assetTimeline.scene;
      lastPlayedFrameIndex = -1;
    }
    const startWalk = lastPlayedFrameIndex >= 0 && lastPlayedFrameIndex < frame.index
      ? lastPlayedFrameIndex + 1
      : frame.index;
    for (let walkFrame = startWalk; walkFrame <= frame.index; walkFrame += 1) {
      const outcome = processPlaybackFrameActions(assetTimeline, walkFrame);
      if (outcome === "stopped") {
        lastPlayedFrameIndex = walkFrame;
        return;
      }
      if (outcome === "navigated") {
        lastPlayedFrameIndex = -1;
        lastPlayedScene = "";
        return;
      }
      if (outcome === "gotoFrame") {
        lastPlayedFrameIndex = -1;
        return;
      }
      lastPlayedFrameIndex = walkFrame;
    }
  }

  if (mode === "frame" && assetTimeline.frameSvgs?.length) {
    triggerFrameSounds(assetTimeline, frame.index);
    runFrameFunctionCalls(assetTimeline, frame.index);
    assetStage.querySelectorAll(".asset-instance").forEach((node) => node.remove());
    renderedInstances.clear();
    gsapDisplayLayer.hidden = true;
    frameStageImage.hidden = true;
    void renderInlineFrameSvg(assetTimeline.frameSvgs[frame.index], assetTimelineVersion, frame.index);
    updateDebugPanel(assetTimeline, frame.index);
    return;
  }

  if (mode === "gsap") {
    frameSvgRequest += 1;
    frameStageImage.hidden = true;
    frameStageInline.replaceChildren();
    assetStage.querySelectorAll(".asset-instance").forEach((node) => node.remove());
    renderedInstances.clear();
    clearButtonVisualState();
    triggerFrameSounds(assetTimeline, frame.index);
    runFrameFunctionCalls(assetTimeline, frame.index);
    gsapDisplayLayer.hidden = false;
    gsapDisplayRenderer.renderFrame(assetTimeline, frame.index);
    setFrameStatus(assetTimeline, frame.index, 0);
    updateDebugPanel(assetTimeline, frame.index, gsapDisplayRenderer.getDebugEntries());
    return;
  }

  gsapDisplayLayer.hidden = true;
  frameStageImage.hidden = true;
  frameStageInline.replaceChildren();
  triggerFrameSounds(assetTimeline, frame.index);
  runFrameFunctionCalls(assetTimeline, frame.index);
  const liveDepths = new Set<number>();

  for (const instance of frame.instances) {
    const asset = assetTimeline.assets[String(instance.characterId)];
    if (!asset) continue;

    liveDepths.add(instance.depth);
    const rendered = ensureRenderedInstance(instance.depth, instance.characterId, asset, frame.index);
    const { a, b, c, d, tx, ty } = instance.matrix;
    rendered.element.style.zIndex = String(instance.depth);
    rendered.element.style.opacity = String(instance.opacity);
    rendered.element.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`;

    if (asset.kind === "sprite" && asset.frames?.length && rendered.content instanceof HTMLImageElement) {
      const spriteFrame = Math.max(0, frame.index - instance.placedFrame) % asset.frames.length;
      rendered.content.src = `/${asset.frames[spriteFrame]}`;
    }
  }

  for (const [depth, rendered] of renderedInstances) {
    if (!liveDepths.has(depth)) {
      rendered.element.remove();
      renderedInstances.delete(depth);
    }
  }

  setFrameStatus(assetTimeline, frame.index, 0);
  updateDebugPanel(assetTimeline, frame.index);
}

async function renderInlineFrameSvg(src: string, version: number, frameIndex: number) {
  const url = `/${src}?v=${version}`;
  const request = ++frameSvgRequest;
  let svg = frameSvgCache.get(url);

  if (!svg) {
    const response = await fetch(url);
    if (!response.ok) return;
    svg = await response.text();
    svg = svg.replace(/<\?xml[^>]*>\s*/i, "");
    frameSvgCache.set(url, svg);
  }

  if (request !== frameSvgRequest || renderModeSelect.value !== "frame") return;
  clearButtonVisualState();
  frameStageInline.innerHTML = svg;
  const element = frameStageInline.querySelector("svg");
  element?.classList.add("inline-frame-svg");
  applyDynamicTextOverrides();
  if (activeAssetTimeline) applyFrameActionTargetOverlays(activeAssetTimeline, frameIndex);
  if (activeAssetTimeline) applyStoppedSpriteOverlays(activeAssetTimeline, frameIndex);
  const wiredTargets = wireInlineFrameControls(frameIndex);
  if (activeAssetTimeline) setFrameStatus(activeAssetTimeline, frameIndex, wiredTargets);
}

function applyStoppedSpriteOverlays(assetTimeline: AssetTimeline, frameIndex: number) {
  const frame = assetTimeline.frames[frameIndex];
  if (!frame) return;

  const candidateIds = new Set(
    frame.instances
      .filter((instance) => {
        const asset = assetTimeline.assets[String(instance.characterId)];
        if (!asset || asset.kind !== "sprite" || !asset.frames?.length) return false;
        const relativeFrame = Math.max(0, frame.index - instance.placedFrame);
        return !hasReachedSpriteStop(assetTimeline, instance.characterId, relativeFrame);
      })
      .map((instance) => instance.characterId),
  );

  for (const instance of frame.instances) {
    if (candidateIds.has(instance.characterId)) continue;
    const asset = assetTimeline.assets[String(instance.characterId)];
    if (!asset || asset.kind !== "sprite" || !asset.frames?.length) continue;
    const relativeFrame = Math.max(0, frame.index - instance.placedFrame);
    const stops = assetTimeline.control?.spriteStopFrames?.[String(instance.characterId)] ?? [];
    if (!stops.length) continue;
    const sortedStops = [...stops].sort((a, b) => a - b);
    if (relativeFrame < sortedStops[0]) continue;
    const stopFrame = sortedStops[0];
    const targetFrameIndex = Math.max(0, Math.min(asset.frames.length - 1, stopFrame));

    hideStaticSpriteSource(instance.characterId);

    const element = document.createElement("div");
    element.className = "stopped-sprite-instance";
    element.style.zIndex = String(instance.depth);
    const { a, b, c, d, tx, ty } = instance.matrix;
    element.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`;

    const image = document.createElement("img");
    image.className = "stopped-sprite-content";
    image.decoding = "async";
    image.draggable = false;
    image.style.left = `${-asset.origin.x}px`;
    image.style.top = `${-asset.origin.y}px`;
    image.style.width = `${asset.origin.width}px`;
    image.style.height = `${asset.origin.height}px`;
    image.src = `/${asset.frames[targetFrameIndex]}`;
    element.append(image);
    frameStageInline.append(element);
  }
}

function hideStaticSpriteSource(characterId: number) {
  const target = String(characterId);
  const nodes = frameStageInline.querySelectorAll<SVGGraphicsElement>("use, g");
  for (const node of nodes) {
    const value = node.getAttribute("ffdec:characterId") ?? node.getAttribute("ffdec:characterid");
    if (value !== target) continue;
    if (node.closest(".flash-button-overlay-layer")) continue;
    node.style.visibility = "hidden";
  }
}

function goToFrame(index: number, play: boolean) {
  if (!activeAssetTimeline || !timeline) return false;

  const frame = Math.max(0, Math.min(activeAssetTimeline.frameCount - 1, index));
  timeline.pause(frame / activeAssetTimeline.fps);
  frameScrubber.value = String(frame);
  lastPlayedFrameIndex = play ? frame - 1 : frame;
  lastPlayedScene = activeAssetTimeline.scene;
  renderFrame(activeAssetTimeline, frame);

  const stoppedByFrameAction = play && shouldStopAtFrame(activeAssetTimeline, frame);
  isGsapPlaying = play && !stoppedByFrameAction;
  updatePlayButton();
  if (isGsapPlaying) timeline.play(frame / activeAssetTimeline.fps);
  if (stoppedByFrameAction) {
    timeline.pause(frame / activeAssetTimeline.fps);
    setFrameStatus(activeAssetTimeline, frame, 0);
  }
  return stoppedByFrameAction;
}

function shouldStopAtFrame(assetTimeline: AssetTimeline, frame: number) {
  if (assetTimeline.control?.stopFrames?.includes(frame)) return true;
  return frameActionsAt(assetTimeline, frame).some((action) => action.command === "stop");
}

function applyDynamicTextOverrides() {
  const dynamicTexts = activeAssetTimeline?.control?.dynamicTexts;
  if (!dynamicTexts || !Object.keys(dynamicTexts).length) return;

  const svg = frameStageInline.querySelector<SVGSVGElement>("svg");
  const root = svg ? ([...svg.children].find((child) => child.tagName.toLowerCase() === "g") as SVGGElement | undefined) : undefined;
  if (!svg || !root) return;

  svg.querySelectorAll(".dynamic-text-overlay-layer").forEach((node) => node.remove());
  const overlayLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  overlayLayer.classList.add("dynamic-text-overlay-layer");
  svg.append(overlayLayer);

  const rendered = new Set<Element>();
  walkVisibleSvgTree(root, new DOMMatrix(), (element, matrix) => {
    const characterId = ffdecCharacterId(element);
    const textControl = characterId ? dynamicTexts[characterId] : undefined;
    if (!textControl || rendered.has(element)) return;

    const width = Number.parseFloat(element.getAttribute("width") ?? "0");
    const height = Number.parseFloat(element.getAttribute("height") ?? "0");
    if (width <= 0 || height <= 0) return;

    rendered.add(element);
    if (element instanceof SVGGraphicsElement && !element.closest(".dynamic-text-overlay-layer")) {
      element.style.visibility = "hidden";
    }

    const foreignObject = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
    foreignObject.classList.add("dynamic-text-frame");
    foreignObject.dataset.character = characterId;
    foreignObject.setAttribute("x", "0");
    foreignObject.setAttribute("y", "0");
    foreignObject.setAttribute("width", String(width));
    foreignObject.setAttribute("height", String(height));
    foreignObject.setAttribute("transform", matrixToSvg(matrix));

    const textElement = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    textElement.classList.add("dynamic-text-box");
    textElement.textContent = textControl.text;
    textElement.style.color = textControl.color || "#3366cc";
    textElement.style.fontFamily = extractedFontFamilyStack();
    textElement.style.fontSize = `${Math.max(1, textControl.fontHeight || 12)}px`;
    textElement.style.lineHeight = `${Math.max(1, (textControl.fontHeight || 12) + (textControl.leading || 0))}px`;
    textElement.style.textAlign = textControl.align || "left";
    textElement.style.whiteSpace = textControl.wordWrap || textControl.multiline ? "pre-wrap" : "pre";
    foreignObject.append(textElement);
    overlayLayer.append(foreignObject);
  });
}

function triggerFrameSounds(assetTimeline: AssetTimeline, frameIndex: number) {
  const key = `${assetTimeline.scene}:${frameIndex}`;
  if (lastSoundFrameKey === key) return;
  lastSoundFrameKey = key;

  const musicAction = frameActionsAt(assetTimeline, frameIndex).find((action) => action.command === "attachSound" && action.soundRole === "music" && action.soundSrc);
  if (musicAction?.soundSrc) {
    playBackgroundMusic(musicAction).catch((error) => {
      console.debug(`Background music playback deferred for ${musicAction.sound}`, error);
    });
  }

  const soundAction = frameActionsAt(assetTimeline, frameIndex).find((action) => action.command === "playVO" && action.soundSrc);
  if (!soundAction?.soundSrc) return;

  playVoiceover(soundAction).catch((error) => {
    console.debug(`Voiceover playback deferred for ${soundAction.sound}`, error);
  });
}

function triggerSpriteFrameSounds(assetTimeline: AssetTimeline, spriteId: number, spriteFrame: number, scope: string) {
  const soundActions = spriteActionsAt(assetTimeline, spriteId, spriteFrame)
    .filter((action) => action.command === "playVO" && action.soundSrc);

  for (const action of soundActions) {
    const key = `${assetTimeline.scene}:${scope}:${spriteId}:${spriteFrame}:${action.sound}`;
    if (playedSpriteSoundKeys.has(key)) continue;
    playedSpriteSoundKeys.add(key);
    playVoiceover(action).catch((error) => {
      console.debug(`Nested voiceover playback deferred for ${action.sound}`, error);
    });
  }
}

function runFrameFunctionCalls(assetTimeline: AssetTimeline, frameIndex: number) {
  const key = `${assetTimeline.scene}:${frameIndex}`;
  if (lastFrameFunctionCallKey === key) return;
  lastFrameFunctionCallKey = key;

  for (const action of frameActionsAt(assetTimeline, frameIndex).filter((action) => action.command === "callFunctions" && action.functionCalls?.length)) {
    runFunctionCalls(assetTimeline, action.functionCalls!, frameIndex);
  }
}

async function playVoiceover(action: ControlAction) {
  if (!action.soundSrc) return;
  stopCurrentVoiceover();

  const audio = new Audio(`/${action.soundSrc}`);
  audio.preload = "auto";
  currentVoiceover = audio;
  await audio.play();
}

async function playBackgroundMusic(action: ControlAction) {
  if (!action.soundSrc || currentMusic?.dataset.sound === action.sound) return;
  stopCurrentMusic();

  const audio = new Audio(`/${action.soundSrc}`);
  audio.preload = "auto";
  audio.loop = true;
  audio.volume = 0.35;
  audio.dataset.sound = action.sound ?? "";
  currentMusic = audio;
  await audio.play();
}

function stopCurrentVoiceover() {
  if (!currentVoiceover) return;
  currentVoiceover.pause();
  currentVoiceover.currentTime = 0;
  currentVoiceover = null;
}

function stopCurrentMusic() {
  if (!currentMusic) return;
  currentMusic.pause();
  currentMusic.currentTime = 0;
  currentMusic = null;
}

function wireInlineFrameControls(frameIndex: number) {
  if (!activeAssetTimeline?.control?.buttonActions) return 0;

  let wiredTargets = 0;
  const svg = frameStageInline.querySelector<SVGSVGElement>("svg");
  if (!svg) return 0;
  svg.querySelectorAll(".flash-button-overlay").forEach((node) => node.remove());
  const overlayLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  overlayLayer.classList.add("flash-button-overlay-layer");
  svg.append(overlayLayer);

  for (const [characterId, action] of Object.entries(activeAssetTimeline.control.buttonActions)) {
    const release = action.release;
    if (!release) continue;

    const nodes = frameStageInline.querySelectorAll<SVGGraphicsElement>(`[ffdec\\:characterId="${characterId}"]`);
    for (const node of nodes) {
      wiredTargets += 1;
      node.classList.add("flash-button-target");
      bindReleaseAction(node, release);
      node.addEventListener("mouseenter", () => handleButtonHover(characterId, "rollOver", frameIndex));
      node.addEventListener("mouseleave", () => handleButtonHover(characterId, "rollOut", frameIndex));
    }
  }

  const overlays = createButtonHitOverlays(svg, overlayLayer, activeAssetTimeline, frameIndex);
  const timelineOverlays = createTimelineButtonHitOverlays(svg, overlayLayer, activeAssetTimeline, frameIndex);
  return Math.max(wiredTargets, overlays + timelineOverlays);
}

function handleReleaseClick(event: Event, release: ControlAction) {
  event.preventDefault();
  event.stopPropagation();
  if (release.exitNavigation) {
    if (!activeAssetTimeline) return;
    runtimeGlobals[release.exitNavigation.variable] = release.exitNavigation.value;
    goToFrame(release.exitNavigation.exitFrame, true);
    status.textContent = `Playing ${release.exitNavigation.exitLabel ?? "exit navigation"} toward ${release.exitNavigation.swf}`;
    return;
  }

  if (release.functionCalls?.length && activeAssetTimeline) {
    const handled = runFunctionCalls(activeAssetTimeline, release.functionCalls, Number(frameScrubber.value));
    if (handled) {
      status.textContent = `Ran ${release.functionCalls.map((call) => call.functionName).join(", ")}`;
      const hasPrimaryAction = Boolean(
        release.swf
          || release.nestedSection
          || release.command === "gotoAndPlay"
          || release.command === "gotoAndStop",
      );
      if (!hasPrimaryAction || release.command === "callFunctions") return;
    }
  }

  if (release.swf) {
    status.textContent = `Loading ${release.swf}`;
    void navigateToSceneBySwf(release.swf);
    return;
  }

  if (!activeAssetTimeline) return;
  if (release.nestedSection) {
    goToFrame(release.nestedSection.frame, true);
    status.textContent = `Playing nested section at ${release.nestedSection.label}`;
    return;
  }

  const targetFrame = resolveRuntimeFrame(release, activeAssetTimeline, Number(frameScrubber.value));
  if (targetFrame < 0) {
    status.textContent = `Unsupported action in ${release.source}`;
    return;
  }

  const stoppedByFrameAction = goToFrame(targetFrame, release.command === "gotoAndPlay");
  if (!stoppedByFrameAction) {
    const target = release.label ?? `frame ${targetFrame + 1}`;
    status.textContent = `${release.command}("${target}")`;
  }
}

function runFunctionCalls(
  assetTimeline: AssetTimeline,
  calls: NonNullable<ControlAction["functionCalls"]>,
  frameIndex: number,
): boolean {
  let handled = false;
  for (const call of calls) {
    if (runExternalLevelFunctionCall(call)) {
      handled = true;
      continue;
    }

    const instance = findFrameInstanceByTarget(assetTimeline, frameIndex, call.target);
    if (!instance) continue;

    const asset = assetTimeline.assets[String(instance.characterId)];
    if (asset?.kind !== "sprite" || !asset.frames?.length) continue;
    const spriteAsset = asset as TimelineAsset & { frames: string[] };
    const functionGlobals = {
      ...runtimeValues(assetTimeline),
      ...(assetTimeline.control?.spriteLocalDefaults?.[String(instance.characterId)] ?? {}),
    };
    const actions = functionActionsFor(assetTimeline, instance.characterId, call.functionName)
      .filter((action) => evaluateFunctionActionCondition(action, functionGlobals));
    if (!actions.length) continue;

    const currentSpriteFrame = Math.max(0, frameIndex - instance.placedFrame);
    const goto = actions.find((action) => action.target === "self" && (action.command === "gotoAndPlay" || action.command === "gotoAndStop"));
    if (goto) {
      const targetFrame = resolveSpriteFrame(goto, spriteAsset, currentSpriteFrame, assetTimeline, instance.characterId);
      if (targetFrame >= 0) {
        renderFunctionSpriteOverlay(assetTimeline, instance, spriteAsset, targetFrame, goto.command === "gotoAndPlay");
        handled = true;
      }
    }

    for (const action of actions.filter((action) => action.command === "playVO" || action.command === "attachSound")) {
      void playVoiceover(action);
      handled = true;
    }

    for (const action of actions.filter((action) => action.command === "callFunctions" && action.functionCalls?.length)) {
      handled = runFunctionCalls(assetTimeline, action.functionCalls!, frameIndex) || handled;
    }

    if (actions.some((action) => action.command === "stopSound")) {
      stopCurrentVoiceover();
      handled = true;
    }
  }

  const rootActions = rootFunctionActionsFor(assetTimeline, calls)
    .filter((action) => evaluateFunctionActionCondition(action, runtimeValues(assetTimeline)));
  for (const action of rootActions) {
    if (action.command === "stopSound") {
      stopCurrentVoiceover();
      handled = true;
    } else if (action.command === "playVO" || action.command === "attachSound") {
      void playVoiceover(action);
      handled = true;
    } else if (action.command === "callFunctions" && action.functionCalls?.length) {
      handled = runFunctionCalls(assetTimeline, action.functionCalls, frameIndex) || handled;
    }
  }

  return handled;
}

function runExternalLevelFunctionCall(call: NonNullable<ControlAction["functionCalls"]>[number]) {
  const levelMatch = call.target.match(/^_level(\d+)$/i);
  if (!levelMatch) return false;

  const level = Number.parseInt(levelMatch[1], 10);
  const record = externalLevels.get(level);
  if (!record?.timeline) {
    queueExternalLevelCall(level, call);
    return true;
  }
  const levelTimeline = record.timeline;

  const actions = externalRootFunctionActionsFor(levelTimeline, call.functionName)
    .filter((action) => evaluateFunctionActionCondition(action, runtimeValues(levelTimeline)));
  if (!actions.length) return false;

  let handled = false;
  for (const action of actions) {
    if ((action.command === "gotoAndPlay" || action.command === "gotoAndStop") && (action.target === "self" || !action.target)) {
      const targetFrame = resolveRuntimeFrame(action, levelTimeline, record.frame);
      if (targetFrame >= 0) {
        renderExternalLevelFrame(level, targetFrame);
        handled = true;
      }
    } else if (action.command === "callFunctions" && action.functionCalls?.length) {
      handled = runFunctionCalls(record.timeline, action.functionCalls, record.frame) || handled;
    }
  }

  return handled;
}

function queueExternalLevelCall(level: number, call: NonNullable<ControlAction["functionCalls"]>[number]) {
  const calls = pendingExternalLevelCalls.get(level) ?? [];
  const duplicate = calls.some((candidate) => (
    candidate.target === call.target
    && candidate.functionName === call.functionName
    && candidate.arguments === call.arguments
  ));
  if (!duplicate) pendingExternalLevelCalls.set(level, [...calls, call]);
}

function queueExternalLevelCallsAtFrame(assetTimeline: AssetTimeline, frame: number, level: number) {
  const frameCalls = frameActionsAt(assetTimeline, frame)
    .filter((action) => action.command === "callFunctions" && action.functionCalls?.length)
    .flatMap((action) => action.functionCalls ?? []);
  const rootCalls = rootFunctionActionsFor(assetTimeline, frameCalls)
    .filter((action) => evaluateFunctionActionCondition(action, runtimeValues(assetTimeline)))
    .filter((action) => action.command === "callFunctions" && action.functionCalls?.length)
    .flatMap((action) => action.functionCalls ?? []);

  for (const call of [...frameCalls, ...rootCalls]) {
    if (callLevel(call) === level) queueExternalLevelCall(level, call);
  }
}

function queueShellLevelCallsForLoadedScene(assetTimeline: AssetTimeline, frame: number, swf: string) {
  const sceneFunctionNames = shellFunctionsInvokedByScene(swf);
  if (!sceneFunctionNames.length) return;

  const actions = assetTimeline.control?.frameActions
    ?.flatMap((entry) => entry.actions)
    .filter((action) => {
      return action.command === "callFunctions"
        && action.functionName
        && sceneFunctionNames.includes(action.functionName)
        && action.functionCalls?.length
        && evaluateFunctionActionCondition(action, runtimeValues(assetTimeline));
    }) ?? [];

  for (const action of actions) {
    for (const call of action.functionCalls ?? []) {
      const level = callLevel(call);
      if (level !== undefined) queueExternalLevelCall(level, call);
    }
  }
}

function shellFunctionsInvokedByScene(swf: string) {
  if (swf.toLowerCase() !== "intro.swf") return [];
  return ["LoadIntroNav"];
}

function callLevel(call: NonNullable<ControlAction["functionCalls"]>[number]) {
  const match = call.target.match(/^_level(\d+)(?:\.|$)/i);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function flushPendingExternalLevelCalls(level: number) {
  const calls = pendingExternalLevelCalls.get(level);
  if (!calls?.length) return;

  pendingExternalLevelCalls.delete(level);
  for (const call of calls) runExternalLevelFunctionCall(call);
}

function findFrameInstanceByTarget(assetTimeline: AssetTimeline, frameIndex: number, target: string) {
  const frame = assetTimeline.frames[frameIndex];
  const targetKeys = actionTargetKeys(target);
  return frame?.instances.find((instance) => instanceTargetKeys(instance.name).some((key) => targetKeys.includes(key)));
}

function functionActionsFor(assetTimeline: AssetTimeline, spriteId: number, functionName: string) {
  return assetTimeline.control?.spriteActions
    ?.filter((entry) => entry.spriteId === spriteId)
    .flatMap((entry) => entry.actions)
    .filter((action) => action.functionName === functionName) ?? [];
}

function rootFunctionActionsFor(assetTimeline: AssetTimeline, calls: NonNullable<ControlAction["functionCalls"]>) {
  const rootFunctionNames = calls
    .filter((call) => call.target === "_root" || call.target === "_parent" || call.target === "_level0")
    .map((call) => call.functionName);
  if (!rootFunctionNames.length) return [];

  return assetTimeline.control?.frameActions
    ?.flatMap((entry) => entry.actions)
    .filter((action) => action.functionName && rootFunctionNames.includes(action.functionName)) ?? [];
}

function externalRootFunctionActionsFor(assetTimeline: AssetTimeline, functionName: string) {
  return assetTimeline.control?.frameActions
    ?.flatMap((entry) => entry.actions)
    .filter((action) => action.functionName === functionName) ?? [];
}

function evaluateFunctionActionCondition(action: ControlAction, globals: Record<string, RuntimeGlobalValue>) {
  if (!action.functionBranchCondition) return true;
  return evaluateBranchCondition(action.functionBranchCondition, globals) === true;
}

function renderFunctionSpriteOverlay(
  assetTimeline: AssetTimeline,
  instance: TimelineFrame["instances"][number],
  asset: TimelineAsset & { frames: string[] },
  startFrame: number,
  play: boolean,
) {
  hideStaticAwaitingSource(instance.characterId);
  awaitingLoopLayer.querySelectorAll(`[data-function-target="${instance.characterId}"]`).forEach((node) => node.remove());

  const element = document.createElement("div");
  element.className = "awaiting-loop-instance function-call-instance";
  element.dataset.functionTarget = String(instance.characterId);
  element.style.zIndex = String(instance.depth + 500);
  const { a, b, c, d, tx, ty } = instance.matrix;
  element.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`;

  const image = document.createElement("img");
  image.className = "awaiting-loop-content";
  image.decoding = "async";
  image.draggable = false;
  image.style.left = `${-asset.origin.x}px`;
  image.style.top = `${-asset.origin.y}px`;
  image.style.width = `${asset.origin.width}px`;
  image.style.height = `${asset.origin.height}px`;
  element.append(image);
  awaitingLoopLayer.append(element);
  const sourceItem: RenderedLoopItem = {
    element,
    image,
    asset,
    instance,
    spriteFrame: startFrame,
    stopped: false,
  };

  let spriteFrame = Math.max(0, Math.min(asset.frames.length - 1, startFrame));
  const render = () => {
    image.src = `/${asset.frames[spriteFrame]}`;
    triggerSpriteFrameSounds(assetTimeline, instance.characterId, spriteFrame, `function:${instance.characterId}`);
    for (const action of spriteActionsAt(assetTimeline, instance.characterId, spriteFrame)) {
      runNestedFunctionCallAction(assetTimeline, action, sourceItem);
    }
    if (!play || hasReachedSpriteStopSince(assetTimeline, instance.characterId, spriteFrame, startFrame)) return false;
    spriteFrame = Math.min(spriteFrame + 1, asset.frames.length - 1);
    sourceItem.spriteFrame = spriteFrame;
    return spriteFrame < asset.frames.length - 1;
  };

  if (!render()) return;
  const timer = window.setInterval(() => {
    if (!render()) window.clearInterval(timer);
  }, 1000 / Math.max(1, assetTimeline.fps));
}

function bindReleaseAction(element: Element, release: ControlAction) {
  let handled = false;
  const run = (event: Event) => {
    if (handled) return;
    handled = true;
    handleReleaseClick(event, release);
  };
  element.addEventListener("pointerup", run);
  element.addEventListener("click", run);
}

function createButtonHitOverlays(
  svg: SVGSVGElement,
  overlayLayer: SVGGElement,
  assetTimeline: AssetTimeline,
  frameIndex: number,
) {
  const buttonActions = assetTimeline.control?.buttonActions;
  if (!buttonActions) return 0;

  const root = [...svg.children].find((child) => child.tagName.toLowerCase() === "g") as SVGGElement | undefined;
  if (!root) return 0;

  let count = 0;
  const hitCharacterToButton = buttonHitCharacterMap(assetTimeline);

  walkVisibleSvgTree(root, new DOMMatrix(), (element, matrix) => {
    const characterId = ffdecCharacterId(element);
    if (!characterId) return;

    const buttonId = hitCharacterToButton.get(characterId) ?? characterId;
    const release = buttonActions[buttonId]?.release;
    if (!release) return;

    const width = Number.parseFloat(element.getAttribute("width") ?? "0");
    const height = Number.parseFloat(element.getAttribute("height") ?? "0");
    if (width <= 0 || height <= 0) return;

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.classList.add("flash-button-overlay");
    rect.dataset.character = buttonId;
    rect.dataset.hitCharacter = characterId;
    rect.setAttribute("x", "0");
    rect.setAttribute("y", "0");
    rect.setAttribute("width", String(width));
    rect.setAttribute("height", String(height));
    rect.setAttribute("transform", matrixToSvg(matrix));
    bindReleaseAction(rect, release);
    rect.addEventListener("mouseenter", () => {
      showButtonVisualState(overlayLayer, assetTimeline, buttonId, "over", matrix);
      handleButtonHover(buttonId, "rollOver", frameIndex);
    });
    rect.addEventListener("mouseleave", () => {
      clearButtonVisualState();
      handleButtonHover(buttonId, "rollOut", frameIndex);
    });
    rect.addEventListener("pointerdown", () => showButtonVisualState(overlayLayer, assetTimeline, buttonId, "down", matrix));
    rect.addEventListener("pointerup", () => showButtonVisualState(overlayLayer, assetTimeline, buttonId, "over", matrix));
    rect.addEventListener("pointerover", () => showButtonVisualState(overlayLayer, assetTimeline, buttonId, "over", matrix));
    rect.addEventListener("pointerout", clearButtonVisualState);
    overlayLayer.append(rect);
    count += 1;
  });

  return count;
}

function buttonHitCharacterMap(assetTimeline: AssetTimeline) {
  const mapped = new Map<string, string>();
  for (const definition of assetTimeline.control?.buttonDefinitions ?? []) {
    const buttonId = String(definition.id);
    for (const record of definition.hitAreas ?? definition.states?.hitTest ?? []) {
      mapped.set(String(record.characterId), buttonId);
    }
  }
  return mapped;
}

function createTimelineButtonHitOverlays(
  svg: SVGSVGElement,
  overlayLayer: SVGGElement,
  assetTimeline: AssetTimeline,
  frameIndex: number,
) {
  const buttonActions = assetTimeline.control?.buttonActions;
  const frame = assetTimeline.frames[frameIndex];
  if (!buttonActions || !frame) return 0;

  let count = 0;
  for (const [characterId, action] of Object.entries(buttonActions)) {
    if (!action.release || svg.querySelector(`.flash-button-overlay[data-character="${characterId}"]`)) continue;

    const ownerInstance = frame.instances.find((instance) => action.ownerSpriteIds?.includes(instance.characterId));
    if (!ownerInstance) continue;

    const ownerAsset = assetTimeline.assets[String(ownerInstance.characterId)];
    if (!ownerAsset || ownerAsset.origin.width <= 0 || ownerAsset.origin.height <= 0) continue;

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.classList.add("flash-button-overlay", "flash-button-owner-overlay");
    rect.dataset.character = characterId;
    rect.dataset.ownerCharacter = String(ownerInstance.characterId);
    rect.setAttribute("x", String(-ownerAsset.origin.x));
    rect.setAttribute("y", String(-ownerAsset.origin.y));
    rect.setAttribute("width", String(ownerAsset.origin.width));
    rect.setAttribute("height", String(ownerAsset.origin.height));
    rect.setAttribute("transform", timelineMatrixToSvg(ownerInstance.matrix));
    bindReleaseAction(rect, action.release as ControlAction);
    const matrix = timelineMatrixToDomMatrix(ownerInstance.matrix);
    rect.addEventListener("mouseenter", () => {
      showButtonVisualState(overlayLayer, assetTimeline, characterId, "over", matrix);
      handleButtonHover(characterId, "rollOver", frameIndex);
    });
    rect.addEventListener("mouseleave", () => {
      clearButtonVisualState();
      handleButtonHover(characterId, "rollOut", frameIndex);
    });
    rect.addEventListener("pointerdown", () => showButtonVisualState(overlayLayer, assetTimeline, characterId, "down", matrix));
    rect.addEventListener("pointerup", () => showButtonVisualState(overlayLayer, assetTimeline, characterId, "over", matrix));
    rect.addEventListener("pointerover", () => showButtonVisualState(overlayLayer, assetTimeline, characterId, "over", matrix));
    rect.addEventListener("pointerout", clearButtonVisualState);
    overlayLayer.append(rect);
    count += 1;
  }

  return count;
}

function showButtonVisualState(
  overlayLayer: SVGGElement,
  assetTimeline: AssetTimeline,
  buttonId: string,
  state: "over" | "down" | "up",
  matrix: DOMMatrix,
) {
  const buttonAsset = assetTimeline.assets[`button:${buttonId}`];
  const exactStateAsset = buttonAsset?.states?.[state];
  const stateAsset = exactStateAsset ?? buttonAsset?.states?.up;
  if (!stateAsset || stateAsset.origin.width <= 0 || stateAsset.origin.height <= 0) return;

  clearButtonVisualState();
  const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
  image.classList.add("flash-button-state-overlay");
  image.dataset.character = buttonId;
  image.dataset.requestedState = state;
  image.dataset.state = exactStateAsset ? state : "up";
  image.dataset.fallbackState = exactStateAsset ? "false" : "true";
  image.setAttribute("href", `/${stateAsset.src}`);
  image.setAttributeNS("http://www.w3.org/1999/xlink", "href", `/${stateAsset.src}`);
  image.setAttribute("x", String(-stateAsset.origin.x));
  image.setAttribute("y", String(-stateAsset.origin.y));
  image.setAttribute("width", String(stateAsset.origin.width));
  image.setAttribute("height", String(stateAsset.origin.height));
  image.setAttribute("transform", matrixToSvg(matrix));
  overlayLayer.prepend(image);
  buttonStateElement = image;
}

function clearButtonVisualState() {
  buttonStateElement?.remove();
  buttonStateElement = null;
}

function handleButtonHover(characterId: string, eventName: "rollOver" | "rollOut", frameIndex: number) {
  const assetTimeline = activeAssetTimeline;
  const actionGroup = assetTimeline?.control?.buttonActions?.[characterId];
  const action = actionGroup?.[eventName];
  if (!assetTimeline || !actionGroup || !action) return;

  if (action.functionCalls?.length) {
    runFunctionCalls(assetTimeline, action.functionCalls, frameIndex);
  }

  const frame = assetTimeline.frames[frameIndex];
  const ownerInstance = frame?.instances.find((instance) => actionGroup.ownerSpriteIds?.includes(instance.characterId));
  if (!ownerInstance) return;

  const asset = assetTimeline.assets[String(ownerInstance.characterId)];
  if (!asset || asset.kind !== "sprite" || !asset.frames?.length) return;

  const spriteAsset = asset as TimelineAsset & { frames: string[] };
  const startFrame = resolveSpriteFrame(action, spriteAsset);
  if (startFrame < 0) return;
  playHoverSprite(assetTimeline, ownerInstance, spriteAsset, startFrame, action.command === "gotoAndPlay", eventName);
}

function playHoverSprite(
  assetTimeline: AssetTimeline,
  instance: TimelineFrame["instances"][number],
  asset: TimelineAsset & { frames: string[] },
  startFrame: number,
  play: boolean,
  eventName: "rollOver" | "rollOut",
) {
  stopHoverSprite();
  hideStaticHoverSource(instance.characterId);

  const element = document.createElement("div");
  element.className = "awaiting-loop-instance hover-loop-instance";
  element.style.zIndex = String(instance.depth + 1000);
  const { a, b, c, d, tx, ty } = instance.matrix;
  element.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`;

  const image = document.createElement("img");
  image.className = "awaiting-loop-content";
  image.decoding = "async";
  image.draggable = false;
  image.style.left = `${-asset.origin.x}px`;
  image.style.top = `${-asset.origin.y}px`;
  image.style.width = `${asset.origin.width}px`;
  image.style.height = `${asset.origin.height}px`;
  element.append(image);
  awaitingLoopLayer.append(element);
  hoverSpriteElement = element;

  let spriteFrame = startFrame;
  const render = () => {
    image.src = `/${asset.frames[spriteFrame]}`;
    triggerSpriteFrameSounds(assetTimeline, instance.characterId, spriteFrame, `hover:${eventName}`);

    const selfGoto = spriteActionsAt(assetTimeline, instance.characterId, spriteFrame).find((action) => {
      return action.target === "self" && (action.command === "gotoAndStop" || action.command === "gotoAndPlay");
    });
    if (selfGoto) {
      const targetFrame = resolveSpriteFrame(selfGoto, asset, spriteFrame, assetTimeline, instance.characterId);
      if (targetFrame >= 0) image.src = `/${asset.frames[targetFrame]}`;
      if (eventName === "rollOut") stopHoverSprite();
      return false;
    }

    if (!play || hasReachedSpriteStopSince(assetTimeline, instance.characterId, spriteFrame, startFrame)) return false;
    spriteFrame = Math.min(spriteFrame + 1, asset.frames.length - 1);
    return spriteFrame < asset.frames.length - 1;
  };

  if (!render()) return;
  hoverSpriteTimer = window.setInterval(() => {
    if (!render()) stopHoverSprite(false);
  }, 1000 / Math.max(1, assetTimeline.fps));
}

function resolveSpriteFrame(
  action: ControlAction,
  asset: TimelineAsset & { frames: string[] },
  currentFrame = 0,
  assetTimeline?: AssetTimeline,
  spriteId?: number,
) {
  if (typeof action.frame === "number") return Math.max(0, Math.min(asset.frames.length - 1, action.frame));
  if (action.label && assetTimeline && spriteId !== undefined) {
    const frame = assetTimeline.control?.nestedMovieClips?.find((movieClip) => movieClip.spriteId === spriteId)?.labels?.[action.label];
    if (frame !== undefined) return Math.max(0, Math.min(asset.frames.length - 1, frame));
  }

  const expression = action.frameExpression?.trim();
  if (!expression) return -1;
  const numericFrame = Number.parseInt(expression, 10);
  if (Number.isFinite(numericFrame) && numericFrame > 0) return Math.max(0, Math.min(asset.frames.length - 1, numericFrame - 1));

  const currentFrameExpression = expression.match(/^_currentframe\s*([+-])\s*(\d+)$/);
  if (currentFrameExpression) {
    const delta = Number(currentFrameExpression[2]);
    const targetFrame = currentFrame + (currentFrameExpression[1] === "+" ? delta : -delta);
    return Math.max(0, Math.min(asset.frames.length - 1, targetFrame));
  }

  return -1;
}

function stopHoverSprite(removeElement = true) {
  if (hoverSpriteTimer) {
    window.clearInterval(hoverSpriteTimer);
    hoverSpriteTimer = 0;
  }
  if (removeElement) {
    restoreStaticHoverSources();
    hoverSpriteElement?.remove();
    hoverSpriteElement = null;
  }
}

function hideStaticHoverSource(characterId: number) {
  for (const node of frameStageInline.querySelectorAll<SVGGraphicsElement>(`[ffdec\\:characterId="${characterId}"]`)) {
    if (node.closest(".flash-button-overlay-layer")) continue;
    if (node.style.visibility === "hidden") continue;
    node.style.visibility = "hidden";
    hiddenHoverSources.push(node);
  }
}

function restoreStaticHoverSources() {
  for (const node of hiddenHoverSources.splice(0)) {
    node.style.visibility = "";
  }
}

function hideStaticAwaitingSource(characterId: number) {
  const target = String(characterId);
  const nodes = frameStageInline.querySelectorAll<SVGGraphicsElement>("use, g");
  for (const node of nodes) {
    const value = node.getAttribute("ffdec:characterId") ?? node.getAttribute("ffdec:characterid");
    if (value !== target) continue;
    if (node.closest(".flash-button-overlay-layer")) continue;
    if (node.style.visibility === "hidden") continue;
    node.style.visibility = "hidden";
    hiddenAwaitingSources.push(node);
  }
}

function restoreStaticAwaitingSources() {
  for (const node of hiddenAwaitingSources.splice(0)) {
    node.style.visibility = "";
  }
}

function walkVisibleSvgTree(element: Element, matrix: DOMMatrix, visit: (element: Element, matrix: DOMMatrix) => void, seen = new Set<string>()) {
  const nextMatrix = matrix.multiply(parseSvgMatrix(element.getAttribute("transform")));
  visit(element, nextMatrix);

  const href = svgHref(element);
  if (href?.startsWith("#")) {
    const id = href.slice(1);
    if (seen.has(id)) return;
    const referenced = element.ownerDocument.getElementById(id);
    if (referenced) {
      const nextSeen = new Set(seen);
      nextSeen.add(id);
      for (const child of [...referenced.children]) {
        walkVisibleSvgTree(child, nextMatrix, visit, nextSeen);
      }
    }
  }

  if (element.tagName.toLowerCase() !== "use") {
    for (const child of [...element.children]) {
      if (child.tagName.toLowerCase() === "defs") continue;
      walkVisibleSvgTree(child, nextMatrix, visit, seen);
    }
  }
}

function parseSvgMatrix(transform: string | null) {
  if (!transform) return new DOMMatrix();
  const match = transform.match(/matrix\(([^)]+)\)/);
  if (!match) return new DOMMatrix();
  const parts = match[1].split(/[\s,]+/).filter(Boolean).map((part) => Number.parseFloat(part));
  if (parts.length !== 6 || parts.some((part) => !Number.isFinite(part))) return new DOMMatrix();
  return new DOMMatrix(parts);
}

function svgHref(element: Element) {
  return (
    element.getAttribute("href") ??
    element.getAttribute("xlink:href") ??
    element.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
    ""
  );
}

function ffdecCharacterId(element: Element) {
  const namespaced = element.getAttribute("ffdec:characterId") ?? element.getAttributeNS("https://www.free-decompiler.com/flash", "characterId");
  if (namespaced) return namespaced;

  for (const attribute of [...element.attributes]) {
    if (attribute.name.toLowerCase().endsWith("characterid")) return attribute.value;
  }

  return "";
}

function matrixToSvg(matrix: DOMMatrix) {
  return `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f})`;
}

function timelineMatrixToSvg(matrix: Matrix) {
  return `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.tx}, ${matrix.ty})`;
}

function timelineMatrixToDomMatrix(matrix: Matrix) {
  return new DOMMatrix([matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty]);
}

function setFrameStatus(assetTimeline: AssetTimeline, frameIndex: number, wiredTargets: number) {
  const frame = assetTimeline.frames[frameIndex];
  const label = frame?.label || `frame ${frameIndex + 1}`;
  const stopped = shouldStopAtFrame(assetTimeline, frameIndex);
  const choiceLoop = isChoiceLoopFrame(assetTimeline, frameIndex);
  const nestedSectionActive = stopped && hasActiveNestedSection(assetTimeline, frameIndex);
  const interactiveHold = wiredTargets > 0 && !isGsapPlaying && frameIndex !== assetTimeline.entryFrame;
  isNestedSectionActive = nestedSectionActive;
  isAwaitingSelection = !nestedSectionActive && (stopped || choiceLoop || interactiveHold) && wiredTargets > 0;
  status.dataset.mode = isAwaitingSelection ? "waiting" : nestedSectionActive || !stopped ? "playing" : "stopped";

  if (nestedSectionActive) {
    status.textContent = `Playing nested section at ${label}`;
    startAwaitingLoop(assetTimeline, frameIndex, true);
  } else if (isAwaitingSelection && choiceLoop && !stopped) {
    status.textContent = `Awaiting user selection loop at ${label}`;
    stopAwaitingLoop();
  } else if (isAwaitingSelection) {
    status.textContent = `Awaiting user selection at ${label}`;
    startAwaitingLoop(assetTimeline, frameIndex);
  } else if (stopped) {
    status.textContent = `Stopped at ${label}`;
    stopAwaitingLoop();
  } else if (isGsapPlaying) {
    status.textContent = `Playing ${assetTimeline.scene}`;
    stopAwaitingLoop();
  } else {
    status.textContent = `Ready at ${label}`;
    stopAwaitingLoop();
  }

  updatePlayButton();
}

function updatePlayButton() {
  if (isDirectRenderMode()) {
    playBtn.disabled = false;
    playBtn.textContent = isGsapPlaying ? "Pause Direct" : "Play Direct";
    return;
  }

  playBtn.disabled = isAwaitingSelection || isNestedSectionActive;
  playBtn.textContent = isNestedSectionActive ? "Section Playing" : isAwaitingSelection ? "Awaiting Choice" : isGsapPlaying ? "Pause GSAP" : "Play GSAP";
}

function updateStaticReference(assetTimeline: AssetTimeline, frameIndex: number) {
  const src = assetTimeline.frameSvgs?.[frameIndex];
  if (src) referenceFrameImage.src = `/${src}`;
  referenceName.textContent = `${assetTimeline.scene}`;
  const label = frameLabel(assetTimeline, frameIndex);
  referenceFrameMeta.textContent = `Frame ${frameIndex}${label ? ` - ${label}` : ""}`;
}

function updateDebugPanel(
  assetTimeline = activeAssetTimeline,
  frameIndex = Number(frameScrubber.value),
  gsapEntries?: GsapDisplayDebugEntry[],
) {
  if (!assetTimeline) {
    debugSummary.textContent = "";
    debugList.replaceChildren();
    return;
  }

  const frame = assetTimeline.frames[frameIndex];
  const entries = gsapEntries ?? debugEntriesForFrame(assetTimeline, frameIndex);
  debugSummary.textContent = `${entries.length} items`;

  if (activeDebugTab === "labels") {
    renderLabelDebug(assetTimeline, frameIndex);
  } else if (activeDebugTab === "actions") {
    renderActionDebug(assetTimeline, frameIndex);
  } else {
    renderStageDebug(assetTimeline, entries);
  }

  referenceFrameMeta.textContent = `Frame ${frameIndex}${frame?.label ? ` - ${frame.label}` : ""}`;
  applyDepthHighlight();
}

function debugEntriesForFrame(assetTimeline: AssetTimeline, frameIndex: number): GsapDisplayDebugEntry[] {
  const frame = assetTimeline.frames[frameIndex];
  if (!frame) return [];

  const masks = frame.instances.filter((instance) => instance.clipDepth !== undefined);
  return frame.instances.map((instance) => {
    const asset = assetTimeline.assets[String(instance.characterId)];
    const spriteFrame = asset?.kind === "sprite" && asset.frames?.length
      ? Math.max(0, frame.index - instance.placedFrame) % asset.frames.length
      : undefined;
    const clippingMask = masks.find((mask) => instance.depth > mask.depth && instance.depth <= mask.clipDepth!);
    return {
      depth: instance.depth,
      characterId: instance.characterId,
      kind: asset?.kind ?? "shape",
      name: instance.name,
      placedFrame: instance.placedFrame,
      spriteFrame,
      clipDepth: instance.clipDepth,
      isMask: Boolean(instance.clipDepth),
      clippedBy: clippingMask?.depth,
      opacity: instance.opacity,
      src: asset?.src ?? asset?.frames?.[spriteFrame ?? 0] ?? "",
    };
  });
}

function renderStageDebug(assetTimeline: AssetTimeline | null, entries: GsapDisplayDebugEntry[]) {
  debugList.replaceChildren();
  if (!entries.length) {
    debugList.append(emptyDebugMessage("No display-list entries on this frame."));
    return;
  }

  for (const entry of entries.sort((a, b) => a.depth - b.depth)) {
    const button = document.createElement("button");
    button.className = "debug-item";
    button.type = "button";
    button.classList.toggle("is-highlighted", highlightedDepth === entry.depth);
    button.classList.toggle("is-mask", entry.isMask);
    button.classList.toggle("is-clipped", entry.clippedBy !== undefined);
    button.innerHTML = `
      <span class="debug-depth">${entry.depth}</span>
      <span class="debug-main">
        <strong>${entry.kind} ${entry.characterId}</strong>
        <small>${[
          entry.name ? `name: ${escapeHtml(entry.name)}` : "",
          entry.spriteFrame !== undefined ? `sprite frame: ${entry.spriteFrame}` : "",
          entry.clippedBy !== undefined ? `clipped by depth ${entry.clippedBy}` : "",
          entry.clipDepth !== undefined ? `masks to ${entry.clipDepth}` : "",
        ].filter(Boolean).join(" | ") || "root display object"}</small>
      </span>
      <span class="debug-opacity">${Math.round(entry.opacity * 100)}%</span>
    `;
    button.addEventListener("click", () => {
      highlightedDepth = highlightedDepth === entry.depth ? null : entry.depth;
      applyDepthHighlight();
      renderStageDebug(assetTimeline, entries);
    });
    debugList.append(button);
  }
}

function renderLabelDebug(assetTimeline: AssetTimeline, frameIndex: number) {
  debugList.replaceChildren();
  const labels = Object.entries(assetTimeline.labels ?? {}).sort((a, b) => a[1] - b[1]);
  if (!labels.length) {
    debugList.append(emptyDebugMessage("No labels were extracted for this scene."));
    return;
  }

  for (const [label, frame] of labels) {
    const button = document.createElement("button");
    button.className = "debug-item debug-label-item";
    button.type = "button";
    button.classList.toggle("is-highlighted", frame === frameIndex);
    button.innerHTML = `
      <span class="debug-depth">${frame}</span>
      <span class="debug-main"><strong>${escapeHtml(label)}</strong><small>${frame === frameIndex ? "current frame" : "click to seek"}</small></span>
    `;
    button.addEventListener("click", () => goToFrame(frame, false));
    debugList.append(button);
  }
}

function renderActionDebug(assetTimeline: AssetTimeline, frameIndex: number) {
  debugList.replaceChildren();
  const rootActions = frameActionsAt(assetTimeline, frameIndex);
  const exactFrameRootActions = assetTimeline.control?.frameActions
    ?.filter((entry) => entry.frame === frameIndex)
    .flatMap((entry) => entry.actions) ?? [];
  const functionScopedActions = exactFrameRootActions.filter((action) => action.executionContext === "function" || action.functionName);
  const branchScopedActions = exactFrameRootActions.filter((action) => action.executionContext === "branch" || action.branchCondition || action.functionBranchCondition);
  const spriteActionCount = assetTimeline.control?.spriteActions
    ?.filter((entry) => entry.frame === frameIndex)
    .flatMap((entry) => entry.actions).length ?? 0;

  const rows = [
    ...rootActions.map((action) => ({
      title: action.command ?? action.functionName ?? "action",
      detail: action.source,
      supported: action.supported,
    })),
    ...(isDirectRenderMode() && functionScopedActions.length
      ? [{ title: "function-scope actions", detail: `${functionScopedActions.length} extracted function action(s) reference this frame`, supported: true }]
      : []),
    ...(isDirectRenderMode() && branchScopedActions.length
      ? [{ title: "branch-scope actions", detail: `${branchScopedActions.length} extracted branch action(s) reference this frame`, supported: true }]
      : []),
    ...(spriteActionCount ? [{ title: "sprite actions", detail: `${spriteActionCount} sprite-frame actions share this local frame number`, supported: true }] : []),
  ];

  if (!rows.length) {
    debugList.append(emptyDebugMessage("No root frame actions at this frame."));
    return;
  }

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "debug-item debug-action-item";
    item.innerHTML = `
      <span class="debug-depth">${row.supported === false ? "!" : "ok"}</span>
      <span class="debug-main"><strong>${escapeHtml(String(row.title))}</strong><small>${escapeHtml(row.detail ?? "")}</small></span>
    `;
    debugList.append(item);
  }
}

function emptyDebugMessage(message: string) {
  const element = document.createElement("div");
  element.className = "debug-empty";
  element.textContent = message;
  return element;
}

function applyDepthHighlight() {
  assetStage.querySelectorAll(".depth-highlight").forEach((node) => node.classList.remove("depth-highlight"));
  if (highlightedDepth === null) return;
  assetStage.querySelectorAll<HTMLElement>(`[data-depth="${highlightedDepth}"]`).forEach((node) => {
    node.classList.add("depth-highlight");
  });
}

function frameLabel(assetTimeline: AssetTimeline, frameIndex: number) {
  return assetTimeline.frames[frameIndex]?.label
    || Object.entries(assetTimeline.labels ?? {}).find(([, frame]) => frame === frameIndex)?.[0]
    || "";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]!));
}

function startAwaitingLoop(assetTimeline: AssetTimeline, frameIndex: number, sectionOnly = false) {
  if (renderModeSelect.value !== "frame") return;

  const frame = assetTimeline.frames[frameIndex];
  const candidates = frame.instances
    .map((instance) => {
      const asset = assetTimeline.assets[String(instance.characterId)];
      return asset?.kind === "sprite" && asset.frames && asset.frames.length > 1
        ? { instance, asset, relativeFrame: Math.max(0, frame.index - instance.placedFrame) }
        : null;
    })
    .filter((item): item is { instance: TimelineFrame["instances"][number]; asset: TimelineAsset & { frames: string[] }; relativeFrame: number } => {
      if (!item) return false;
      if (sectionOnly && !isNestedSectionInstance(item.instance, item.asset)) return false;
      if (item.asset.origin.width <= 1 || item.asset.origin.height <= 1) return false;
      return !hasReachedSpriteStop(assetTimeline, item.instance.characterId, item.relativeFrame);
    });

  if (!candidates.length) {
    stopAwaitingLoop();
    return;
  }

  if (awaitingLoopTimer) window.clearInterval(awaitingLoopTimer);
  awaitingLoopTick = 0;
  playedSpriteSoundKeys.clear();
  restoreStaticAwaitingSources();
  awaitingLoopLayer.replaceChildren();
  for (const { instance } of candidates) hideStaticAwaitingSource(instance.characterId);

  const rendered = candidates.map(({ instance, asset, relativeFrame }) => {
    const element = document.createElement("div");
    element.className = "awaiting-loop-instance";
    element.style.zIndex = String(instance.depth);
    const { a, b, c, d, tx, ty } = instance.matrix;
    element.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`;

    const image = document.createElement("img");
    image.className = "awaiting-loop-content";
    image.decoding = "async";
    image.draggable = false;
    image.style.left = `${-asset.origin.x}px`;
    image.style.top = `${-asset.origin.y}px`;
    image.style.width = `${asset.origin.width}px`;
    image.style.height = `${asset.origin.height}px`;
    element.append(image);
    awaitingLoopLayer.append(element);
    return { element, image, asset, instance, spriteFrame: relativeFrame, stopped: false };
  });
  const renderedByName = new Map(rendered.flatMap((item) => instanceTargetKeys(item.instance.name).map((key) => [key, item])));

  for (const action of frameActionsAt(assetTimeline, frameIndex)) {
    runTargetedSpriteAction(assetTimeline, action, renderedByName);
  }

  const renderLoopFrame = () => {
    for (const item of rendered) {
      const frameOffset = Math.max(0, Math.min(item.asset.frames.length - 1, item.spriteFrame));
      item.image.src = `/${item.asset.frames[frameOffset]}`;
      triggerSpriteFrameSounds(assetTimeline, item.instance.characterId, frameOffset, sectionOnly ? `section:${frameIndex}` : `loop:${frameIndex}`);

      if (sectionOnly && runNestedSectionAction(assetTimeline, frameIndex, item.instance.characterId, frameOffset)) {
        return;
      }

      const selfHandled = runSpriteSelfAction(assetTimeline, item.asset, item.instance.characterId, frameOffset, (nextFrame, stopped) => {
        item.spriteFrame = nextFrame;
        item.stopped = stopped;
        item.image.src = `/${item.asset.frames[nextFrame]}`;
      });
      if (selfHandled || item.stopped) continue;

      for (const action of spriteActionsAt(assetTimeline, item.instance.characterId, frameOffset)) {
        runTargetedSpriteAction(assetTimeline, action, renderedByName, item);
        runNestedFunctionCallAction(assetTimeline, action, item);
      }

      item.spriteFrame = sectionOnly
        ? Math.min(frameOffset + 1, item.asset.frames.length - 1)
        : (frameOffset + 1) % item.asset.frames.length;
    }
    awaitingLoopTick += 1;
  };

  renderLoopFrame();
  awaitingLoopTimer = window.setInterval(renderLoopFrame, 1000 / Math.max(1, assetTimeline.fps));
}

function runNestedSectionAction(assetTimeline: AssetTimeline, rootFrameIndex: number, spriteId: number, spriteFrame: number) {
  const actions = spriteActionsAt(assetTimeline, spriteId, spriteFrame);
  const rootAction = actions.find((action) => {
    if (action.target !== "_root" && action.target !== "_parent") return false;
    return action.command === "gotoAndPlay" || action.command === "gotoAndStop";
  });

  if (rootAction) {
    pauseAwaitingLoop();
    const targetFrame = resolveRuntimeFrame(rootAction, assetTimeline, rootFrameIndex);
    if (targetFrame >= 0) {
      goToFrame(targetFrame, rootAction.command === "gotoAndPlay");
      return true;
    }
  }

  const swfAction = actions.find((action) => (action.command === "doRelease" || action.command === "loadMovieNum") && action.swf);
  if (swfAction?.swf) {
    pauseAwaitingLoop();
    void navigateToSceneBySwf(swfAction.swf);
    return true;
  }

  if (actions.some((action) => action.command === "stop")) {
    pauseAwaitingLoop();
    isNestedSectionActive = false;
    isAwaitingSelection = true;
    const label = assetTimeline.frames[rootFrameIndex]?.label || `frame ${rootFrameIndex + 1}`;
    status.dataset.mode = "waiting";
    status.textContent = `Awaiting user selection at ${label}`;
    updatePlayButton();
    return true;
  }

  return false;
}

function runSpriteSelfAction(
  assetTimeline: AssetTimeline,
  asset: TimelineAsset & { frames: string[] },
  spriteId: number,
  spriteFrame: number,
  setState: (frame: number, stopped: boolean) => void,
) {
  const selfAction = spriteActionsAt(assetTimeline, spriteId, spriteFrame).find((action) => {
    if (action.target !== "self") return false;
    return action.command === "gotoAndPlay" || action.command === "gotoAndStop";
  });
  if (!selfAction) return false;

  const targetFrame = resolveSpriteFrame(selfAction, asset, spriteFrame, assetTimeline, spriteId);
  if (targetFrame < 0) return false;
  setState(targetFrame, selfAction.command === "gotoAndStop");
  return true;
}

function runTargetedSpriteAction(
  assetTimeline: AssetTimeline,
  action: ControlAction,
  renderedByName: Map<string, RenderedLoopItem>,
  sourceItem?: RenderedLoopItem,
) {
  if (action.command !== "gotoAndPlay" && action.command !== "gotoAndStop") return false;
  if (!action.target || action.target === "self" || action.target === "_root" || action.target === "_parent") return false;

  const target = actionTargetKeys(action.target).map((key) => renderedByName.get(key)).find(Boolean);
  if (!target) return sourceItem ? renderNestedTargetOverlay(assetTimeline, action, sourceItem) : false;

  const targetFrame = resolveSpriteFrame(action, target.asset, target.spriteFrame, assetTimeline, target.instance.characterId);
  if (targetFrame < 0) return false;

  target.spriteFrame = targetFrame;
  target.stopped = action.command === "gotoAndStop";
  target.image.src = `/${target.asset.frames[targetFrame]}`;
  return true;
}

function renderNestedTargetOverlay(assetTimeline: AssetTimeline, action: ControlAction, sourceItem: RenderedLoopItem) {
  const placement = action.targetPlacement;
  if (!placement?.characterId) return false;

  const asset = assetTimeline.assets[String(placement.characterId)];
  if (asset?.kind !== "sprite" || !asset.frames?.length) return false;
  const spriteAsset = asset as TimelineAsset & { frames: string[] };

  const targetFrame = resolveSpriteFrame(action, spriteAsset, 0, assetTimeline, placement.characterId);
  if (targetFrame < 0) return false;

  const key = nestedTargetOverlayKey(action, placement.characterId);
  sourceItem.element.querySelectorAll<HTMLElement>(`.nested-target-overlay[data-nested-target="${key}"]`).forEach((node) => node.remove());

  const wrapper = document.createElement("div");
  wrapper.className = "nested-target-overlay";
  wrapper.dataset.nestedTarget = key;
  const { a, b, c, d, tx, ty } = placement.matrix;
  wrapper.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`;

  const image = document.createElement("img");
  image.className = "awaiting-loop-content";
  image.decoding = "async";
  image.draggable = false;
  image.style.left = `${-spriteAsset.origin.x}px`;
  image.style.top = `${-spriteAsset.origin.y}px`;
  image.style.width = `${spriteAsset.origin.width}px`;
  image.style.height = `${spriteAsset.origin.height}px`;
  image.src = `/${spriteAsset.frames[targetFrame]}`;
  wrapper.append(image);
  sourceItem.element.append(wrapper);
  return true;
}

function runNestedFunctionCallAction(assetTimeline: AssetTimeline, action: ControlAction, sourceItem: RenderedLoopItem) {
  if (action.command !== "callFunctions" || !action.functionCalls?.length || !action.targetPlacement?.characterId) return false;

  const placement = action.targetPlacement;
  const asset = assetTimeline.assets[String(placement.characterId)];
  if (asset?.kind !== "sprite" || !asset.frames?.length) return false;
  const spriteAsset = asset as TimelineAsset & { frames: string[] };

  let handled = false;
  for (const call of action.functionCalls) {
    const goto = functionActionsFor(assetTimeline, placement.characterId, call.functionName)
      .filter((candidate) => evaluateFunctionActionCondition(candidate, runtimeValues(assetTimeline)))
      .find((candidate) => candidate.target === "self" && (candidate.command === "gotoAndPlay" || candidate.command === "gotoAndStop"));
    if (!goto) continue;

    const targetFrame = resolveSpriteFrame(goto, spriteAsset, 0, assetTimeline, placement.characterId);
    if (targetFrame < 0) continue;

    renderNestedTargetOverlay(assetTimeline, {
      ...goto,
      target: call.target,
      targetPlacement: placement,
    }, sourceItem);
    handled = true;
  }
  return handled;
}

function nestedTargetOverlayKey(action: ControlAction, characterId: number) {
  return `${characterId}:${normalizeTargetName(action.target ?? "")}:${action.command ?? ""}`;
}

function applyFrameActionTargetOverlays(assetTimeline: AssetTimeline, frameIndex: number) {
  const actions = assetTimeline.frames
    .slice(0, frameIndex + 1)
    .flatMap((frame) => expandedFrameTargetActionsAt(assetTimeline, frame.index))
    .filter((action) => {
    return Boolean(action.target) && action.target !== "self" && action.target !== "_root" && action.target !== "_parent";
  });
  if (!actions.length) return;

  const targetKeys = new Set(actions.flatMap((action) => actionTargetKeys(action.target ?? "")));
  const frame = assetTimeline.frames[frameIndex];
  const candidates = frame.instances
    .map((instance) => {
      if (!instanceTargetKeys(instance.name).some((key) => targetKeys.has(key))) return null;
      const asset = assetTimeline.assets[String(instance.characterId)];
      return asset?.kind === "sprite" && asset.frames?.length
        ? { instance, asset, relativeFrame: Math.max(0, frame.index - instance.placedFrame) }
        : null;
    })
    .filter((item): item is { instance: TimelineFrame["instances"][number]; asset: TimelineAsset & { frames: string[] }; relativeFrame: number } => Boolean(item));
  if (!candidates.length) return;

  restoreStaticAwaitingSources();
  awaitingLoopLayer.replaceChildren();
  const renderedByName = new Map<string, RenderedLoopItem>();

  for (const { instance, asset, relativeFrame } of candidates) {
    hideStaticAwaitingSource(instance.characterId);
    const element = document.createElement("div");
    element.className = "awaiting-loop-instance";
    element.style.zIndex = String(instance.depth);
    const { a, b, c, d, tx, ty } = instance.matrix;
    element.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`;

    const image = document.createElement("img");
    image.className = "awaiting-loop-content";
    image.decoding = "async";
    image.draggable = false;
    image.style.left = `${-asset.origin.x}px`;
    image.style.top = `${-asset.origin.y}px`;
    image.style.width = `${asset.origin.width}px`;
    image.style.height = `${asset.origin.height}px`;
    image.src = `/${asset.frames[Math.max(0, Math.min(asset.frames.length - 1, relativeFrame))]}`;
    element.append(image);
    awaitingLoopLayer.append(element);

    const item = { element, image, asset, instance, spriteFrame: relativeFrame, stopped: false };
    for (const key of instanceTargetKeys(instance.name)) renderedByName.set(key, item);
  }

  const latestActionByTarget = new Map<string, ControlAction>();
  for (const action of actions) {
    for (const key of actionTargetKeys(action.target ?? "")) latestActionByTarget.set(key, action);
  }

  for (const action of latestActionByTarget.values()) {
    runTargetedSpriteAction(assetTimeline, action, renderedByName);
  }
}

function expandedFrameTargetActionsAt(assetTimeline: AssetTimeline, frameIndex: number) {
  const actions = frameActionsAt(assetTimeline, frameIndex);
  const functionActions = actions
    .filter((action) => action.command === "callFunctions" && action.functionCalls?.length)
    .flatMap((action) => rootFunctionActionsFor(assetTimeline, action.functionCalls ?? []))
    .filter((action) => evaluateFunctionActionCondition(action, runtimeValues(assetTimeline)));
  return [...actions, ...functionActions];
}

function instanceTargetKeys(name: string) {
  const normalized = normalizeTargetName(name);
  return normalized ? [normalized] : [];
}

function actionTargetKeys(name: string) {
  const normalized = normalizeTargetName(name);
  const lastSegment = normalizeTargetName(name.split(".").pop() ?? "");
  return [...new Set([normalized, lastSegment].filter(Boolean))];
}

function normalizeTargetName(name: string) {
  return name.replace(/^_root\./, "").replace(/^_parent\./, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function pauseAwaitingLoop() {
  if (awaitingLoopTimer) {
    window.clearInterval(awaitingLoopTimer);
    awaitingLoopTimer = 0;
  }
}

function stopAwaitingLoop() {
  pauseAwaitingLoop();
  stopHoverSprite();
  restoreStaticAwaitingSources();
  awaitingLoopLayer.replaceChildren();
}

function hasReachedSpriteStop(assetTimeline: AssetTimeline, characterId: number, relativeFrame: number) {
  const stops = assetTimeline.control?.spriteStopFrames?.[String(characterId)] ?? [];
  return stops.some((stopFrame) => stopFrame <= relativeFrame);
}

function hasReachedSpriteStopSince(assetTimeline: AssetTimeline, characterId: number, relativeFrame: number, startFrame: number) {
  const stops = assetTimeline.control?.spriteStopFrames?.[String(characterId)] ?? [];
  return stops.some((stopFrame) => stopFrame >= startFrame && stopFrame <= relativeFrame);
}

function hasActiveNestedSection(assetTimeline: AssetTimeline, frameIndex: number) {
  const frame = assetTimeline.frames[frameIndex];
  return frame.instances.some((instance) => {
    const asset = assetTimeline.assets[String(instance.characterId)];
    if (!asset || asset.kind !== "sprite" || !asset.frames?.length) return false;
    const relativeFrame = Math.max(0, frame.index - instance.placedFrame);
    return isNestedSectionInstance(instance, asset) && !hasReachedSpriteStop(assetTimeline, instance.characterId, relativeFrame);
  });
}

function isNestedSectionInstance(instance: TimelineFrame["instances"][number], asset: TimelineAsset) {
  return /^mc_/i.test(instance.name) && asset.kind === "sprite" && (asset.frames?.length ?? 0) >= 30;
}

function frameActionsAt(assetTimeline: AssetTimeline, frame: number) {
  return selectRuntimeActions(allFrameActionsAt(assetTimeline, frame), runtimeValues(assetTimeline));
}

function allFrameActionsAt(assetTimeline: AssetTimeline, frame: number) {
  return assetTimeline.control?.frameActions
    ?.filter((entry) => entry.frame === frame)
    .flatMap((entry) => entry.actions) ?? [];
}

function spriteActionsAt(assetTimeline: AssetTimeline, spriteId: number, frame: number) {
  const actions = assetTimeline.control?.spriteActions
    ?.filter((entry) => entry.spriteId === spriteId && entry.frame === frame)
    .flatMap((entry) => entry.actions) ?? [];
  return selectRuntimeActions(actions, {
    ...runtimeValues(assetTimeline),
    ...(assetTimeline.control?.spriteLocalDefaults?.[String(spriteId)] ?? {}),
  });
}

function runtimeValues(assetTimeline: AssetTimeline) {
  return {
    ...(assetTimeline.control?.globalDefaults ?? {}),
    ...runtimeGlobals,
  };
}

function isTimelineAction(action: ControlAction) {
  return action.executionContext === undefined || action.executionContext === "timeline";
}

function selectRuntimeActions(actions: ControlAction[], globals: Record<string, RuntimeGlobalValue> = {}) {
  const timelineActions = actions.filter(isTimelineAction);
  const branchActions = actions.filter((action) => action.executionContext === "branch" && action.branchCondition);
  if (!branchActions.length) return timelineActions;

  const evaluatedBranches = branchActions
    .filter((action) => action.branchCondition !== "else")
    .map((action) => ({ action, value: evaluateBranchCondition(action.branchCondition ?? "", globals) }))
    .filter((entry): entry is { action: ControlAction; value: boolean } => entry.value !== undefined);
  const matchedBranches = evaluatedBranches.filter((entry) => entry.value).map((entry) => entry.action);
  const elseBranchActions = branchActions.filter((action) => action.branchCondition === "else");
  const selectedBranchActions = matchedBranches.length
    ? matchedBranches
    : evaluatedBranches.length
      ? elseBranchActions
      : branchActions.every((action) => action.branchCondition === "else")
        ? elseBranchActions
      : [];

  return [...timelineActions, ...selectedBranchActions];
}

function evaluateBranchCondition(condition: string, globals: Record<string, RuntimeGlobalValue>): boolean | undefined {
  const trimmed = condition.trim();
  if (!trimmed || trimmed === "else") return undefined;

  const andParts = splitCondition(trimmed, "&&");
  if (andParts.length > 1) {
    const values: Array<boolean | undefined> = andParts.map((part) => evaluateBranchCondition(part, globals));
    return values.some((value: boolean | undefined) => value === undefined) ? undefined : values.every(Boolean);
  }

  const orParts = splitCondition(trimmed, "||");
  if (orParts.length > 1) {
    const values: Array<boolean | undefined> = orParts.map((part) => evaluateBranchCondition(part, globals));
    return values.some((value: boolean | undefined) => value === undefined) ? undefined : values.some(Boolean);
  }

  const equality = trimmed.match(/^(.+?)\s*==\s*("[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false)$/);
  if (equality) {
    const value = runtimeValueFor(equality[1], globals);
    return value === undefined ? undefined : value === parseRuntimeLiteral(equality[2]);
  }

  const inequality = trimmed.match(/^(.+?)\s*!=\s*("[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false)$/);
  if (inequality) {
    const value = runtimeValueFor(inequality[1], globals);
    return value === undefined ? undefined : value !== parseRuntimeLiteral(inequality[2]);
  }

  const negated = trimmed.match(/^!(.+)$/);
  if (negated) {
    const value = runtimeValueFor(negated[1], globals);
    return !Boolean(value);
  }

  const value = runtimeValueFor(trimmed, globals);
  return Boolean(value);
}

function splitCondition(condition: string, operator: "&&" | "||"): string[] {
  return condition
    .split(operator)
    .map((part) => part.trim())
    .filter(Boolean);
}

function runtimeValueFor(expression: string, globals: Record<string, RuntimeGlobalValue>) {
  const normalized = normalizeGlobalName(expression);
  return globals[normalized];
}

function normalizeGlobalName(expression: string) {
  return expression.trim()
    .replace(/^_level0\./, "")
    .replace(/^_root\./, "");
}

function parseRuntimeLiteral(value: string): RuntimeGlobalValue {
  const trimmed = value.trim();
  const stringValue = trimmed.match(/^"([^"]*)"$/)?.[1] ?? trimmed.match(/^'([^']*)'$/)?.[1];
  if (stringValue !== undefined) return stringValue;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const numericValue = Number(trimmed);
  return Number.isFinite(numericValue) ? numericValue : trimmed;
}

function resolveSceneEntryFrame(assetTimeline: AssetTimeline, entryTarget?: SceneEntryTarget) {
  if (!entryTarget) return assetTimeline.entryFrame ?? 0;
  if (typeof entryTarget.frame === "number") return clampFrame(entryTarget.frame, assetTimeline);
  if (entryTarget.label && assetTimeline.labels?.[entryTarget.label] !== undefined) {
    return clampFrame(assetTimeline.labels[entryTarget.label], assetTimeline);
  }

  const expression = entryTarget.frameExpression?.trim();
  const numericFrame = Number.parseInt(expression ?? "", 10);
  if (Number.isFinite(numericFrame) && numericFrame > 0) return clampFrame(numericFrame - 1, assetTimeline);
  return assetTimeline.entryFrame ?? 0;
}

function rootTimelineActionAtFrame(assetTimeline: AssetTimeline, frame: number) {
  return frameActionsAt(assetTimeline, frame).find((action) => {
    if (action.command !== "gotoAndPlay" && action.command !== "gotoAndStop") return false;
    return action.target === "self" || action.target === "_root";
  });
}

function rootSwfNavigationAtFrame(assetTimeline: AssetTimeline, frame: number) {
  return primaryRootSwfNavigation(rootSwfLoadActionsAtFrame(assetTimeline, frame));
}

function rootSwfLoadActionsAtFrame(assetTimeline: AssetTimeline, frame: number) {
  return frameActionsAt(assetTimeline, frame).filter((action) => {
    return (action.command === "doRelease" || action.command === "loadMovieNum") && Boolean(action.swf);
  });
}

function primaryRootSwfNavigation(actions: ControlAction[]) {
  return actions.find((action) => actionLevel(action) === 4)
    ?? actions.find((action) => actionLevel(action) !== 6)
    ?? actions[0];
}

function rememberLoadedLevel(action: ControlAction, assetTimeline?: AssetTimeline, frame?: number) {
  const level = actionLevel(action);
  if (level === undefined || !action.swf) return;
  loadedLevelSwfs[level] = action.swf;
  if (level !== 4 && assetTimeline && frame !== undefined) queueExternalLevelCallsAtFrame(assetTimeline, frame, level);
  if (level !== 4) void ensureExternalLevel(level, action.swf);
}

function actionLevel(action: ControlAction) {
  const value = typeof action.level === "number" ? action.level : Number.parseInt(String(action.level ?? ""), 10);
  return Number.isFinite(value) ? value : undefined;
}

async function ensureExternalLevel(level: number, swf: string) {
  const existing = externalLevels.get(level);
  if (existing?.swf.toLowerCase() === swf.toLowerCase()) return existing;

  existing?.element.remove();
  const element = document.createElement("div");
  element.className = "external-level-overlay";
  element.dataset.level = String(level);
  element.dataset.swf = swf;
  element.style.zIndex = String(level);

  const image = document.createElement("img");
  image.className = "external-level-frame";
  image.decoding = "async";
  image.draggable = false;
  element.append(image);
  externalLevelLayer.append(element);

  const record = { swf, frame: 0, element, image } as {
    swf: string;
    frame: number;
    element: HTMLDivElement;
    image: HTMLImageElement;
    timeline?: AssetTimeline;
  };
  externalLevels.set(level, record);

  const loadedTimeline = await fetchAssetTimeline(swf);
  if (!loadedTimeline) {
    element.remove();
    externalLevels.delete(level);
    return null;
  }

  record.timeline = loadedTimeline;
  renderExternalLevelFrame(level, record.frame);
  flushPendingExternalLevelCalls(level);
  return record;
}

const externalLevelSvgCache = new Map<string, string>();

async function fetchExternalLevelSvg(src: string) {
  const cached = externalLevelSvgCache.get(src);
  if (cached !== undefined) return cached;
  try {
    const response = await fetch(`/${src}`);
    if (!response.ok) {
      externalLevelSvgCache.set(src, "");
      return "";
    }
    let svg = await response.text();
    svg = svg.replace(/<\?xml[^>]*>\s*/i, "");
    svg = stripFrameSvgBackgroundRect(svg);
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    externalLevelSvgCache.set(src, url);
    return url;
  } catch {
    externalLevelSvgCache.set(src, "");
    return "";
  }
}

function stripFrameSvgBackgroundRect(svg: string): string {
  return svg.replace(
    /(<g\s+transform="matrix\([^"]*\)"\s*>\s*)<rect\b[^>]*\bfill="#[0-9a-fA-F]{3,8}"[^>]*\/>/i,
    "$1",
  );
}

function renderExternalLevelFrame(level: number, frame: number) {
  const record = externalLevels.get(level);
  if (!record?.timeline?.frameSvgs?.length) return false;
  record.frame = clampFrame(frame, record.timeline);
  const src = record.timeline.frameSvgs[record.frame];
  record.element.dataset.frame = String(record.frame);
  void fetchExternalLevelSvg(src).then((url) => {
    if (!url) return;
    if (externalLevels.get(level) !== record) return;
    if (record.timeline?.frameSvgs?.[record.frame] !== src) return;
    record.image.src = url;
  });
  return true;
}

function clearExternalLevels() {
  externalLevels.clear();
  pendingExternalLevelCalls.clear();
  externalLevelLayer.replaceChildren();
  for (const level of Object.keys(loadedLevelSwfs)) {
    if (Number(level) !== 4) delete loadedLevelSwfs[Number(level)];
  }
}

function rootLevelGotoAtFrame(assetTimeline: AssetTimeline, frame: number) {
  const action = frameActionsAt(assetTimeline, frame).find((candidate) => {
    if (candidate.command !== "gotoAndPlay" && candidate.command !== "gotoAndStop") return false;
    return /^_level\d+$/i.test(candidate.target ?? "");
  });
  const level = Number.parseInt(action?.target?.match(/^_level(\d+)$/i)?.[1] ?? "", 10);
  return action && Number.isFinite(level) ? { level, action } : null;
}

function isChoiceLoopFrame(assetTimeline: AssetTimeline, frame: number) {
  const nextFrameAction = rootTimelineActionAtFrame(assetTimeline, frame + 1);
  if (nextFrameAction?.command !== "gotoAndPlay") return false;
  const target = resolveRuntimeFrame(nextFrameAction, assetTimeline, frame + 1);
  return target >= 0 && target <= frame;
}

function resolveRuntimeFrame(action: ControlAction, assetTimeline: AssetTimeline, currentFrame: number) {
  if (typeof action.frame === "number") return clampFrame(action.frame, assetTimeline);
  if (action.label && assetTimeline.labels?.[action.label] !== undefined) return clampFrame(assetTimeline.labels[action.label], assetTimeline);

  const expression = action.frameExpression?.trim();
  if (!expression) return -1;

  const numericFrame = Number.parseInt(expression, 10);
  if (Number.isFinite(numericFrame) && numericFrame > 0) return clampFrame(numericFrame - 1, assetTimeline);

  const currentFrameExpression = expression.match(/^_currentframe\s*([+-])\s*(\d+)$/);
  if (currentFrameExpression) {
    const delta = Number(currentFrameExpression[2]);
    return clampFrame(currentFrame + (currentFrameExpression[1] === "+" ? delta : -delta), assetTimeline);
  }

  return -1;
}

function clampFrame(frame: number, assetTimeline: AssetTimeline) {
  return Math.max(0, Math.min(assetTimeline.frameCount - 1, frame));
}

function syncAssetStageScale() {
  const rect = assetWrap.getBoundingClientRect();
  const scale = Math.min(rect.width / 640, rect.height / 480);
  assetStage.style.setProperty("--stage-scale", String(scale));
}

function ensureRenderedInstance(depth: number, characterId: number, asset: TimelineAsset, frameIndex: number) {
  const existing = renderedInstances.get(depth);
  if (existing?.characterId === characterId) return existing;

  existing?.element.remove();

  const element = document.createElement("div");
  element.className = "asset-instance";
  element.dataset.depth = String(depth);
  element.dataset.character = String(characterId);

  const content = createAssetElement(asset, frameIndex);
  content.classList.add("asset-content");
  content.style.left = `${-asset.origin.x}px`;
  content.style.top = `${-asset.origin.y}px`;
  if (asset.origin.width > 0) content.style.width = `${asset.origin.width}px`;
  if (asset.origin.height > 0) content.style.height = `${asset.origin.height}px`;

  element.append(content);
  assetStage.append(element);

  const rendered = { characterId, element, content };
  renderedInstances.set(depth, rendered);
  return rendered;
}

function createAssetElement(asset: TimelineAsset, frameIndex: number) {
  if (asset.kind === "text") {
    const text = document.createElement("div");
    text.className = "asset-text";
    if (asset.src) {
      void fetch(`/${asset.src}`)
        .then((response) => (response.ok ? response.text() : ""))
        .then((content) => {
          text.textContent = content.trim();
        });
    }
    return text;
  }

  const image = document.createElement("img");
  image.decoding = "async";
  image.draggable = false;
  image.src = asset.kind === "sprite" && asset.frames?.length ? `/${asset.frames[frameIndex % asset.frames.length]}` : `/${asset.src}`;
  return image;
}

async function waitForRuffle() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (window.RufflePlayer) return;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("Ruffle did not load");
}

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
