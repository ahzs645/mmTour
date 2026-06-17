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
import { navigateToSceneBySwf } from "./sceneLoader";
import { queueShellLevelCallsForLoadedScene, rememberLoadedLevel, runExternalLevelFunctionCall } from "./externalLevels";
import type { AssetTimeline, ControlAction, RenderedLoopItem, TimelineAsset, TimelineFrame } from "./frameModeTypes";

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

export function wireInlineFrameControls(frameIndex: number) {
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

export function handleReleaseClick(event: Event, release: ControlAction) {
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

export function renderFunctionSpriteOverlay(
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

export function bindReleaseAction(element: Element, release: ControlAction) {
  let handled = false;
  const run = (event: Event) => {
    if (handled) return;
    handled = true;
    handleReleaseClick(event, release);
  };
  element.addEventListener("pointerup", run);
  element.addEventListener("click", run);
}

export function createButtonHitOverlays(
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

export function createTimelineButtonHitOverlays(
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

export function showButtonVisualState(
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

export function clearButtonVisualState() {
  appState.buttonStateElement?.remove();
  appState.buttonStateElement = null;
}

export function handleButtonHover(characterId: string, eventName: "rollOver" | "rollOut", frameIndex: number) {
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

export function playHoverSprite(
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

export function stopHoverSprite(removeElement = true) {
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

export function hideStaticHoverSource(characterId: number) {
  for (const node of frameStageInline.querySelectorAll<SVGGraphicsElement>(`[ffdec\\:characterId="${characterId}"]`)) {
    if (node.closest(".flash-button-overlay-layer")) continue;
    if (node.style.visibility === "hidden") continue;
    node.style.visibility = "hidden";
    hiddenHoverSources.push(node);
  }
}

export function restoreStaticHoverSources() {
  for (const node of hiddenHoverSources.splice(0)) {
    node.style.visibility = "";
  }
}

export function hideStaticAwaitingSource(characterId: number) {
  for (const node of frameStageInline.querySelectorAll<SVGGraphicsElement>(`[ffdec\\:characterId="${characterId}"]`)) {
    if (node.closest(".flash-button-overlay-layer")) continue;
    if (node.style.visibility === "hidden") continue;
    node.style.visibility = "hidden";
    hiddenAwaitingSources.push(node);
  }
}

export function restoreStaticAwaitingSources() {
  for (const node of hiddenAwaitingSources.splice(0)) {
    node.style.visibility = "";
  }
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

export function startAwaitingLoop(assetTimeline: AssetTimeline, frameIndex: number, sectionOnly = false) {
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

export function runNestedSectionAction(assetTimeline: AssetTimeline, rootFrameIndex: number, spriteId: number, spriteFrame: number) {
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

export function runSpriteSelfAction(
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

export function runTargetedSpriteAction(
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

export function renderNestedTargetOverlay(assetTimeline: AssetTimeline, action: ControlAction, sourceItem: RenderedLoopItem) {
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

export function runNestedFunctionCallAction(assetTimeline: AssetTimeline, action: ControlAction, sourceItem: RenderedLoopItem) {
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

export function nestedTargetOverlayKey(action: ControlAction, characterId: number) {
  return `${characterId}:${normalizeTargetName(action.target ?? "")}:${action.command ?? ""}`;
}

export function applyFrameActionTargetOverlays(assetTimeline: AssetTimeline, frameIndex: number) {
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

export function expandedFrameTargetActionsAt(assetTimeline: AssetTimeline, frameIndex: number) {
  const actions = frameActionsAt(assetTimeline, frameIndex);
  const functionActions = actions
    .filter((action) => action.command === "callFunctions" && action.functionCalls?.length)
    .flatMap((action) => rootFunctionActionsFor(assetTimeline, action.functionCalls ?? []))
    .filter((action) => evaluateFunctionActionCondition(action, runtimeValues(assetTimeline)));
  return [...actions, ...functionActions];
}

export function pauseAwaitingLoop() {
  if (appState.awaitingLoopTimer) {
    window.clearInterval(appState.awaitingLoopTimer);
    appState.awaitingLoopTimer = 0;
  }
}

export function stopAwaitingLoop() {
  pauseAwaitingLoop();
  stopHoverSprite();
  restoreStaticAwaitingSources();
  awaitingLoopLayer.replaceChildren();
}

export function syncAssetStageScale() {
  const rect = assetWrap.getBoundingClientRect();
  const scale = Math.min(rect.width / 640, rect.height / 480);
  assetStage.style.setProperty("--stage-scale", String(scale));
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
