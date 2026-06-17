// Pure ActionScript action analysis: callable-function discovery + support marking,
// function-body assignment/call parsing, sound resolution, button-event grouping.

import { number, compactObject } from "./util.mjs";
import { stripActionScriptStrings, tellTargetAt, parseStatements, actionContextAt, parseActionScriptLiteral } from "./asParse.mjs";

export function resolveSound(library, requestedName) {
  if (!requestedName) return undefined;
  if (library[requestedName]) return library[requestedName];

  const normalized = requestedName.toLowerCase();
  return Object.values(library).find((sound) => sound.name.toLowerCase() === normalized);
}

export function groupButtonEvents(events) {
  const grouped = {};
  for (const event of events) {
    const group = grouped[event.characterId] ?? { characterId: event.characterId, events: [] };
    group.events = [...new Set([...group.events, ...event.events])];
    if (event.release) group.release = event.release;
    if (event.rollOver) group.rollOver = event.rollOver;
    if (event.rollOut) group.rollOut = event.rollOut;
    grouped[event.characterId] = group;
  }
  return grouped;
}

export function discoverCallableFunctionNames(groupedEvents, ...actionEntryGroups) {
  const names = new Set();
  for (const group of Object.values(groupedEvents)) {
    for (const eventName of ["release", "rollOver", "rollOut"]) {
      for (const call of group[eventName]?.functionCalls ?? []) {
        if (call.functionName) names.add(call.functionName);
      }
    }
  }
  for (const entries of actionEntryGroups) {
    for (const entry of entries ?? []) {
      for (const action of entry.actions ?? []) {
        for (const call of action.functionCalls ?? []) {
          if (call.functionName) names.add(call.functionName);
        }
      }
    }
  }
  return names;
}

export function markCallableFunctionActionsSupported(entries, callableNames) {
  if (!callableNames.size) return entries;

  return entries.map((entry) => ({
    ...entry,
    actions: (entry.actions ?? []).map((action) => {
      if (action.executionContext !== "function" || !callableNames.has(action.functionName)) return action;
      if (!runtimeCanExecuteCallableFunctionAction(action)) return action;

      const { reason, ...supportedAction } = action;
      return {
        ...supportedAction,
        supported: true,
        invokedByButtonFunction: true,
      };
    }),
  }));
}

export function runtimeCanExecuteCallableFunctionAction(action) {
  if ((action.command === "gotoAndPlay" || action.command === "gotoAndStop") && action.target === "self") {
    return typeof action.frame === "number" || typeof action.frameExpression === "string" || typeof action.label === "string";
  }
  if ((action.command === "gotoAndPlay" || action.command === "gotoAndStop") && action.target && !/^_level\d+/i.test(action.target)) {
    return typeof action.frame === "number" || typeof action.frameExpression === "string" || typeof action.label === "string";
  }

  if (action.command === "callFunctions") return Boolean(action.functionCalls?.length);
  if (action.command === "stopSound") return true;
  return (action.command === "playVO" || action.command === "attachSound") && Boolean(action.soundSrc);
}

export function discoverFunctionAssignments(body) {
  const source = stripActionScriptStrings(body);
  const assignments = [];
  for (const match of source.matchAll(/(?:^|[\s;{}])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*([^;\n]+)\s*;/g)) {
    const target = match[1];
    if (target === "var") continue;
    assignments.push(compactObject({
      target,
      value: parseActionScriptLiteral(match[2]),
      rawValue: match[2].trim(),
    }));
  }
  return assignments;
}

export function discoverFunctionBodyCalls(body) {
  const source = body;
  const calls = [];
  for (const match of source.matchAll(/([A-Za-z0-9_.$]+)\.([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?/g)) {
    calls.push({
      target: match[1],
      functionName: match[2],
      arguments: match[3].trim(),
    });
  }
  for (const match of source.matchAll(/(?:^|[\s;{}])([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?/g)) {
    if (["if", "while", "for", "switch", "return", "function", "trace", "int", "getTimer", "getSndTime"].includes(match[1])) continue;
    calls.push({
      target: "self",
      functionName: match[1],
      arguments: match[2].trim(),
    });
  }
  return calls;
}

export function discoverFunctionCallActions(source, functionContexts, branchContexts, tellTargets = []) {
  const calls = [];
  for (const match of source.matchAll(/([A-Za-z0-9_.$]+)\.([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?/g)) {
    const target = match[1];
    const functionName = match[2];
    if (target === "_level0" || target === "_root") continue;
    if (target.endsWith(".s1") || target.endsWith(".s2") || /^_root\.snd_/i.test(target)) continue;
    if (functionName.startsWith("gotoAnd") || ["attachSound", "doRelease", "loadMovie", "loadMovieNum", "loadVariables", "stop", "setVolume", "getVolume"].includes(functionName)) continue;

    calls.push({
      call: {
        target,
        functionName,
        arguments: match[3].trim(),
      },
      context: actionContextAt(functionContexts, branchContexts, match.index ?? 0),
    });
  }
  for (const match of source.matchAll(/(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?/g)) {
    const functionName = match[1];
    // `tellTarget(…)` is a scoping directive, not a real call — skip it.
    if (functionName === "tellTarget") continue;
    if (["if", "while", "for", "function", "switch", "trace", "stop", "play", "gotoAndPlay", "gotoAndStop", "loadVariables", "loadMovieNum", "getTimer", "int", "typeof", "unloadMovie", "unloadMovieNum"].includes(functionName)) continue;
    const before = source.slice(Math.max(0, (match.index ?? 0) - 12), match.index ?? 0);
    if (/\bfunction\s*$/i.test(before)) continue;

    // Inside a tellTarget("clip") block the call runs on that nested clip; otherwise _root.
    const clip = tellTargetAt(tellTargets, match.index ?? 0);
    calls.push({
      call: {
        target: clip ?? "_root",
        functionName,
        arguments: match[2].trim(),
      },
      context: actionContextAt(functionContexts, branchContexts, match.index ?? 0),
    });
  }
  return calls;
}

export function chooseExitNavigationTarget(targets, frameLabels) {
  if (!targets.length) return null;
  const proExitFrame = frameLabels["navAnim_Pro_Exit"];
  const proTarget = Number.isFinite(proExitFrame)
    ? targets.find((target) => target.frame > proExitFrame)
    : undefined;
  return proTarget ?? targets[0];
}

export /** Top-level `target = value;` assignments in a frame script, as setVariable actions. */
function frameVariableActions(body, sourcePath) {
  return parseStatements(body)
    .filter((statement) => statement.kind === "assign")
    .map((statement) => compactObject({
      command: "setVariable",
      target: statement.target,
      value: statement.value,
      rawValue: statement.rawValue,
      branchCondition: statement.branchCondition,
      executionContext: statement.branchCondition ? "branch" : "timeline",
      supported: true,
      source: sourcePath,
    }));
}
