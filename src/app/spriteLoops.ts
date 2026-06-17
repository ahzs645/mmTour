// Frame-SVG sprite playback: attract/awaiting loops, nested sections, hover sprites,
// nested target overlays and the static-source hide/restore bookkeeping.

import { awaitingLoopLayer, frameStageInline, renderModeSelect, status } from "./dom";
import { hiddenAwaitingSources, hiddenHoverSources, playedSpriteSoundKeys, state as appState } from "./state";
import {
  actionTargetKeys, functionActionsFor, hasReachedSpriteStop, hasReachedSpriteStopSince,
  instanceTargetKeys, isNestedSectionInstance, normalizeTargetName, resolveRuntimeFrame,
  resolveSpriteFrame, rootFunctionActionsFor,
} from "./timelineQueries";
import { evaluateFunctionActionCondition, frameActionsAt, runtimeValues, spriteActionsAt } from "./runtimeActions";
import { goToFrame, triggerSpriteFrameSounds } from "./frameMode";
import { navigateToSceneBySwf } from "./sceneLoader";
import { updatePlayButton } from "./modes";
import type { AssetTimeline, ControlAction, RenderedLoopItem, TimelineAsset, TimelineFrame } from "./frameModeTypes";

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
