// In-browser AVM1 control extraction from bytecode (no FFDec .as). The player's
// rich control (frameActions/definedFunctions/nav) is FFDec-.as-derived, but the
// load-bearing pieces for faithful playback are the STOP frames — the player's
// isStopFrame() reads control.stopFrames / spriteStopFrames directly. We
// disassemble each frame's DoAction and record where the root and each sprite
// stop, plus basic goto targets. Deeper scripted navigation is best-effort.

import { swf } from "swf-parser";
// @ts-ignore — pure-JS AVM1 disassembler reused from the Node pipeline
import { disassembleAvm1 } from "../../scripts/lib/avm1Disasm.mjs";
import type { ButtonActionRecord, ControlAction, DefinedFunction, FrameActionRecord } from "../data/timelineTypes.ts";
import { parseProgram } from "./avm1/parse.ts";
import { combineButtonActions, summarizeProgram } from "./avm1/summarize.ts";

export interface ExtractedControl {
  stopFrames: number[];
  spriteStopFrames: Record<string, number[]>;
  /** Root frame → goto target (0-based frame or label), for simple gotoAndStop/Play. */
  frameGotos: { frame: number; target: number | string; play: boolean }[];
  frameActions: FrameActionRecord[];
  spriteActions: Array<{ spriteId: number; frame: number; actions: ControlAction[] }>;
  definedFunctions: Record<string, DefinedFunction>;
  buttonActions: Record<string, ButtonActionRecord>;
}

/** Walk a frame-ordered tag list, returning the 0-based frame index of every
 *  frame whose DoAction stops, plus simple goto targets. */
function scanFrames(
  tags: any[],
  scope: "root" | "sprite",
  spriteId?: number,
): {
  stops: number[];
  gotos: { frame: number; target: number | string; play: boolean }[];
  frameActions: Array<{ frame: number; actions: ControlAction[] }>;
  definedFunctions: DefinedFunction[];
} {
  const stops: number[] = [];
  const gotos: { frame: number; target: number | string; play: boolean }[] = [];
  const frameActions: Array<{ frame: number; actions: ControlAction[] }> = [];
  const definedFunctions: DefinedFunction[] = [];
  let frame = 0;
  for (const tag of tags) {
    if (tag.type === swf.TagType.DoAction) {
      const summary = summarizeProgram(safeParse(tag.actions), { scope, spriteId });
      definedFunctions.push(...summary.definedFunctions);
      const actions = summary.actions.map((action) => ({ ...action }));
      if (actions.length) frameActions.push({ frame, actions });
      if (actions.some((action) => action.command === "stop")) stops.push(frame);
      for (const action of actions) {
        if (action.command !== "gotoAndPlay" && action.command !== "gotoAndStop") continue;
        gotos.push({
          frame,
          target: action.label ?? action.frame ?? action.frameExpression ?? "",
          play: action.command === "gotoAndPlay",
        });
      }
    } else if (tag.type === swf.TagType.ShowFrame) {
      frame += 1;
    }
  }
  return { stops, gotos, frameActions, definedFunctions };
}

function safeDisassemble(actions: Uint8Array): any[] {
  try {
    return disassembleAvm1(actions);
  } catch {
    return [];
  }
}

function safeParse(actions: Uint8Array): ReturnType<typeof parseProgram> {
  try {
    return parseProgram(actions);
  } catch {
    return [];
  }
}

export interface SwfDependency {
  swf: string; // e.g. "intro.swf"
  level?: number; // target _levelN, if a level load
}

/** Find the other SWFs this movie loads (loadMovie/loadMovieNum → GetUrl with a
 *  .swf target). A shell like A-tour pulls intro/nav/segments into stacked
 *  levels — those must be compiled + registered too for cross-loads to resolve. */
export function detectDependencies(movie: any): SwfDependency[] {
  const seen = new Map<string, SwfDependency>();
  const visit = (tags: any[]) => {
    for (const t of tags) {
      if (t.type === swf.TagType.DoAction) {
        for (const op of safeDisassemble(t.actions)) {
          if (op.op === "GetUrl" && typeof op.url === "string" && /\.swf$/i.test(op.url)) {
            const m = /^_level(\d+)$/.exec(op.target ?? "");
            const key = op.url.toLowerCase();
            if (!seen.has(key)) seen.set(key, { swf: op.url, level: m ? Number(m[1]) : undefined });
          }
          // string constants ending in .swf (loadMovie via method call)
          if (op.op === "ConstantPool") for (const v of op.values ?? []) if (typeof v === "string" && /\.swf$/i.test(v) && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), { swf: v });
        }
      } else if (t.type === swf.TagType.DefineSprite) {
        visit(t.tags);
      }
    }
  };
  visit(movie.tags);
  return [...seen.values()];
}

