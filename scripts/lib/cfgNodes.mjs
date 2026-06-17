// Control-flow-graph node id builders + target-name helpers for the control-flow
// builder. Pure string helpers.

import { compactObject } from "./util.mjs";

export function actionTargetNode(action, context) {
  if (action.target && action.target !== "self") return targetNode(action.target);
  if (typeof action.frame === "number") {
    return context.scope === "sprite" ? spriteFrameNode(context.spriteId, action.frame) : rootFrameNode(action.frame);
  }
  if (action.label && context.labels?.has(action.label)) {
    const frame = context.labels.get(action.label);
    return context.scope === "sprite" ? spriteFrameNode(context.spriteId, frame) : rootFrameNode(frame);
  }
  if (action.frameExpression) {
    return expressionNode(action.frameExpression);
  }
  return targetNode(action.target ?? "unresolved");
}

export function actionEdge(from, to, type, action) {
  return compactObject({
    from,
    to,
    type,
    command: action.command,
    condition: action.branchCondition ?? action.functionBranchCondition,
    source: action.source,
    supported: action.supported,
    target: action.target,
    label: action.label,
    frame: action.frame,
    frameExpression: action.frameExpression,
    swf: action.swf,
    level: action.level,
    sound: action.sound,
    functionName: action.functionName,
  });
}

export function rootFrameNode(frame) {
  return `root:frame:${frame}`;
}

export function spriteFrameNode(spriteId, frame) {
  return `sprite:${spriteId}:frame:${frame}`;
}

export function functionNode(functionName) {
  return `function:${functionName ?? "anonymous"}`;
}

export function buttonNode(buttonId) {
  return `button:${buttonId}`;
}

export function targetNode(target) {
  return `target:${target}`;
}

export function expressionNode(expression) {
  return `expression:${expression}`;
}

export function swfNode(swfName, level) {
  return `swf:${swfName ?? "unknown"}${level !== undefined ? `:level:${level}` : ""}`;
}

export function soundNode(sound) {
  return `sound:${sound ?? "unknown"}`;
}

export function variableNode(variable) {
  return `variable:${variable ?? "unknown"}`;
}

export function variableSourceNode(source) {
  return `variables:${source ?? "unknown"}`;
}

export function instanceTargetKeys(name) {
  const normalized = normalizeTargetName(name);
  return normalized ? [normalized] : [];
}

export function actionTargetKeys(name) {
  const normalized = normalizeTargetName(name);
  const lastSegment = normalizeTargetName(String(name).split(".").pop() ?? "");
  return [...new Set([normalized, lastSegment].filter(Boolean))];
}

export function normalizeTargetName(name) {
  return String(name).replace(/^_root\./, "").replace(/^_parent\./, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}
