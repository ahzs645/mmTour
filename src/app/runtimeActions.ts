// Runtime frame/sprite action selection + root navigation queries for the
// comparison render modes (evaluate branch conditions against the live globals).

import { runtimeGlobals, state as appState } from "./state";
import { evaluateBranchCondition, selectRuntimeActions } from "./runtimeConditions";
import { allFrameActionsAt, primaryRootSwfNavigation, resolveRuntimeFrame } from "./timelineQueries";
import type { AssetTimeline, ControlAction, RuntimeGlobalValue } from "./frameModeTypes";

export function shouldStopAtFrame(assetTimeline: AssetTimeline, frame: number) {
  if (assetTimeline.control?.stopFrames?.includes(frame)) return true;
  return frameActionsAt(assetTimeline, frame).some((action) => action.command === "stop");
}

export function evaluateFunctionActionCondition(action: ControlAction, globals: Record<string, RuntimeGlobalValue>) {
  if (!action.functionBranchCondition) return true;
  return evaluateBranchCondition(action.functionBranchCondition, globals) === true;
}

export function frameActionsAt(assetTimeline: AssetTimeline, frame: number) {
  return selectRuntimeActions(allFrameActionsAt(assetTimeline, frame), runtimeValues(assetTimeline));
}

export function spriteActionsAt(assetTimeline: AssetTimeline, spriteId: number, frame: number) {
  const actions = assetTimeline.control?.spriteActions
    ?.filter((entry) => entry.spriteId === spriteId && entry.frame === frame)
    .flatMap((entry) => entry.actions) ?? [];
  return selectRuntimeActions(actions, {
    ...runtimeValues(assetTimeline),
    ...(assetTimeline.control?.spriteLocalDefaults?.[String(spriteId)] ?? {}),
  });
}

export function runtimeValues(assetTimeline: AssetTimeline) {
  return {
    ...(assetTimeline.control?.globalDefaults ?? {}),
    ...runtimeGlobals,
  };
}

export function rootTimelineActionAtFrame(assetTimeline: AssetTimeline, frame: number) {
  return frameActionsAt(assetTimeline, frame).find((action) => {
    if (action.command !== "gotoAndPlay" && action.command !== "gotoAndStop") return false;
    return action.target === "self" || action.target === "_root";
  });
}

export function rootSwfNavigationAtFrame(assetTimeline: AssetTimeline, frame: number) {
  return primaryRootSwfNavigation(rootSwfLoadActionsAtFrame(assetTimeline, frame));
}

export function rootSwfLoadActionsAtFrame(assetTimeline: AssetTimeline, frame: number) {
  return frameActionsAt(assetTimeline, frame).filter((action) => {
    return (action.command === "doRelease" || action.command === "loadMovieNum") && Boolean(action.swf);
  });
}

export function rootLevelGotoAtFrame(assetTimeline: AssetTimeline, frame: number) {
  const action = frameActionsAt(assetTimeline, frame).find((candidate) => {
    if (candidate.command !== "gotoAndPlay" && candidate.command !== "gotoAndStop") return false;
    return /^_level\d+$/i.test(candidate.target ?? "");
  });
  const level = Number.parseInt(action?.target?.match(/^_level(\d+)$/i)?.[1] ?? "", 10);
  return action && Number.isFinite(level) ? { level, action } : null;
}

export function isChoiceLoopFrame(assetTimeline: AssetTimeline, frame: number) {
  const nextFrameAction = rootTimelineActionAtFrame(assetTimeline, frame + 1);
  if (nextFrameAction?.command !== "gotoAndPlay") return false;
  const target = resolveRuntimeFrame(nextFrameAction, assetTimeline, frame + 1);
  return target >= 0 && target <= frame;
}
