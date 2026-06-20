// In-browser AVM1 control extraction from bytecode (no FFDec .as). The player's
// rich control (frameActions/definedFunctions/nav) is FFDec-.as-derived, but the
// load-bearing pieces for faithful playback are the STOP frames — the player's
// isStopFrame() reads control.stopFrames / spriteStopFrames directly. We
// disassemble each frame's DoAction and record where the root and each sprite
// stop, plus basic goto targets. Deeper scripted navigation is best-effort.

import { swf } from "swf-parser";
// @ts-ignore — pure-JS AVM1 disassembler reused from the Node pipeline
import { disassembleAvm1 } from "../../scripts/lib/avm1Disasm.mjs";

export interface ExtractedControl {
  stopFrames: number[];
  spriteStopFrames: Record<string, number[]>;
  /** Root frame → goto target (0-based frame or label), for simple gotoAndStop/Play. */
  frameGotos: { frame: number; target: number | string; play: boolean }[];
}

/** Walk a frame-ordered tag list, returning the 0-based frame index of every
 *  frame whose DoAction stops, plus simple goto targets. */
function scanFrames(tags: any[]): { stops: number[]; gotos: { frame: number; target: number | string; play: boolean }[] } {
  const stops: number[] = [];
  const gotos: { frame: number; target: number | string; play: boolean }[] = [];
  let frame = 0;
  for (const tag of tags) {
    if (tag.type === swf.TagType.DoAction) {
      const ops = safeDisassemble(tag.actions);
      let lastPush: any;
      for (const op of ops) {
        if (op.op === "Stop") stops.push(frame);
        else if (op.op === "Push") lastPush = op.values?.[op.values.length - 1];
        else if (op.op === "GotoFrame") gotos.push({ frame, target: op.frame, play: false });
        else if (op.op === "GoToLabel") gotos.push({ frame, target: op.label, play: false });
        else if (op.op === "GotoFrame2") {
          const t = lastPush?.value;
          if (t !== undefined) gotos.push({ frame, target: typeof t === "number" ? t : String(t), play: !!op.play });
        }
      }
    } else if (tag.type === swf.TagType.ShowFrame) {
      frame += 1;
    }
  }
  return { stops, gotos };
}

function safeDisassemble(actions: Uint8Array): any[] {
  try {
    return disassembleAvm1(actions);
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
  const root = scanFrames(movie.tags);
  const spriteStopFrames: Record<string, number[]> = {};
  for (const tag of movie.tags) {
    if (tag.type === swf.TagType.DefineSprite) {
      const { stops } = scanFrames(tag.tags);
      if (stops.length) spriteStopFrames[String(tag.id)] = [...new Set(stops)].sort((a, b) => a - b);
    }
  }
  return {
    stopFrames: [...new Set(root.stops)].sort((a, b) => a - b),
    spriteStopFrames,
    frameGotos: root.gotos,
  };
}
