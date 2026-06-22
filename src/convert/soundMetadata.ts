import type { ButtonActionRecord, ControlAction, DefinedFunction, FunctionCall } from "../data/timelineTypes.ts";
import { collectExplicitSoundTimings, type SoundTimingTable } from "../data/soundTimings.ts";

type SoundEntry = {
  name?: string;
  src?: string;
  durationMs?: number;
  aliases?: string[];
};

type SoundLibrary = Record<string, SoundEntry | string>;
type SoundAction = NonNullable<ControlAction["soundAction"]>;
type SegmentTiming = { baseSound: string; soundSrc?: string; durationMs?: number };

export function enrichSoundMetadata(control: {
  frameActions?: Array<{ actions?: ControlAction[] }>;
  spriteActions?: Array<{ actions?: ControlAction[] }>;
  definedFunctions?: Record<string, DefinedFunction>;
  buttonActions?: Record<string, ButtonActionRecord>;
  soundTimings?: SoundTimingTable;
}, soundLibrary: SoundLibrary) {
  const explicitTimings = collectExplicitSoundTimings(control);
  if (Object.keys(explicitTimings).length) control.soundTimings = explicitTimings;
  const soundTargets = collectSoundTargets(control);
  const segmentTimings = collectSegmentTimings(control, soundLibrary, explicitTimings);
  for (const record of control.frameActions ?? []) enrichActions(record.actions, soundLibrary, soundTargets, segmentTimings);
  for (const record of control.spriteActions ?? []) enrichActions(record.actions, soundLibrary, soundTargets, segmentTimings);
  for (const definition of Object.values(control.definedFunctions ?? {})) enrichActions(definition.actions, soundLibrary, soundTargets, segmentTimings);
  for (const group of Object.values(control.buttonActions ?? {})) {
    enrichAction(group.release, soundLibrary, soundTargets, segmentTimings);
    enrichAction(group.rollOver, soundLibrary, soundTargets, segmentTimings);
    enrichAction(group.rollOut, soundLibrary, soundTargets, segmentTimings);
    enrichAction(group.press, soundLibrary, soundTargets, segmentTimings);
  }
}

