import type { AssetTimeline, ButtonActionRecord, ControlAction, DefinedFunction, ExitNavigation, TimelineAsset, TimelineControl } from "../data/timelineTypes.ts";
import { evalCondition } from "../player/conditions.ts";
import { normalizeVarName, VariableStore } from "../player/VariableStore.ts";

type AssetMap = AssetTimeline["assets"];
type NestedSectionTarget = { label: string; frame: number };
type SectionNavigationTarget = { swf: string; frame: number; level?: number };
type ExitFunctionTarget = { exitFrame: number; exitLabel?: string };
type ExitNavigationIndex = {
  sectionTargets: Map<string, SectionNavigationTarget[]>;
  functionTargets: Map<string, ExitFunctionTarget>;
};

/**
 * Add control metadata that is only knowable after the display-list timelines
 * exist. This keeps the browser converter close to the FFDec pipeline without
 * baking in any scene, frame, or character assumptions.
 */
export function enrichControlWithTimelineData<T extends TimelineControl>(
  control: T,
  assets: AssetMap,
  labels: Record<string, number> = {},
): T {
  const nestedSectionTargets = {
    ...inferNestedSectionTargets(control.buttonActions ?? {}, labels),
    ...(control.nestedSectionTargets ?? {}),
  };
  const exitNavigation = inferExitNavigationIndex(control, labels);
  return {
    ...control,
    ...(Object.keys(nestedSectionTargets).length ? { nestedSectionTargets } : {}),
    buttonActions: enrichButtonActions(control.buttonActions ?? {}, assets, nestedSectionTargets, labels, exitNavigation),
  };
}

export function enrichButtonActions(
  buttonActions: Record<string, ButtonActionRecord>,
  assets: AssetMap,
  nestedSectionTargets: Record<string, NestedSectionTarget> = {},
  labels: Record<string, number> = {},
  exitNavigation?: ExitNavigationIndex,
): Record<string, ButtonActionRecord> {
  const ownerSpriteIds = inferButtonOwnerSpriteIds(assets, Object.keys(buttonActions));
  return Object.fromEntries(Object.entries(buttonActions).map(([buttonId, group]) => {
    const owners = ownerSpriteIds[buttonId] ?? group.ownerSpriteIds ?? [];
    const releaseTarget = group.release?.target ?? "";
    const release = group.release
      ? enrichButtonEventAction(
          enrichButtonExitNavigation(
            nestedSectionTargets[releaseTarget] ? { ...group.release, nestedSection: nestedSectionTargets[releaseTarget] } : group.release,
            exitNavigation,
          ),
          labels,
        )
      : undefined;
    return [
      buttonId,
      {
        ...group,
        ...(owners.length ? { ownerSpriteIds: owners } : {}),
        ...(release ? { release } : {}),
        ...(group.rollOver ? { rollOver: enrichButtonEventAction(group.rollOver, labels) } : {}),
        ...(group.rollOut ? { rollOut: enrichButtonEventAction(group.rollOut, labels) } : {}),
        ...(group.press ? { press: enrichButtonEventAction(group.press, labels) } : {}),
      },
    ];
  }));
}

function enrichButtonEventAction<T extends ControlAction>(action: T, labels: Record<string, number>): T {
  const frame = action.label ? labels[action.label] : undefined;
  return frame !== undefined && action.frame === undefined ? { ...action, frame } : action;
}

function enrichButtonExitNavigation<T extends ControlAction>(action: T, exitNavigation?: ExitNavigationIndex): T {
  if (!exitNavigation || action.exitNavigation) return action;
  const assignment = findExitVariableAssignment(action, exitNavigation.sectionTargets);
  if (!assignment) return action;

  for (const call of action.functionCalls ?? []) {
    const exitTarget = exitNavigation.functionTargets.get(call.functionName);
    if (!exitTarget) continue;
    const sectionTargets = exitNavigation.sectionTargets.get(sectionNavigationKey(assignment.variable, assignment.value)) ?? [];
    const sectionTarget = chooseSectionNavigationTarget(sectionTargets, exitTarget.exitFrame);
    if (!sectionTarget) continue;
    return {
      ...action,
      exitNavigation: compactExitNavigation({
        variable: assignment.variable,
        value: assignment.value,
        swf: sectionTarget.swf,
        exitLabel: exitTarget.exitLabel,
        exitFrame: exitTarget.exitFrame,
        level: sectionTarget.level,
      }),
    };
  }

  return action;
}

function inferExitNavigationIndex(control: TimelineControl, labels: Record<string, number>): ExitNavigationIndex | undefined {
  const movieTargetLevel = inferMovieTargetLevel(control);
  const sectionTargets = inferSectionNavigationTargets(control, movieTargetLevel);
  const functionTargets = inferExitFunctionTargets(control, labels);
  if (!sectionTargets.size || !functionTargets.size) return undefined;
  return { sectionTargets, functionTargets };
}

