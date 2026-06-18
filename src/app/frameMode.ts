// Frame-SVG reference render mode: per-frame rendering, sounds, button overlays,
// hover sprites, awaiting/section loops, nested target overlays.

import { gsap } from "gsap";
import {
  assetStage, assetWrap, awaitingLoopLayer, directSwfLayer, externalLevelLayer, frameScrubber,
  frameStageImage, frameStageInline, gsapDisplayLayer, referenceFrameImage, referenceFrameMeta,
  referenceName, renderModeSelect, status,
} from "./dom";
import {
  frameSvgCache, gsapDisplayRenderer, hiddenAwaitingSources, hiddenHoverSources, loadedLevelSwfs,
  playedSpriteSoundKeys, runtimeGlobals, state as appState,
} from "./state";
import { ffdecCharacterId, matrixToSvg, timelineMatrixToDomMatrix, timelineMatrixToSvg, walkVisibleSvgTree } from "./svgUtils";
import { extractedFontFamilyStack } from "./fonts";
import {
  evaluateFunctionActionCondition, frameActionsAt, isChoiceLoopFrame, rootLevelGotoAtFrame,
  rootSwfLoadActionsAtFrame, rootTimelineActionAtFrame, runtimeValues, shouldStopAtFrame, spriteActionsAt,
} from "./runtimeActions";
import {
  actionTargetKeys, buttonHitCharacterMap, findFrameInstanceByTarget, frameLabel, functionActionsFor,
  hasActiveNestedSection, hasReachedSpriteStop, hasReachedSpriteStopSince, instanceTargetKeys,
  isNestedSectionInstance, normalizeTargetName, primaryRootSwfNavigation, resolveRuntimeFrame,
  resolveSpriteFrame, rootFunctionActionsFor,
} from "./timelineQueries";
import { playBackgroundMusic, playVoiceover, stopCurrentVoiceover } from "./audio";
import { updatePlayButton } from "./modes";
import { updateDebugPanel } from "./debugPanel";
import { renderDirectSwfFrame } from "./directMode";
import { setStageScale, snapTranslate } from "../render/renderTuning";
import { navigateToSceneBySwf } from "./sceneLoader";
import { queueShellLevelCallsForLoadedScene, rememberLoadedLevel, runExternalLevelFunctionCall } from "./externalLevels";
import type { AssetTimeline, ControlAction, RenderedLoopItem, TimelineAsset, TimelineFrame } from "./frameModeTypes";
import { wireInlineFrameControls, handleReleaseClick, bindReleaseAction, createButtonHitOverlays, createTimelineButtonHitOverlays, showButtonVisualState, clearButtonVisualState, handleButtonHover } from "./buttonOverlays";
import { startAwaitingLoop, runNestedSectionAction, runSpriteSelfAction, runTargetedSpriteAction, renderNestedTargetOverlay, runNestedFunctionCallAction, nestedTargetOverlayKey, applyFrameActionTargetOverlays, expandedFrameTargetActionsAt, pauseAwaitingLoop, stopAwaitingLoop, playHoverSprite, stopHoverSprite, hideStaticHoverSource, restoreStaticHoverSources, hideStaticAwaitingSource, restoreStaticAwaitingSources, renderFunctionSpriteOverlay } from "./spriteLoops";

export function renderFrame(assetTimeline: AssetTimeline, index: number) {
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
    const [stx, sty] = snapTranslate(tx, ty);
    rendered.element.style.zIndex = String(instance.depth);
    rendered.element.style.opacity = String(instance.opacity);
    rendered.element.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${stx}, ${sty})`;

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

export async function renderInlineFrameSvg(src: string, version: number, frameIndex: number) {
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

export function goToFrame(index: number, play: boolean) {
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

export function applyDynamicTextOverrides() {
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

export function triggerFrameSounds(assetTimeline: AssetTimeline, frameIndex: number) {
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

export function triggerSpriteFrameSounds(assetTimeline: AssetTimeline, spriteId: number, spriteFrame: number, scope: string) {
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

export function runFrameFunctionCalls(assetTimeline: AssetTimeline, frameIndex: number) {
  const key = `${assetTimeline.scene}:${frameIndex}`;
  if (appState.lastFrameFunctionCallKey === key) return;
  appState.lastFrameFunctionCallKey = key;

  for (const action of frameActionsAt(assetTimeline, frameIndex).filter((action) => action.command === "callFunctions" && action.functionCalls?.length)) {
    runFunctionCalls(assetTimeline, action.functionCalls!, frameIndex);
  }
}

export function runFunctionCalls(
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

export function setFrameStatus(assetTimeline: AssetTimeline, frameIndex: number, wiredTargets: number) {
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

export function updateStaticReference(assetTimeline: AssetTimeline, frameIndex: number) {
  const src = assetTimeline.frameSvgs?.[frameIndex];
  if (src) referenceFrameImage.src = `/${src}`;
  referenceName.textContent = `${assetTimeline.scene}`;
  const label = frameLabel(assetTimeline, frameIndex);
  referenceFrameMeta.textContent = `Frame ${frameIndex}${label ? ` - ${label}` : ""}`;
}

export function syncAssetStageScale() {
  const rect = assetWrap.getBoundingClientRect();
  const scale = Math.min(rect.width / 640, rect.height / 480);
  assetStage.style.setProperty("--stage-scale", String(scale));
  setStageScale(scale);
}

export function ensureRenderedInstance(depth: number, characterId: number, asset: TimelineAsset, frameIndex: number) {
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

export function createAssetElement(asset: TimelineAsset, frameIndex: number) {
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
