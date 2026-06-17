import { gsap } from "gsap";
import { GsapDisplayListRenderer, type GsapDisplayDebugEntry } from "./gsap-display-list-renderer";
import { GsapSwfRenderer } from "./engine/GsapSwfRenderer";
import { parseSwfFile } from "./engine/SwfParser";
import { scenes, type TourScene } from "./data/scenes";
import { PlayerController } from "./app/PlayerController";
import type { AssetTimeline as DecompiledTimeline } from "./data/timelineTypes";

declare global {
  interface Window {
    RufflePlayer?: {
      newest: () => {
        createPlayer: () => RuffleElement;
      };
    };
  }
}

import type {
  Matrix,
  TimelineAsset,
  TimelineFrame,
  ControlAction,
  RenderedLoopItem,
  ButtonControl,
  ButtonDefinition,
  ButtonStateRecord,
  DynamicTextControl,
  RuntimeGlobalValue,
  SceneEntryTarget,
  AssetTimeline,
  RenderedInstance,
} from "./app/frameModeTypes";
import {
  walkVisibleSvgTree,
  ffdecCharacterId,
  matrixToSvg,
  timelineMatrixToSvg,
  timelineMatrixToDomMatrix,
  escapeHtml,
} from "./app/svgUtils";
import { selectRuntimeActions, evaluateBranchCondition } from "./app/runtimeConditions";
import { fontFamiliesForAsset, extractedFontFamilyStack } from "./app/fonts";
import {
  select,
  ruffleMount,
  assetStage,
  assetWrap,
  frameStageImage,
  frameStageInline,
  gsapDisplayLayer,
  directSwfLayer,
  externalLevelLayer,
  awaitingLoopLayer,
  emptyMessage,
  status,
  restartBtn,
  playBtn,
  frameScrubber,
  renderModeSelect,
  ruffleName,
  assetName,
  referenceName,
  referenceFrameImage,
  referenceFrameMeta,
  debugSummary,
  debugList,
  playerLayer,
} from "./app/dom";
import {
  findFrameInstanceByTarget,
  functionActionsFor,
  rootFunctionActionsFor,
  externalRootFunctionActionsFor,
  buttonHitCharacterMap,
  instanceTargetKeys,
  actionTargetKeys,
  normalizeTargetName,
  hasReachedSpriteStop,
  hasReachedSpriteStopSince,
  hasActiveNestedSection,
  isNestedSectionInstance,
  allFrameActionsAt,
  resolveSpriteFrame,
  resolveSceneEntryFrame,
  resolveRuntimeFrame,
  clampFrame,
  primaryRootSwfNavigation,
  actionLevel,
  frameLabel,
} from "./app/timelineQueries";
import {
  state as appState, playedSpriteSoundKeys, runtimeGlobals, loadedLevelSwfs, hiddenHoverSources,
  hiddenAwaitingSources, frameSvgCache, assetTimelineCache, loadedFontFaceKeys, externalLevels,
  pendingExternalLevelCalls, gsapDisplayRenderer, playerController,
} from "./app/state";
import type { RuffleElement } from "./app/frameModeTypes";
import { playVoiceover, playBackgroundMusic, stopCurrentVoiceover, stopCurrentMusic } from "./app/audio";
import { loadRuffle, waitForRuffle } from "./app/ruffle";


renderModeSelect.selectedIndex = 0;
renderModeSelect.value = "player";

function isPlayerMode() {
  return renderModeSelect.value === "player";
}

