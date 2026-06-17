// External movie level (_levelN) loading + queued cross-level function calls.

import { externalLevelLayer } from "./dom";
import { externalLevels, loadedLevelSwfs, pendingExternalLevelCalls, runtimeGlobals, state as appState } from "./state";
import { actionLevel, clampFrame, externalRootFunctionActionsFor, rootFunctionActionsFor } from "./timelineQueries";
import { evaluateFunctionActionCondition, frameActionsAt, runtimeValues } from "./runtimeActions";
import { resolveRuntimeFrame } from "./timelineQueries";
import { fetchAssetTimeline } from "./sceneLoader";
import { runFunctionCalls } from "./frameMode";
import type { AssetTimeline, ControlAction } from "./frameModeTypes";

export function runExternalLevelFunctionCall(call: NonNullable<ControlAction["functionCalls"]>[number]) {
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

export function queueExternalLevelCall(level: number, call: NonNullable<ControlAction["functionCalls"]>[number]) {
  const calls = pendingExternalLevelCalls.get(level) ?? [];
  const duplicate = calls.some((candidate) => (
    candidate.target === call.target
    && candidate.functionName === call.functionName
    && candidate.arguments === call.arguments
  ));
  if (!duplicate) pendingExternalLevelCalls.set(level, [...calls, call]);
}

export function queueExternalLevelCallsAtFrame(assetTimeline: AssetTimeline, frame: number, level: number) {
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

export function queueShellLevelCallsForLoadedScene(assetTimeline: AssetTimeline, frame: number, swf: string) {
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

export function shellFunctionsInvokedByScene(swf: string) {
  if (swf.toLowerCase() !== "intro.swf") return [];
  return ["LoadIntroNav"];
}

export function callLevel(call: NonNullable<ControlAction["functionCalls"]>[number]) {
  const match = call.target.match(/^_level(\d+)(?:\.|$)/i);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

export function flushPendingExternalLevelCalls(level: number) {
  const calls = pendingExternalLevelCalls.get(level);
  if (!calls?.length) return;

  pendingExternalLevelCalls.delete(level);
  for (const call of calls) runExternalLevelFunctionCall(call);
}

export function rememberLoadedLevel(action: ControlAction, assetTimeline?: AssetTimeline, frame?: number) {
  const level = actionLevel(action);
  if (level === undefined || !action.swf) return;
  loadedLevelSwfs[level] = action.swf;
  if (level !== 4 && assetTimeline && frame !== undefined) queueExternalLevelCallsAtFrame(assetTimeline, frame, level);
  if (level !== 4) void ensureExternalLevel(level, action.swf);
}

export async function ensureExternalLevel(level: number, swf: string) {
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

export function renderExternalLevelFrame(level: number, frame: number) {
  const record = externalLevels.get(level);
  if (!record?.timeline?.frameSvgs?.length) return false;
  record.frame = clampFrame(frame, record.timeline);
  record.image.src = `/${record.timeline.frameSvgs[record.frame]}`;
  record.element.dataset.frame = String(record.frame);
  return true;
}

export function clearExternalLevels() {
  externalLevels.clear();
  pendingExternalLevelCalls.clear();
  externalLevelLayer.replaceChildren();
  for (const level of Object.keys(loadedLevelSwfs)) {
    if (Number(level) !== 4) delete loadedLevelSwfs[Number(level)];
  }
}
