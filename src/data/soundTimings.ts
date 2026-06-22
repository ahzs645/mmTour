import type { ButtonActionRecord, ControlAction, DefinedFunction } from "./timelineTypes";

export type SoundTiming = {
  durationMs: number;
};

export type SoundTimingTable = Record<string, SoundTiming>;

type SoundTimingControl = {
  frameActions?: Array<{ actions?: ControlAction[] }>;
  spriteActions?: Array<{ actions?: ControlAction[] }>;
  definedFunctions?: Record<string, unknown>;
  buttonActions?: Record<string, ButtonActionRecord>;
  soundTimings?: Record<string, SoundTiming | number>;
};

export function collectExplicitSoundTimings(control: SoundTimingControl | undefined): SoundTimingTable {
  const timings = new Map<string, SoundTiming>();
  for (const [name, timing] of Object.entries(control?.soundTimings ?? {})) {
    const durationMs = typeof timing === "number" ? timing : Number((timing as SoundTiming | undefined)?.durationMs);
    if (name && Number.isFinite(durationMs) && durationMs > 0) timings.set(name, { durationMs });
  }

  const scanAction = (action: ControlAction | undefined) => {
    for (const call of action?.functionCalls ?? []) {
      const timing = timingFromPushCall(call);
      if (timing) timings.set(timing.name, { durationMs: timing.durationMs });
    }
  };

  for (const record of control?.frameActions ?? []) for (const action of record.actions ?? []) scanAction(action);
  for (const record of control?.spriteActions ?? []) for (const action of record.actions ?? []) scanAction(action);
  for (const definition of Object.values(control?.definedFunctions ?? {}) as DefinedFunction[]) {
    for (const action of definition?.actions ?? []) scanAction(action);
  }
  for (const group of Object.values(control?.buttonActions ?? {}) as ButtonActionRecord[]) {
    scanAction(group.release);
    scanAction(group.rollOver);
    scanAction(group.rollOut);
    scanAction(group.press);
  }

  return Object.fromEntries([...timings.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })));
}

function timingFromPushCall(call: NonNullable<ControlAction["functionCalls"]>[number]): { name: string; durationMs: number } | undefined {
  if (call.functionName !== "push" || !isSoundTimingTarget(call.target)) return undefined;
  const args = splitArgs(call.arguments);
  const values = args.length === 1 && args[0]?.trim().startsWith("[") ? splitArrayLiteral(args[0]) : args;
  const name = stringLiteral(values[0]);
  const durationMs = Number(values[1]);
  if (!name || !Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  return { name, durationMs };
}

function isSoundTimingTarget(target: string | undefined): boolean {
  const normalized = String(target ?? "").replace(/[^a-z]/gi, "").toLowerCase();
  return Boolean(normalized && /(?:snd|sound).*(?:time|duration|lib)|(?:time|duration).*(?:snd|sound)/.test(normalized));
}

function splitArrayLiteral(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return splitArgs(trimmed.slice(1, -1));
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