function activatePlayerMode() {
  if (!appState.activeAssetTimeline) return;
  appState.timeline?.pause();
  appState.isGsapPlaying = false;
  appState.directSwfRenderer?.pause();
  directSwfLayer.hidden = true;
  // Hide every other render surface; the player owns its own layer.
  frameStageImage.hidden = true;
  frameStageInline.replaceChildren();
  assetStage.querySelectorAll(".asset-instance").forEach((node) => node.remove());
  appState.renderedInstances.clear();
  gsapDisplayRenderer.clear();
  gsapDisplayLayer.hidden = true;
  awaitingLoopLayer.replaceChildren();
  emptyMessage.hidden = true;
  playerController.activate(appState.activeAssetTimeline as unknown as DecompiledTimeline, appState.activeScene.swf);
  frameScrubber.max = String(playerController.frameCount - 1);
  frameScrubber.value = String(playerController.currentFrame);
  // Autoplay like Ruffle: the root holds on its menu stop() while nested clips
  // (icon attract animations) play and loop on their own playheads.
  playerController.play();
  updatePlayButton();
}
const stageResizeObserver = new ResizeObserver(syncAssetStageScale);

select.innerHTML = scenes.map((scene, index) => `<option value="${index}">${scene.label} - ${scene.swf}</option>`).join("");
select.value = String(scenes.indexOf(appState.activeScene));

select.addEventListener("change", () => {
  appState.activeScene = scenes[Number(select.value)] ?? scenes[0];
  void loadScene(appState.activeScene);
});

restartBtn.addEventListener("click", () => {
  if (isPlayerMode()) {
    playerController.restart();
  } else if (isDirectRenderMode()) {
    void restartDirectRenderer();
  } else {
    goToFrame(appState.activeAssetTimeline?.entryFrame ?? 0, false);
  }
  void loadRuffle(appState.activeScene).catch((error) => {
    console.warn(`Ruffle reference failed to reload ${appState.activeScene.swf}`, error);
  });
});

playBtn.addEventListener("click", () => {
  if (isPlayerMode()) {
    playerController.toggle();
    playBtn.textContent = playerController.isPlaying ? "Pause" : "Play GSAP";
    return;
  }

  if (isDirectRenderMode()) {
    void toggleDirectRendererPlayback();
    return;
  }

  if (!appState.timeline || appState.isAwaitingSelection) return;
  if (appState.isGsapPlaying) {
    appState.isGsapPlaying = false;
    updatePlayButton();
    appState.timeline.pause();
    return;
  }

  const currentFrame = Number(frameScrubber.value);
  const startFrame = appState.activeAssetTimeline && shouldStopAtFrame(appState.activeAssetTimeline, currentFrame)
    ? Math.min(currentFrame + 1, appState.activeAssetTimeline.frameCount - 1)
    : currentFrame;
  goToFrame(startFrame, true);
});

frameScrubber.addEventListener("input", () => {
  if (isPlayerMode()) {
    playerController.seekRootFrame(Number(frameScrubber.value));
    playBtn.textContent = "Play GSAP";
    return;
  }

  if (isDirectRenderMode()) {
    appState.isGsapPlaying = false;
    updatePlayButton();
    void renderDirectSwfFrame(Number(frameScrubber.value));
    return;
  }

  if (!appState.activeAssetTimeline || !appState.timeline) return;
  appState.isGsapPlaying = false;
  playBtn.textContent = "Play GSAP";
  const frame = Number(frameScrubber.value);
  goToFrame(frame, false);
});

renderModeSelect.addEventListener("change", () => {
  if (!appState.activeAssetTimeline) return;
  if (isPlayerMode()) {
    activatePlayerMode();
    return;
  }
  if (playerController.active) {
    playerController.deactivate();
    externalLevelLayer.hidden = false;
  }
  renderFrame(appState.activeAssetTimeline, Number(frameScrubber.value));
});

document.querySelectorAll<HTMLButtonElement>(".debug-tab").forEach((button) => {
  button.addEventListener("click", () => {
    appState.activeDebugTab = (button.dataset.debugTab as typeof appState.activeDebugTab | undefined) ?? "stage";
    document.querySelectorAll<HTMLButtonElement>(".debug-tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab === button);
    });
    if (isDirectRenderMode() && appState.directSwfRenderer) {
      updateDirectDebugPanel(appState.directSwfRenderer);
      return;
    }
    updateDebugPanel();
  });
});