function collectSoundTargets(control: {
  frameActions?: Array<{ actions?: ControlAction[] }>;
  spriteActions?: Array<{ actions?: ControlAction[] }>;
  definedFunctions?: Record<string, DefinedFunction>;
  buttonActions?: Record<string, ButtonActionRecord>;
}): Set<string> {
  const targets = new Set<string>();
  const scanAction = (action: ControlAction | undefined) => {
    if (action?.command === "setVariable" && action.target && /\bnew\s+Sound\s*\(/.test(action.rawValue ?? String(action.value ?? ""))) {
      targets.add(soundTargetKey(action.target));
    }
    for (const assign of action?.assignments ?? []) {
      if (assign.target && /\bnew\s+Sound\s*\(/.test(assign.rawValue ?? String(assign.value ?? ""))) targets.add(soundTargetKey(assign.target));
    }
  };
  const scanActions = (actions: ControlAction[] | undefined) => {
    for (const action of actions ?? []) scanAction(action);
  };

  for (const record of control.frameActions ?? []) scanActions(record.actions);
  for (const record of control.spriteActions ?? []) scanActions(record.actions);
  for (const definition of Object.values(control.definedFunctions ?? {})) {
    scanActions(definition.actions);
    for (const statement of definition.body ?? []) {
      if (statement.kind === "assign" && /\bnew\s+Sound\s*\(/.test(statement.rawValue)) targets.add(soundTargetKey(statement.target));
    }
  }
  for (const group of Object.values(control.buttonActions ?? {})) {
    scanAction(group.release);
    scanAction(group.rollOver);
    scanAction(group.rollOut);
    scanAction(group.press);
  }
  return targets;
}

function collectSegmentTimings(control: {
  frameActions?: Array<{ actions?: ControlAction[] }>;
  spriteActions?: Array<{ actions?: ControlAction[] }>;
  definedFunctions?: Record<string, DefinedFunction>;
  buttonActions?: Record<string, ButtonActionRecord>;
}, soundLibrary: SoundLibrary, explicitTimings: SoundTimingTable): Map<string, SegmentTiming> {
  const groups = new Map<string, Set<string>>();
  const add = (segment: string | undefined) => {
    const normalized = segment?.trim();
    if (!normalized) return;
    const base = segmentBase(normalized, soundLibrary);
    if (!base) return;
    let set = groups.get(base);
    if (!set) groups.set(base, (set = new Set()));
    set.add(normalized);
  };
  const scanCalls = (calls: FunctionCall[] | undefined) => {
    for (const call of calls ?? []) {
      const args = splitArgs(call.arguments);
      if (call.functionName === "markSnd" || call.functionName === "markSndSegment") add(stringLiteral(args[0]));
      if (call.functionName === "playVO") add(stringLiteral(args[2]));
    }
  };
  const scanAction = (action: ControlAction | undefined) => {
    if (!action) return;
    if (action.command === "markSndSegment") add(action.segment ?? action.sound);
    scanCalls(action.functionCalls);
  };
  const scanActions = (actions: ControlAction[] | undefined) => {
    for (const action of actions ?? []) scanAction(action);
  };

  for (const record of control.frameActions ?? []) scanActions(record.actions);
  for (const record of control.spriteActions ?? []) scanActions(record.actions);
  for (const definition of Object.values(control.definedFunctions ?? {})) scanActions(definition.actions);
  for (const group of Object.values(control.buttonActions ?? {})) {
    scanAction(group.release);
    scanAction(group.rollOver);
    scanAction(group.rollOut);
    scanAction(group.press);
  }

  const timings = new Map<string, SegmentTiming>();
  for (const [base, segments] of groups) {
    const resolved = resolveSound(soundLibrary, base);
    const fallbackDurationMs = resolved?.durationMs && segments.size > 0 ? resolved.durationMs / segments.size : undefined;
    for (const segment of segments) {
      const durationMs = explicitTimings[segment]?.durationMs ?? fallbackDurationMs;
      timings.set(segment, { baseSound: resolved?.name ?? base, soundSrc: resolved?.src, durationMs });
    }
  }
  return timings;
}

function enrichActions(actions: ControlAction[] | undefined, soundLibrary: SoundLibrary, soundTargets: Set<string>, segmentTimings: Map<string, SegmentTiming>) {
  for (const action of actions ?? []) enrichAction(action, soundLibrary, soundTargets, segmentTimings);
}

function enrichAction(action: ControlAction | undefined, soundLibrary: SoundLibrary, soundTargets: Set<string>, segmentTimings: Map<string, SegmentTiming>) {
  if (!action) return;
  if (action.command === "playVO" || action.command === "attachSound") {
    const resolved = resolveSound(soundLibrary, action.sound);
    if (resolved?.src && !action.soundSrc) action.soundSrc = resolved.src;
    const segmentDurationMs = action.command === "playVO" && action.segment ? segmentTimings.get(action.segment)?.durationMs : undefined;
    const durationMs = segmentDurationMs ?? resolved?.durationMs;
    if (durationMs !== undefined && action.soundDurationMs === undefined) action.soundDurationMs = durationMs;
  }
  if (action.command === "markSndSegment") enrichSegmentAction(action, segmentTimings);
  if (!action.soundAction && action.command === "stop" && isSoundTarget(action.target, soundTargets)) {
    action.soundAction = { command: "stopSound", target: action.target, soundRole: "vo" };
  }
  if (action.command !== "callFunctions" || action.soundAction) return;
  const soundAction = firstSoundAction(action.functionCalls, soundLibrary, soundTargets, segmentTimings);
  if (soundAction) action.soundAction = soundAction;
}

function enrichSegmentAction(action: ControlAction, segmentTimings: Map<string, SegmentTiming>) {
  const segment = action.segment ?? action.sound;
  const timing = segment ? segmentTimings.get(segment) : undefined;
  if (!action.segment && segment) action.segment = segment;
  if (timing?.soundSrc && !action.soundSrc) action.soundSrc = timing.soundSrc;
  if (timing?.durationMs !== undefined && action.soundDurationMs === undefined) action.soundDurationMs = timing.durationMs;
}

function firstSoundAction(calls: FunctionCall[] | undefined, soundLibrary: SoundLibrary, soundTargets: Set<string>, segmentTimings: Map<string, SegmentTiming>): SoundAction | undefined {
  for (const call of calls ?? []) {
    const args = splitArgs(call.arguments);
    if (call.functionName === "stop" && isSoundTarget(call.target, soundTargets)) {
      return {
        command: "stopSound",
        target: call.target,
        soundRole: "vo",
      };
    }
    if (call.functionName === "playVO") {
      const sound = stringLiteral(args[0]);
      const segment = stringLiteral(args[2]);
      const resolved = resolveSound(soundLibrary, sound);
      const timing = segment ? segmentTimings.get(segment) : undefined;
      return {
        command: "playVO",
        target: call.target,
        sound,
        ramp: args[1]?.trim(),
        segment,
        soundRole: "vo",
        soundSrc: resolved?.src ?? timing?.soundSrc,
        soundDurationMs: timing?.durationMs ?? resolved?.durationMs,
        resolvedSound: resolved?.name && resolved.name !== sound ? resolved.name : undefined,
      };
    }
    if (call.functionName === "markSnd" || call.functionName === "markSndSegment") {
      const sound = stringLiteral(args[0]) ?? args[0]?.trim();
      const timing = sound ? segmentTimings.get(sound) : undefined;
      return {
        command: "markSndSegment",
        target: call.target,
        sound,
        segment: sound,
        arguments: call.arguments,
        soundRole: "vo",
        soundSrc: timing?.soundSrc,
        soundDurationMs: timing?.durationMs,
        resolvedSound: timing?.baseSound && timing.baseSound !== sound ? timing.baseSound : undefined,
      };
    }
    if (call.functionName === "attachSound") {
      const sound = stringLiteral(args[0]);
      const resolved = resolveSound(soundLibrary, sound);
      return {
        command: "attachSound",
        target: call.target,
        sound,
        soundRole: "music",
        soundSrc: resolved?.src,
        soundDurationMs: resolved?.durationMs,
        resolvedSound: resolved?.name && resolved.name !== sound ? resolved.name : undefined,
      };
    }
  }
  return undefined;
}

function segmentBase(segment: string, soundLibrary: SoundLibrary): string | undefined {
  const match = segment.match(/^(.+\d)([a-z]+)$/i);
  if (!match) return undefined;
  const resolved = resolveSound(soundLibrary, match[1]);
  return resolved?.name ?? match[1];
}

function isSoundTarget(target: string | undefined, soundTargets: Set<string>): boolean {
  return Boolean(target && soundTargets.has(soundTargetKey(target)));
}

function soundTargetKey(target: string): string {
  return target
    .replace(/^_root\./i, "")
    .replace(/^_level0\./i, "")
    .replace(/^this\./i, "")
    .replace(/^self\./i, "");
}

function resolveSound(soundLibrary: SoundLibrary, sound: string | undefined): SoundEntry | undefined {
  if (!sound) return undefined;
  const direct = soundLibrary[sound] ?? soundLibrary[sound.toLowerCase()];
  if (direct) return typeof direct === "string" ? { name: sound, src: direct } : { name: direct.name ?? sound, ...direct };
  const wanted = sound.toLowerCase();
  for (const [name, entry] of Object.entries(soundLibrary)) {
    if (typeof entry === "string") continue;
    if (name.toLowerCase() === wanted || entry.name?.toLowerCase() === wanted || entry.aliases?.some((alias) => alias.toLowerCase() === wanted)) {
      return { name: entry.name ?? name, ...entry };
    }
  }
  return undefined;
}

function splitArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  let quote = "";
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (quote) {
      if (c === quote && raw[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(raw.slice(start).trim());
  return out;
}

function stringLiteral(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}