function inferSectionNavigationTargets(control: TimelineControl, fallbackLevel?: number): Map<string, SectionNavigationTarget[]> {
  const out = new Map<string, SectionNavigationTarget[]>();
  for (const record of control.frameActions ?? []) {
    for (const action of record.actions ?? []) {
      if (!action.swf || !/\.swf$/i.test(action.swf)) continue;
      if (action.command !== "doRelease" && action.command !== "loadMovie" && action.command !== "loadMovieNum" && !action.functionBranchCondition && !action.branchCondition) continue;
      const match = lastPositiveBranchEquality(action.branchCondition ?? action.functionBranchCondition);
      if (!match) continue;
      const target: SectionNavigationTarget = {
        swf: action.swf,
        frame: record.frame,
        ...(typeof action.level === "number" ? { level: action.level } : typeof fallbackLevel === "number" ? { level: fallbackLevel } : {}),
      };
      const key = sectionNavigationKey(match.variable, match.value);
      const list = out.get(key) ?? [];
      list.push(target);
      out.set(key, list);
    }
  }
  return out;
}

function inferExitFunctionTargets(control: TimelineControl, labels: Record<string, number>): Map<string, ExitFunctionTarget> {
  const labelsByFrame = labelsByFrameIndex(labels);
  const defaults = control.globalDefaults ?? {};
  const out = new Map<string, ExitFunctionTarget>();
  for (const definition of Object.values(control.definedFunctions ?? {})) {
    const def = asDefinedFunction(definition);
    if (!def?.functionName) continue;
    const candidates = (def.actions ?? []).filter((action) =>
      (action.command === "gotoAndPlay" || action.command === "gotoAndStop")
      && isSelfTimelineTarget(action.target)
      && typeof action.frame === "number"
      && hasExitEvidence(def.functionName, labelsByFrame.get(action.frame)),
    );
    const action = chooseGuardedAction(candidates, defaults);
    if (!action || typeof action.frame !== "number") continue;
    out.set(def.functionName, {
      exitFrame: action.frame,
      ...(labelForFrame(action.frame, labelsByFrame) ? { exitLabel: labelForFrame(action.frame, labelsByFrame) } : {}),
    });
  }
  return out;
}

