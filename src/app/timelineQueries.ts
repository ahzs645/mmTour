// Pure query/resolution helpers over the extracted timeline for the frame/direct
// comparison render modes. No module state: each is a function of its arguments.

import type { AssetTimeline, ControlAction, TimelineAsset, TimelineFrame, SceneEntryTarget } from "./frameModeTypes";

export function findFrameInstanceByTarget(assetTimeline: AssetTimeline, frameIndex: number, target: string) {
  const frame = assetTimeline.frames[frameIndex];
  const targetKeys = actionTargetKeys(target);
  return frame?.instances.find((instance) => instanceTargetKeys(instance.name).some((key) => targetKeys.includes(key)));
}

export function functionActionsFor(assetTimeline: AssetTimeline, spriteId: number, functionName: string) {
  return assetTimeline.control?.spriteActions
    ?.filter((entry) => entry.spriteId === spriteId)
    .flatMap((entry) => entry.actions)
    .filter((action) => action.functionName === functionName) ?? [];
}

export function rootFunctionActionsFor(assetTimeline: AssetTimeline, calls: NonNullable<ControlAction["functionCalls"]>) {
  const rootFunctionNames = calls
    .filter((call) => call.target === "_root" || call.target === "_parent" || call.target === "_level0")
    .map((call) => call.functionName);
  if (!rootFunctionNames.length) return [];

  return assetTimeline.control?.frameActions
    ?.flatMap((entry) => entry.actions)
    .filter((action) => action.functionName && rootFunctionNames.includes(action.functionName)) ?? [];
}

export function externalRootFunctionActionsFor(assetTimeline: AssetTimeline, functionName: string) {
  return assetTimeline.control?.frameActions
    ?.flatMap((entry) => entry.actions)
    .filter((action) => action.functionName === functionName) ?? [];
}

export function buttonHitCharacterMap(assetTimeline: AssetTimeline) {
  const mapped = new Map<string, string>();
  for (const definition of assetTimeline.control?.buttonDefinitions ?? []) {
    const buttonId = String(definition.id);
    for (const record of definition.hitAreas ?? definition.states?.hitTest ?? []) {
      mapped.set(String(record.characterId), buttonId);
    }
  }
  return mapped;
}

export function resolveSpriteFrame(
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

export function frameLabel(assetTimeline: AssetTimeline, frameIndex: number) {
  return assetTimeline.frames[frameIndex]?.label
    || Object.entries(assetTimeline.labels ?? {}).find(([, frame]) => frame === frameIndex)?.[0]
    || "";
}

export function instanceTargetKeys(name: string) {
  const normalized = normalizeTargetName(name);
  return normalized ? [normalized] : [];
}

export function actionTargetKeys(name: string) {
  const normalized = normalizeTargetName(name);
  const lastSegment = normalizeTargetName(name.split(".").pop() ?? "");
  return [...new Set([normalized, lastSegment].filter(Boolean))];
}

export function normalizeTargetName(name: string) {
  return name.replace(/^_root\./, "").replace(/^_parent\./, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function hasReachedSpriteStop(assetTimeline: AssetTimeline, characterId: number, relativeFrame: number) {
  const stops = assetTimeline.control?.spriteStopFrames?.[String(characterId)] ?? [];
  return stops.some((stopFrame) => stopFrame <= relativeFrame);
}

export function hasReachedSpriteStopSince(assetTimeline: AssetTimeline, characterId: number, relativeFrame: number, startFrame: number) {
  const stops = assetTimeline.control?.spriteStopFrames?.[String(characterId)] ?? [];
  return stops.some((stopFrame) => stopFrame >= startFrame && stopFrame <= relativeFrame);
}

export function hasActiveNestedSection(assetTimeline: AssetTimeline, frameIndex: number) {
  const frame = assetTimeline.frames[frameIndex];
  return frame.instances.some((instance) => {
    const asset = assetTimeline.assets[String(instance.characterId)];
    if (!asset || asset.kind !== "sprite" || !asset.frames?.length) return false;
    const relativeFrame = Math.max(0, frame.index - instance.placedFrame);
    return isNestedSectionInstance(instance, asset) && !hasReachedSpriteStop(assetTimeline, instance.characterId, relativeFrame);
  });
}

export function isNestedSectionInstance(instance: TimelineFrame["instances"][number], asset: TimelineAsset) {
  return /^mc_/i.test(instance.name) && asset.kind === "sprite" && (asset.frames?.length ?? 0) >= 30;
}

export function allFrameActionsAt(assetTimeline: AssetTimeline, frame: number) {
  return assetTimeline.control?.frameActions
    ?.filter((entry) => entry.frame === frame)
    .flatMap((entry) => entry.actions) ?? [];
}

export function resolveSceneEntryFrame(assetTimeline: AssetTimeline, entryTarget?: SceneEntryTarget) {
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

export function primaryRootSwfNavigation(actions: ControlAction[]) {
  return actions.find((action) => actionLevel(action) === 4)
    ?? actions.find((action) => actionLevel(action) !== 6)
    ?? actions[0];
}

export function actionLevel(action: ControlAction) {
  const value = typeof action.level === "number" ? action.level : Number.parseInt(String(action.level ?? ""), 10);
  return Number.isFinite(value) ? value : undefined;
}

export function resolveRuntimeFrame(action: ControlAction, assetTimeline: AssetTimeline, currentFrame: number) {
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

export function clampFrame(frame: number, assetTimeline: AssetTimeline) {
  return Math.max(0, Math.min(assetTimeline.frameCount - 1, frame));
}