void loadScene(appState.activeScene);
stageResizeObserver.observe(assetWrap);

async function loadScene(scene: TourScene, entryTarget?: SceneEntryTarget, preserveExternalLevels = false) {
  status.textContent = `Loading ${scene.swf}`;
  ruffleName.textContent = `${scene.length.toFixed(2)}s`;
  await loadAssetTimeline(scene, entryTarget, preserveExternalLevels);
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

  appState.activeScene = targetScene;
  if (/^segment\d+\.swf$/i.test(targetScene.swf)) loadedLevelSwfs[4] = targetScene.swf;
  select.value = String(scenes.indexOf(appState.activeScene));
  await loadScene(appState.activeScene, entryTarget, true);
}

function isDirectRenderMode() {
  return renderModeSelect.value === "direct";
}

function destroyDirectRenderer() {
  appState.directSwfRenderer?.destroy();
  appState.directSwfRenderer = null;
  appState.directSwfScene = "";
  appState.directSwfLoad = null;
}

async function ensureDirectRenderer(scene: TourScene) {
  if (appState.directSwfRenderer && appState.directSwfScene === scene.swf) return appState.directSwfRenderer;
  if (appState.directSwfLoad && appState.directSwfScene === scene.swf) return appState.directSwfLoad;

  destroyDirectRenderer();
  appState.directSwfScene = scene.swf;
  status.textContent = `Parsing ${scene.swf} directly`;

  appState.directSwfLoad = parseSwfFile(`/${scene.swf}`)
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
        appState.isGsapPlaying = playing;
        status.dataset.mode = playing ? "playing" : "stopped";
        status.textContent = `${playing ? "Playing" : "Ready at"} direct ${scene.swf} frame ${renderer.currentFrame + 1}`;
        updatePlayButton();
      };
      appState.directSwfRenderer = renderer;
      return renderer;
    })
    .catch((error) => {
      console.warn(`Direct SWF renderer failed to parse ${scene.swf}`, error);
      status.dataset.mode = "stopped";
      status.textContent = `Direct renderer failed for ${scene.swf}`;
      appState.directSwfRenderer = null;
      return null;
    })
    .finally(() => {
      appState.directSwfLoad = null;
    });

  return appState.directSwfLoad;
}

async function renderDirectSwfFrame(frameIndex: number) {
  const renderer = await ensureDirectRenderer(appState.activeScene);
  if (!renderer || !isDirectRenderMode() || appState.directSwfScene !== appState.activeScene.swf) return;

  frameScrubber.max = String(renderer.totalFrames - 1);
  const frame = Math.max(0, Math.min(renderer.totalFrames - 1, frameIndex));
  renderer.seekToFrame(frame);
  updateDirectDebugPanel(renderer, frame);
}

async function toggleDirectRendererPlayback() {
  const renderer = await ensureDirectRenderer(appState.activeScene);
  if (!renderer || !isDirectRenderMode()) return;

  if (renderer.isPlaying) {
    renderer.pause();
    appState.isGsapPlaying = false;
  } else {
    renderer.play();
    appState.isGsapPlaying = true;
  }
  updatePlayButton();
}

