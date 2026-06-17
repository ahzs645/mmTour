// Branch-condition evaluation for the frame/direct comparison render modes.
//
// This is a separate evaluator from the data-driven Player's src/player/conditions.ts:
// it operates on a flat `Record<string, RuntimeGlobalValue>` of runtime globals and is
// tri-state (true/false/undefined) so group-wise if/else selection can tell "no arm
// matched" apart from "an arm evaluated false". The Player's evalCondition works against
// a VariableStore and returns a plain boolean; the two semantics intentionally differ.

import type { ControlAction, RuntimeGlobalValue } from "./frameModeTypes";

export function isTimelineAction(action: ControlAction) {
  return action.executionContext === undefined || action.executionContext === "timeline";
}

export function selectRuntimeActions(actions: ControlAction[], globals: Record<string, RuntimeGlobalValue> = {}) {
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

export function evaluateBranchCondition(condition: string, globals: Record<string, RuntimeGlobalValue>): boolean | undefined {
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

export function splitCondition(condition: string, operator: "&&" | "||"): string[] {
  return condition
    .split(operator)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function runtimeValueFor(expression: string, globals: Record<string, RuntimeGlobalValue>) {
  const normalized = normalizeGlobalName(expression);
  return globals[normalized];
}

export function normalizeGlobalName(expression: string) {
  return expression.trim()
    .replace(/^_level0\./, "")
    .replace(/^_root\./, "");
}

export function parseRuntimeLiteral(value: string): RuntimeGlobalValue {
  const trimmed = value.trim();
  const stringValue = trimmed.match(/^"([^"]*)"$/)?.[1] ?? trimmed.match(/^'([^']*)'$/)?.[1];
  if (stringValue !== undefined) return stringValue;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const numericValue = Number(trimmed);
  return Number.isFinite(numericValue) ? numericValue : trimmed;
}
