// Frame-SVG button hit overlays, release handling, and hover/visual state.

import { frameScrubber, frameStageInline, status } from "./dom";
import { runtimeGlobals, state as appState } from "./state";
import { ffdecCharacterId, matrixToSvg, timelineMatrixToDomMatrix, timelineMatrixToSvg, walkVisibleSvgTree } from "./svgUtils";
import { buttonHitCharacterMap, resolveRuntimeFrame, resolveSpriteFrame } from "./timelineQueries";
import { playHoverSprite } from "./spriteLoops";
import { goToFrame, runFunctionCalls } from "./frameMode";
import { navigateToSceneBySwf } from "./sceneLoader";
import type { AssetTimeline, ControlAction, TimelineAsset } from "./frameModeTypes";

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