async function restartDirectRenderer() {
  const renderer = await ensureDirectRenderer(appState.activeScene);
  if (!renderer || !isDirectRenderMode()) return;

  renderer.restart();
  frameScrubber.max = String(renderer.totalFrames - 1);
  frameScrubber.value = "0";
  appState.isGsapPlaying = false;
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
  if (appState.activeDebugTab === "stage") {
    renderStageDebug(appState.activeAssetTimeline, entries);
  } else if (appState.activeDebugTab === "labels") {
    if (appState.activeAssetTimeline) {
      renderLabelDebug(appState.activeAssetTimeline, frameIndex);
    } else {
      renderDirectMetadataDebug(renderer, "Direct SWF labels are evaluated internally by the renderer.");
    }
  } else {
    if (appState.activeAssetTimeline) {
      renderActionDebug(appState.activeAssetTimeline, frameIndex);
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

async function loadAssetTimeline(scene: TourScene, entryTarget?: SceneEntryTarget, preserveExternalLevels = false) {
  appState.timeline?.kill();
  appState.activeAssetTimeline = null;
  playerController.deactivate();
  destroyDirectRenderer();
  stopAwaitingLoop();
  stopCurrentVoiceover();
  appState.lastSoundFrameKey = "";
  appState.lastFrameFunctionCallKey = "";
  playedSpriteSoundKeys.clear();
  appState.renderedInstances = new Map();
  assetStage.querySelectorAll(".asset-instance").forEach((node) => node.remove());
  gsapDisplayRenderer.clear();
  directSwfLayer.hidden = true;
  directSwfLayer.replaceChildren();
  externalLevelLayer.hidden = false;
  appState.highlightedDepth = null;
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

  appState.activeAssetTimeline = loadedTimeline;
  await loadExtractedFonts(appState.activeAssetTimeline);
  if (!appState.activeAssetTimeline.frameSvgs?.length) {
    appState.activeAssetTimeline.frameSvgs = Array.from(
      { length: appState.activeAssetTimeline.frameCount },
      (_, index) => `generated/${appState.activeAssetTimeline!.scene}/frames/${index + 1}.svg`,
    );
  }
  appState.assetTimelineVersion += 1;
  // The decompiled player is the primary experience; other modes remain for
  // comparison via the dropdown.
  renderModeSelect.value = "player";
  assetStage.style.background = appState.activeAssetTimeline.backgroundColor ?? "#ffffff";
  frameScrubber.max = String(appState.activeAssetTimeline.frameCount - 1);
  const entryFrame = resolveSceneEntryFrame(appState.activeAssetTimeline, entryTarget);
  emptyMessage.hidden = true;
  assetName.textContent = `${appState.activeAssetTimeline.frameCount} frames @ ${appState.activeAssetTimeline.fps} fps`;
  // Build the flat GSAP timeline that the legacy comparison modes depend on.
  buildGsapAssetPlayer(appState.activeAssetTimeline);
  frameScrubber.value = String(entryFrame);
  if (isPlayerMode()) {
    activatePlayerMode();
  } else {
    goToFrame(entryFrame, false);
  }
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

function buildGsapAssetPlayer(assetTimeline: AssetTimeline) {
  const state = { frame: 0 };
  const setFrame = () => {
    const frame = Math.round(state.frame);
    frameScrubber.value = String(frame);
    renderFrame(assetTimeline, frame);
  };

  setFrame();
  appState.timeline = gsap.timeline({ repeat: -1, paused: true });
  appState.timeline.to(state, {
    frame: assetTimeline.frames.length - 1,
    duration: assetTimeline.duration,
    ease: `steps(${assetTimeline.frames.length - 1})`,
    onUpdate: setFrame,
    onRepeat: setFrame,
  });
}

function renderFrame(assetTimeline: AssetTimeline, index: number) {
  // The decompiled player owns its own layer and render loop.
  if (renderModeSelect.value === "player") return;

  const frame = assetTimeline.frames[Math.max(0, Math.min(assetTimeline.frames.length - 1, index))];
  const mode = renderModeSelect.value;
  updateStaticReference(assetTimeline, frame.index);

  if (mode === "direct") {
    appState.timeline?.pause();
    appState.isGsapPlaying = Boolean(appState.directSwfRenderer?.isPlaying);
    stopAwaitingLoop();
    clearButtonVisualState();
    appState.frameSvgRequest += 1;
    frameStageImage.hidden = true;
    frameStageInline.replaceChildren();
    assetStage.querySelectorAll(".asset-instance").forEach((node) => node.remove());
    appState.renderedInstances.clear();
    gsapDisplayLayer.hidden = true;
    externalLevelLayer.hidden = true;
    awaitingLoopLayer.replaceChildren();
    directSwfLayer.hidden = false;
    void renderDirectSwfFrame(frame.index);
    return;
  }

  appState.directSwfRenderer?.pause();
  directSwfLayer.hidden = true;
  externalLevelLayer.hidden = false;

  if (!appState.isRunningExtractedAction && appState.isGsapPlaying && shouldStopAtFrame(assetTimeline, frame.index)) {
    appState.timeline?.pause(frame.index / assetTimeline.fps);
    appState.isGsapPlaying = false;
    setFrameStatus(assetTimeline, frame.index, 0);
    return;
  }

  if (!appState.isRunningExtractedAction && appState.isGsapPlaying) {
    const swfLoadActions = rootSwfLoadActionsAtFrame(assetTimeline, frame.index);
    for (const action of swfLoadActions) rememberLoadedLevel(action, assetTimeline, frame.index);
    const swfAction = primaryRootSwfNavigation(swfLoadActions);
    if (swfAction?.swf) {
      appState.isRunningExtractedAction = true;
      runtimeGlobals["nav.targSection"] = "";
      queueShellLevelCallsForLoadedScene(assetTimeline, frame.index, swfAction.swf);
      status.textContent = `Loading ${swfAction.swf}`;
      void navigateToSceneBySwf(swfAction.swf).finally(() => {
        appState.isRunningExtractedAction = false;
      });
      return;
    }

    const levelGoto = rootLevelGotoAtFrame(assetTimeline, frame.index);
    if (levelGoto) {
      const targetSwf = loadedLevelSwfs[levelGoto.level];
      if (targetSwf) {
        appState.isRunningExtractedAction = true;
        runtimeGlobals["nav.targSection"] = "";
        status.textContent = `Loading ${targetSwf}`;
        void navigateToSceneBySwf(targetSwf, levelGoto.action).finally(() => {
          appState.isRunningExtractedAction = false;
        });
        return;
      }
    }

    const extractedAction = rootTimelineActionAtFrame(assetTimeline, frame.index);
    const targetFrame = extractedAction ? resolveRuntimeFrame(extractedAction, assetTimeline, frame.index) : -1;
    if (extractedAction && targetFrame >= 0 && targetFrame !== frame.index) {
      appState.isRunningExtractedAction = true;
      goToFrame(targetFrame, extractedAction.command === "gotoAndPlay");
      appState.isRunningExtractedAction = false;
      return;
    }
  }

  if (mode === "frame" && assetTimeline.frameSvgs?.length) {
    triggerFrameSounds(assetTimeline, frame.index);
    runFrameFunctionCalls(assetTimeline, frame.index);
    assetStage.querySelectorAll(".asset-instance").forEach((node) => node.remove());
    appState.renderedInstances.clear();
    gsapDisplayLayer.hidden = true;
    frameStageImage.hidden = true;
    void renderInlineFrameSvg(assetTimeline.frameSvgs[frame.index], appState.assetTimelineVersion, frame.index);
    updateDebugPanel(assetTimeline, frame.index);
    return;
  }

  if (mode === "gsap") {
    appState.frameSvgRequest += 1;
    frameStageImage.hidden = true;
    frameStageInline.replaceChildren();
    assetStage.querySelectorAll(".asset-instance").forEach((node) => node.remove());
    appState.renderedInstances.clear();
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

  for (const [depth, rendered] of appState.renderedInstances) {
    if (!liveDepths.has(depth)) {
      rendered.element.remove();
      appState.renderedInstances.delete(depth);
    }
  }

  setFrameStatus(assetTimeline, frame.index, 0);
  updateDebugPanel(assetTimeline, frame.index);
}

async function renderInlineFrameSvg(src: string, version: number, frameIndex: number) {
  const url = `/${src}?v=${version}`;
  const request = ++appState.frameSvgRequest;
  let svg = frameSvgCache.get(url);

  if (!svg) {
    const response = await fetch(url);
    if (!response.ok) return;
    svg = await response.text();
    svg = svg.replace(/<\?xml[^>]*>\s*/i, "");
    frameSvgCache.set(url, svg);
  }

  if (request !== appState.frameSvgRequest || renderModeSelect.value !== "frame") return;
  clearButtonVisualState();
  frameStageInline.innerHTML = svg;
  const element = frameStageInline.querySelector("svg");
  element?.classList.add("inline-frame-svg");
  applyDynamicTextOverrides();
  if (appState.activeAssetTimeline) applyFrameActionTargetOverlays(appState.activeAssetTimeline, frameIndex);
  const wiredTargets = wireInlineFrameControls(frameIndex);
  if (appState.activeAssetTimeline) setFrameStatus(appState.activeAssetTimeline, frameIndex, wiredTargets);
}

function goToFrame(index: number, play: boolean) {
  if (!appState.activeAssetTimeline || !appState.timeline) return false;

  const frame = Math.max(0, Math.min(appState.activeAssetTimeline.frameCount - 1, index));
  appState.timeline.pause(frame / appState.activeAssetTimeline.fps);
  frameScrubber.value = String(frame);
  renderFrame(appState.activeAssetTimeline, frame);

  const stoppedByFrameAction = play && shouldStopAtFrame(appState.activeAssetTimeline, frame);
  appState.isGsapPlaying = play && !stoppedByFrameAction;
  updatePlayButton();
  if (appState.isGsapPlaying) appState.timeline.play(frame / appState.activeAssetTimeline.fps);
  if (stoppedByFrameAction) {
    appState.timeline.pause(frame / appState.activeAssetTimeline.fps);
    setFrameStatus(appState.activeAssetTimeline, frame, 0);
  }
  return stoppedByFrameAction;
}

function shouldStopAtFrame(assetTimeline: AssetTimeline, frame: number) {
  if (assetTimeline.control?.stopFrames?.includes(frame)) return true;
  return frameActionsAt(assetTimeline, frame).some((action) => action.command === "stop");
}

function applyDynamicTextOverrides() {
  const dynamicTexts = appState.activeAssetTimeline?.control?.dynamicTexts;
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
  if (appState.lastSoundFrameKey === key) return;
  appState.lastSoundFrameKey = key;

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
  if (appState.lastFrameFunctionCallKey === key) return;
  appState.lastFrameFunctionCallKey = key;

  for (const action of frameActionsAt(assetTimeline, frameIndex).filter((action) => action.command === "callFunctions" && action.functionCalls?.length)) {
    runFunctionCalls(assetTimeline, action.functionCalls!, frameIndex);
  }
}

function wireInlineFrameControls(frameIndex: number) {
  if (!appState.activeAssetTimeline?.control?.buttonActions) return 0;

  let wiredTargets = 0;
  const svg = frameStageInline.querySelector<SVGSVGElement>("svg");
  if (!svg) return 0;
  svg.querySelectorAll(".flash-button-overlay").forEach((node) => node.remove());
  const overlayLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  overlayLayer.classList.add("flash-button-overlay-layer");
  svg.append(overlayLayer);

  for (const [characterId, action] of Object.entries(appState.activeAssetTimeline.control.buttonActions)) {
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

  const overlays = createButtonHitOverlays(svg, overlayLayer, appState.activeAssetTimeline, frameIndex);
  const timelineOverlays = createTimelineButtonHitOverlays(svg, overlayLayer, appState.activeAssetTimeline, frameIndex);
  return Math.max(wiredTargets, overlays + timelineOverlays);
}

function handleReleaseClick(event: Event, release: ControlAction) {
  event.preventDefault();
  event.stopPropagation();
  if (release.exitNavigation) {
    if (!appState.activeAssetTimeline) return;
    runtimeGlobals[release.exitNavigation.variable] = release.exitNavigation.value;
    goToFrame(release.exitNavigation.exitFrame, true);
    status.textContent = `Playing ${release.exitNavigation.exitLabel ?? "exit navigation"} toward ${release.exitNavigation.swf}`;
    return;
  }

  if (release.functionCalls?.length && appState.activeAssetTimeline) {
    const handled = runFunctionCalls(appState.activeAssetTimeline, release.functionCalls, Number(frameScrubber.value));
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

  if (!appState.activeAssetTimeline) return;
  if (release.nestedSection) {
    goToFrame(release.nestedSection.frame, true);
    status.textContent = `Playing nested section at ${release.nestedSection.label}`;
    return;
  }

  const targetFrame = resolveRuntimeFrame(release, appState.activeAssetTimeline, Number(frameScrubber.value));
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
  appState.buttonStateElement = image;
}

function clearButtonVisualState() {
  appState.buttonStateElement?.remove();
  appState.buttonStateElement = null;
}

function handleButtonHover(characterId: string, eventName: "rollOver" | "rollOut", frameIndex: number) {
  const assetTimeline = appState.activeAssetTimeline;
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
  appState.hoverSpriteElement = element;

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
  appState.hoverSpriteTimer = window.setInterval(() => {
    if (!render()) stopHoverSprite(false);
  }, 1000 / Math.max(1, assetTimeline.fps));
}

function stopHoverSprite(removeElement = true) {
  if (appState.hoverSpriteTimer) {
    window.clearInterval(appState.hoverSpriteTimer);
    appState.hoverSpriteTimer = 0;
  }
  if (removeElement) {
    restoreStaticHoverSources();
    appState.hoverSpriteElement?.remove();
    appState.hoverSpriteElement = null;
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
  for (const node of frameStageInline.querySelectorAll<SVGGraphicsElement>(`[ffdec\\:characterId="${characterId}"]`)) {
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

function setFrameStatus(assetTimeline: AssetTimeline, frameIndex: number, wiredTargets: number) {
  const frame = assetTimeline.frames[frameIndex];
  const label = frame?.label || `frame ${frameIndex + 1}`;
  const stopped = shouldStopAtFrame(assetTimeline, frameIndex);
  const choiceLoop = isChoiceLoopFrame(assetTimeline, frameIndex);
  const nestedSectionActive = stopped && hasActiveNestedSection(assetTimeline, frameIndex);
  const interactiveHold = wiredTargets > 0 && !appState.isGsapPlaying && frameIndex !== assetTimeline.entryFrame;
  appState.isNestedSectionActive = nestedSectionActive;
  appState.isAwaitingSelection = !nestedSectionActive && (stopped || choiceLoop || interactiveHold) && wiredTargets > 0;
  status.dataset.mode = appState.isAwaitingSelection ? "waiting" : nestedSectionActive || !stopped ? "playing" : "stopped";

  if (nestedSectionActive) {
    status.textContent = `Playing nested section at ${label}`;
    startAwaitingLoop(assetTimeline, frameIndex, true);
  } else if (appState.isAwaitingSelection && choiceLoop && !stopped) {
    status.textContent = `Awaiting user selection loop at ${label}`;
    stopAwaitingLoop();
  } else if (appState.isAwaitingSelection) {
    status.textContent = `Awaiting user selection at ${label}`;
    startAwaitingLoop(assetTimeline, frameIndex);
  } else if (stopped) {
    status.textContent = `Stopped at ${label}`;
    stopAwaitingLoop();
  } else if (appState.isGsapPlaying) {
    status.textContent = `Playing ${assetTimeline.scene}`;
    stopAwaitingLoop();
  } else {
    status.textContent = `Ready at ${label}`;
    stopAwaitingLoop();
  }

  updatePlayButton();
}

function updatePlayButton() {
  if (isPlayerMode()) {
    playBtn.disabled = false;
    playBtn.textContent = playerController.isPlaying ? "Pause" : "Play GSAP";
    return;
  }

  if (isDirectRenderMode()) {
    playBtn.disabled = false;
    playBtn.textContent = appState.isGsapPlaying ? "Pause Direct" : "Play Direct";
    return;
  }

  playBtn.disabled = appState.isAwaitingSelection || appState.isNestedSectionActive;
  playBtn.textContent = appState.isNestedSectionActive ? "Section Playing" : appState.isAwaitingSelection ? "Awaiting Choice" : appState.isGsapPlaying ? "Pause GSAP" : "Play GSAP";
}

function updateStaticReference(assetTimeline: AssetTimeline, frameIndex: number) {
  const src = assetTimeline.frameSvgs?.[frameIndex];
  if (src) referenceFrameImage.src = `/${src}`;
  referenceName.textContent = `${assetTimeline.scene}`;
  const label = frameLabel(assetTimeline, frameIndex);
  referenceFrameMeta.textContent = `Frame ${frameIndex}${label ? ` - ${label}` : ""}`;
}

function updateDebugPanel(
  assetTimeline = appState.activeAssetTimeline,
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

  if (appState.activeDebugTab === "labels") {
    renderLabelDebug(assetTimeline, frameIndex);
  } else if (appState.activeDebugTab === "actions") {
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
    button.classList.toggle("is-highlighted", appState.highlightedDepth === entry.depth);
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
      appState.highlightedDepth = appState.highlightedDepth === entry.depth ? null : entry.depth;
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
  if (appState.highlightedDepth === null) return;
  assetStage.querySelectorAll<HTMLElement>(`[data-depth="${appState.highlightedDepth}"]`).forEach((node) => {
    node.classList.add("depth-highlight");
  });
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

  if (appState.awaitingLoopTimer) window.clearInterval(appState.awaitingLoopTimer);
  appState.awaitingLoopTick = 0;
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
    appState.awaitingLoopTick += 1;
  };

  renderLoopFrame();
  appState.awaitingLoopTimer = window.setInterval(renderLoopFrame, 1000 / Math.max(1, assetTimeline.fps));
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
    appState.isNestedSectionActive = false;
    appState.isAwaitingSelection = true;
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

function pauseAwaitingLoop() {
  if (appState.awaitingLoopTimer) {
    window.clearInterval(appState.awaitingLoopTimer);
    appState.awaitingLoopTimer = 0;
  }
}

function stopAwaitingLoop() {
  pauseAwaitingLoop();
  stopHoverSprite();
  restoreStaticAwaitingSources();
  awaitingLoopLayer.replaceChildren();
}

function frameActionsAt(assetTimeline: AssetTimeline, frame: number) {
  return selectRuntimeActions(allFrameActionsAt(assetTimeline, frame), runtimeValues(assetTimeline));
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

function rememberLoadedLevel(action: ControlAction, assetTimeline?: AssetTimeline, frame?: number) {
  const level = actionLevel(action);
  if (level === undefined || !action.swf) return;
  loadedLevelSwfs[level] = action.swf;
  if (level !== 4 && assetTimeline && frame !== undefined) queueExternalLevelCallsAtFrame(assetTimeline, frame, level);
  if (level !== 4) void ensureExternalLevel(level, action.swf);
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

function renderExternalLevelFrame(level: number, frame: number) {
  const record = externalLevels.get(level);
  if (!record?.timeline?.frameSvgs?.length) return false;
  record.frame = clampFrame(frame, record.timeline);
  record.image.src = `/${record.timeline.frameSvgs[record.frame]}`;
  record.element.dataset.frame = String(record.frame);
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

function syncAssetStageScale() {
  const rect = assetWrap.getBoundingClientRect();
  const scale = Math.min(rect.width / 640, rect.height / 480);
  assetStage.style.setProperty("--stage-scale", String(scale));
}

function ensureRenderedInstance(depth: number, characterId: number, asset: TimelineAsset, frameIndex: number) {
  const existing = appState.renderedInstances.get(depth);
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
  appState.renderedInstances.set(depth, rendered);
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