function inferMovieTargetLevel(control: TimelineControl): number | undefined {
  for (const action of allControlActions(control)) {
    if (action.command !== "setVariable" || !action.target) continue;
    if (normalizeVarName(action.target) !== "intMovieTargLevel") continue;
    const value = typeof action.value === "number" ? action.value : Number(action.rawValue);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function* allControlActions(control: TimelineControl): Iterable<ControlAction> {
  for (const record of control.frameActions ?? []) yield* (record.actions ?? []);
  for (const record of control.spriteActions ?? []) yield* (record.actions ?? []);
  for (const definition of Object.values(control.definedFunctions ?? {})) {
    const def = asDefinedFunction(definition);
    if (def?.actions?.length) yield* def.actions;
  }
}

function findExitVariableAssignment(
  action: ControlAction,
  sectionTargets: Map<string, SectionNavigationTarget[]>,
): { variable: string; value: string } | undefined {
  for (const assignment of action.assignments ?? []) {
    const value = typeof assignment.value === "string" ? assignment.value : stringLiteral(assignment.rawValue);
    if (value === undefined || !assignment.target) continue;
    const variable = normalizeVarName(assignment.target);
    if (!variable.includes(".")) continue;
    if (!sectionTargets.has(sectionNavigationKey(variable, value))) continue;
    return { variable, value };
  }
  return undefined;
}

function chooseSectionNavigationTarget(targets: SectionNavigationTarget[], exitFrame: number): SectionNavigationTarget | undefined {
  if (!targets.length) return undefined;
  return targets.find((target) => target.frame > exitFrame) ?? targets[0];
}

function chooseGuardedAction(actions: ControlAction[], defaults: Record<string, unknown>): ControlAction | undefined {
  if (!actions.length) return undefined;
  if (Object.keys(defaults).length) {
    const store = new VariableStore();
    store.seed(defaults);
    const realMatch = actions.find((action) => {
      const condition = action.functionBranchCondition ?? action.branchCondition;
      return condition && condition !== "else" && evalCondition(condition, store);
    });
    if (realMatch) return realMatch;
    const elseMatch = actions.find((action) => (action.functionBranchCondition ?? action.branchCondition) === "else");
    if (elseMatch) return elseMatch;
  }
  return actions.find((action) => !action.functionBranchCondition && !action.branchCondition) ?? actions[0];
}

function lastPositiveBranchEquality(condition: string | undefined): { variable: string; value: string } | undefined {
  if (!condition) return undefined;
  let selected: { variable: string; value: string } | undefined;
  const re = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*==\s*(["'])(.*?)\2/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(condition))) {
    if (match[3] === "") continue;
    selected = { variable: normalizeVarName(match[1]), value: match[3] };
  }
  return selected;
}

function labelsByFrameIndex(labels: Record<string, number>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [label, frame] of Object.entries(labels)) {
    if (!Number.isFinite(frame)) continue;
    const list = out.get(frame) ?? [];
    list.push(label);
    out.set(frame, list);
  }
  return out;
}

function labelForFrame(frame: number, labelsByFrame: Map<number, string[]>): string | undefined {
  const labels = labelsByFrame.get(frame) ?? [];
  return labels.find((label) => /exit/i.test(label)) ?? labels[0];
}

function hasExitEvidence(functionName: string, labels: string[] | undefined): boolean {
  return /exit/i.test(functionName) || Boolean(labels?.some((label) => /exit/i.test(label)));
}

function compactExitNavigation(navigation: ExitNavigation): ExitNavigation {
  return Object.fromEntries(Object.entries(navigation).filter(([, value]) => value !== undefined)) as ExitNavigation;
}

function sectionNavigationKey(variable: string, value: string): string {
  return `${normalizeVarName(variable)}\0${value}`;
}

function asDefinedFunction(value: unknown): DefinedFunction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<DefinedFunction>;
  return typeof candidate.functionName === "string" ? candidate as DefinedFunction : undefined;
}

function stringLiteral(rawValue: string | undefined): string | undefined {
  if (!rawValue) return undefined;
  const value = rawValue.trim();
  if (!((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return undefined;
  return value.slice(1, -1);
}

function isSelfTimelineTarget(target: string | undefined): boolean {
  return !target || target === "self" || target === "this" || target === "_root" || target === "_level0" || target === "root";
}

export function inferButtonOwnerSpriteIds(
  assets: AssetMap,
  buttonIds: Iterable<string | number> = allButtonIds(assets),
): Record<string, number[]> {
  const wanted = new Set([...buttonIds].map(String));
  const owners = new Map<string, Set<number>>();
  const memo = new Map<number, Set<string>>();
  const visiting = new Set<number>();

  const getAsset = (characterId: number): TimelineAsset | undefined =>
    assets[String(characterId)] ?? assets[`button:${characterId}`];

  const buttonsInSprite = (asset: TimelineAsset): Set<string> => {
    if (asset.kind !== "sprite" || !asset.timeline?.length) return new Set();
    const cached = memo.get(asset.id);
    if (cached) return cached;
    if (visiting.has(asset.id)) return new Set();
    visiting.add(asset.id);
    const found = new Set<string>();
    for (const frame of asset.timeline) {
      for (const instance of frame.instances ?? []) {
        const child = getAsset(instance.characterId);
        if (!child) continue;
        if (child.kind === "button") {
          const id = String(child.id);
          if (!wanted.size || wanted.has(id)) found.add(id);
        } else if (child.kind === "sprite") {
          for (const id of buttonsInSprite(child)) found.add(id);
        }
      }
    }
    visiting.delete(asset.id);
    memo.set(asset.id, found);
    return found;
  };

  for (const asset of Object.values(assets)) {
    if (asset?.kind !== "sprite") continue;
    for (const buttonId of buttonsInSprite(asset)) {
      let list = owners.get(buttonId);
      if (!list) owners.set(buttonId, (list = new Set()));
      list.add(asset.id);
    }
  }

  return Object.fromEntries([...owners.entries()].map(([buttonId, ids]) => [
    buttonId,
    [...ids].sort((a, b) => a - b),
  ]));
}

export function inferNestedSectionTargets(
  buttonActions: Record<string, ButtonActionRecord>,
  labels: Record<string, number>,
): Record<string, NestedSectionTarget> {
  const byNormalizedLabel = new Map(Object.entries(labels).map(([label, frame]) => [normalizeName(label), { label, frame }]));
  const targets: Record<string, { label: string; frame: number }> = {};

  for (const group of Object.values(buttonActions)) {
    const target = group.release?.target;
    if (!target || isRootishTarget(target)) continue;
    const normalized = normalizeName(target);
    const direct = byNormalizedLabel.get(normalized);
    if (direct) {
      targets[target] = direct;
      continue;
    }
    if (normalized.startsWith("mc")) {
      const match = byNormalizedLabel.get(normalized.slice(2));
      if (match) targets[target] = match;
    }
  }

  return targets;
}

function allButtonIds(assets: AssetMap): string[] {
  return Object.values(assets)
    .filter((asset) => asset?.kind === "button")
    .map((asset) => String(asset.id));
}

function isRootishTarget(target: string): boolean {
  return target === "_root" || target === "_level0" || target === "root" || target === "self" || target === "this" || target === "_parent";
}

function normalizeName(name: string): string {
  return String(name).replace(/[^a-z0-9]/gi, "").toLowerCase();
}