export function extractControl(movie: any): ExtractedControl {
  const root = scanFrames(movie.tags, "root");
  const spriteStopFrames: Record<string, number[]> = {};
  const spriteActions: Array<{ spriteId: number; frame: number; actions: ControlAction[] }> = [];
  const definedFunctions: DefinedFunction[] = [...root.definedFunctions];
  for (const tag of movie.tags) {
    if (tag.type === swf.TagType.DefineSprite) {
      const { stops, frameActions, definedFunctions: defs } = scanFrames(tag.tags, "sprite", tag.id);
      if (stops.length) spriteStopFrames[String(tag.id)] = [...new Set(stops)].sort((a, b) => a - b);
      for (const entry of frameActions) spriteActions.push({ spriteId: tag.id, ...entry });
      definedFunctions.push(...defs);
    }
  }
  return {
    stopFrames: [...new Set(root.stops)].sort((a, b) => a - b),
    spriteStopFrames,
    frameGotos: root.gotos,
    frameActions: root.frameActions,
    spriteActions,
    definedFunctions: indexDefinedFunctions(definedFunctions),
    buttonActions: extractButtonActions(movie),
  };
}

function indexDefinedFunctions(defs: DefinedFunction[]): Record<string, DefinedFunction> {
  const out: Record<string, DefinedFunction> = {};
  for (const def of defs) {
    const baseKey = `${def.scope ?? "root"}:${def.spriteId ?? "root"}:${def.functionName}`;
    let key = baseKey;
    for (let duplicate = 2; out[key]; duplicate += 1) key = `${baseKey}#${duplicate}`;
    out[key] = def;
  }
  return out;
}

function extractButtonActions(movie: any): Record<string, ButtonActionRecord> {
  const out: Record<string, ButtonActionRecord> = {};
  const visit = (tags: any[]) => {
    for (const tag of tags) {
      if (tag.type === swf.TagType.DefineSprite) {
        visit(tag.tags ?? []);
        continue;
      }
      if (tag.type !== swf.TagType.DefineButton) continue;
      const record: ButtonActionRecord = {};
      for (const action of tag.actions ?? []) {
        const events = buttonEventsFromConditions(action.conditions ?? {});
        const summary = summarizeProgram(safeParse(action.actions), { scope: "root" });
        const combined = combineButtonActions(summary.actions);
        if (!combined) continue;
        for (const event of events) {
          if (event === "release") record.release = mergeButtonAction(record.release, combined);
          else if (event === "press") record.press = mergeButtonAction(record.press, combined);
          else if (event === "rollOver") record.rollOver = mergeButtonAction(record.rollOver, combined);
          else if (event === "rollOut") record.rollOut = mergeButtonAction(record.rollOut, combined);
        }
      }
      if (Object.keys(record).length) out[String(tag.id)] = record;
    }
  };
  visit(movie.tags);
  return out;
}

function mergeButtonAction(existing: ControlAction | undefined, next: ControlAction): ControlAction {
  if (!existing) return { ...next };
  return {
    ...existing,
    assignments: [...(existing.assignments ?? []), ...(next.assignments ?? [])],
    functionCalls: [...(existing.functionCalls ?? []), ...(next.functionCalls ?? [])],
    loads: [...(existing.loads ?? []), ...(next.loads ?? [])],
  };
}

export function buttonEventsFromConditions(conditions: Record<string, unknown>): string[] {
  const events: string[] = [];
  if (conditions.overDownToOverUp) events.push("release");
  if (conditions.idleToOverDown || conditions.overUpToOverDown) events.push("press");
  if (conditions.idleToOverUp || conditions.outDownToOverDown) events.push("rollOver");
  if (conditions.overUpToIdle || conditions.overDownToOutDown || conditions.outDownToIdle || conditions.overDownToIdle) events.push("rollOut");
  if (conditions.keyPress) events.push(`keyPress:${conditions.keyPress}`);
  return events.filter((event) => event === "release" || event === "press" || event === "rollOver" || event === "rollOut");
}
