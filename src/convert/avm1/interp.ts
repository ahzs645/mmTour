// A small AVM1 interpreter that executes the deterministic init path of a SWF
// (frame-1 DoAction: function defs + the startup calls) and RECORDS its side
// effects — variable assignments (→ globalDefaults) and loadMovie/loadMovieNum
// (→ level loads). It is not a full player VM; it runs until the first
// non-deterministic point (user input, time/sound waits) or a step budget, which
// is enough to discover what a shell like A-tour brings on stage at startup.
//
// Opcode semantics validated against FFDec (jpexs-decompiler action/swf*).

import type { Avm1Action } from "./parse.ts";

export interface RecordedLoad {
  swf: string;
  level?: number;
  target?: string;
}

export interface InterpResult {
  globals: Record<string, any>; // dotted name → value (e.g. "bkgd.OSVersion")
  loads: RecordedLoad[];
}

interface Avm1Fn {
  __avm1fn: true;
  params: { register?: number; name: string }[];
  body: Avm1Action[];
  registerCount?: number;
}

const UNDEF = undefined;

export function runInit(program: Avm1Action[], opts: { osVersion?: string; budget?: number } = {}): InterpResult {
  const root: Record<string, any> = {};
  const loads: RecordedLoad[] = [];
  // Seed a couple of globals the tour gates on; OSVersion defaults to Pro.
  setPath(root, "bkgd", {});
  if (opts.osVersion) setPath(root, "bkgd.OSVersion", opts.osVersion);

  const vm = new Vm(root, loads, opts.budget ?? 200_000);
  try {
    vm.exec(program, { thisObj: root, registers: [], locals: root });
  } catch { /* stop at first failure — we keep whatever was recorded */ }

  return { globals: flatten(root), loads };
}

class Vm {
  private steps = 0;
  private root: Record<string, any>;
  private loads: RecordedLoad[];
  private budget: number;
  constructor(root: Record<string, any>, loads: RecordedLoad[], budget: number) {
    this.root = root;
    this.loads = loads;
    this.budget = budget;
  }

  exec(actions: Avm1Action[], frame: { thisObj: any; registers: any[]; locals: any }): any {
    const stack: any[] = [];
    let ip = 0;
    while (ip < actions.length) {
      if (++this.steps > this.budget) throw new Error("budget");
      const a = actions[ip];
      switch (a.op) {
        case "ConstantPool": break;
        case "End": return UNDEF;
        case "Push": for (const v of a.values ?? []) stack.push(v.type === "register" ? frame.registers[v.value] : v.value); break;
        case "Pop": stack.pop(); break;
        case "PushDuplicate": stack.push(stack[stack.length - 1]); break;
        case "StoreRegister": frame.registers[a.register!] = stack[stack.length - 1]; break;
        case "GetVariable": { const name = String(stack.pop()); stack.push(this.getVar(frame, name)); break; }
        case "SetVariable": { const val = stack.pop(); const name = String(stack.pop()); this.setVar(frame, name, val); break; }
        case "GetMember": { const key = String(stack.pop()); const obj = stack.pop(); stack.push(obj != null ? obj[key] : UNDEF); break; }
        case "SetMember": { const val = stack.pop(); const key = String(stack.pop()); const obj = stack.pop(); if (obj && typeof obj === "object") obj[key] = val; break; }
        case "DefineLocal": { const val = stack.pop(); const name = String(stack.pop()); frame.locals[name] = val; break; }
        case "DefineLocal2": { const name = String(stack.pop()); if (!(name in frame.locals)) frame.locals[name] = UNDEF; break; }
        case "InitArray": { const n = Number(stack.pop()) | 0; const arr: any[] = []; for (let i = 0; i < n; i++) arr.unshift(stack.pop()); stack.push(arr); break; }
        case "InitObject": { const n = Number(stack.pop()) | 0; const o: any = {}; for (let i = 0; i < n; i++) { const v = stack.pop(); const k = String(stack.pop()); o[k] = v; } stack.push(o); break; }
        case "NewObject": { const name = String(stack.pop()); const n = Number(stack.pop()) | 0; for (let i = 0; i < n; i++) stack.pop(); stack.push({ __class: name }); break; }
        case "NewMethod": { const name = String(stack.pop()); stack.pop(); const n = Number(stack.pop()) | 0; for (let i = 0; i < n; i++) stack.pop(); stack.push({ __class: name }); break; }
        case "Not": stack.push(!truthy(stack.pop())); break;
        case "And": { const b = stack.pop(); const aa = stack.pop(); stack.push(truthy(aa) && truthy(b)); break; }
        case "Or": { const b = stack.pop(); const aa = stack.pop(); stack.push(truthy(aa) || truthy(b)); break; }
        case "Equals": case "Equals2": { const b = stack.pop(); const aa = stack.pop(); stack.push(aa == b); break; }
        case "Less": case "Less2": { const b = stack.pop(); const aa = stack.pop(); stack.push(aa < b); break; }
        case "Greater": { const b = stack.pop(); const aa = stack.pop(); stack.push(aa > b); break; }
        case "StringEquals": { const b = stack.pop(); const aa = stack.pop(); stack.push(String(aa) === String(b)); break; }
        case "Add2": { const b = stack.pop(); const aa = stack.pop(); stack.push(typeof aa === "string" || typeof b === "string" ? String(aa) + String(b) : Number(aa) + Number(b)); break; }
        case "StringAdd": { const b = stack.pop(); const aa = stack.pop(); stack.push(String(aa) + String(b)); break; }
        case "Subtract": { const b = stack.pop(); const aa = stack.pop(); stack.push(Number(aa) - Number(b)); break; }
        case "Multiply": { const b = stack.pop(); const aa = stack.pop(); stack.push(Number(aa) * Number(b)); break; }
        case "Divide": { const b = stack.pop(); const aa = stack.pop(); stack.push(Number(aa) / Number(b)); break; }
        case "Increment": stack.push(Number(stack.pop()) + 1); break;
        case "Decrement": stack.push(Number(stack.pop()) - 1); break;
        case "ToInteger": stack.push(Number(stack.pop()) | 0); break;
        case "TypeOf": stack.push(typeofAvm(stack.pop())); break;
        case "Trace": stack.pop(); break;
        case "GetProperty": { stack.pop(); stack.pop(); stack.push(UNDEF); break; }
        case "SetProperty": stack.pop(); stack.pop(); stack.pop(); break;
        case "DefineFunction": case "DefineFunction2": {
          const fn: Avm1Fn = { __avm1fn: true, params: a.params ?? [], body: a.body ?? [], registerCount: a.registerCount };
          if (a.name) this.setVar(frame, a.name, fn); else stack.push(fn);
          break;
        }
        case "CallFunction": { const name = String(stack.pop()); const fn = this.getVar(frame, name); stack.push(this.call(fn, popArgs(stack), frame.thisObj, name)); break; }
        case "CallMethod": {
          const name = stack.pop(); const obj = stack.pop(); const args = popArgs(stack);
          const key = name === UNDEF || name === null || name === "" ? undefined : String(name);
          stack.push(this.callMethod(obj, key, args)); break;
        }
        case "Return": return stack.pop();
        case "Jump": ip = a.jumpTo ?? ip + 1; continue;
        case "If": { const cond = truthy(stack.pop()); if (cond) { ip = a.jumpTo ?? ip + 1; continue; } break; }
        case "GetUrl": if (a.url && /\.swf$/i.test(a.url)) this.recordLoad(a.url, a.target); break;
        case "GetUrl2": { const target = stack.pop(); const url = stack.pop(); if (typeof url === "string" && /\.swf$/i.test(url)) this.recordLoad(url, String(target)); break; }
        case "Stop": case "Play": case "GotoFrame": case "GotoFrame2": case "GotoLabel": break; // stage ops: ignore during init scan
        default: /* unknown op — best effort: leave stack as-is */ break;
      }
      ip++;
    }
    return UNDEF;
  }

  private call(fn: any, args: any[], thisObj: any, name?: string): any {
    if (fn && fn.__avm1fn) {
      const registers: any[] = new Array(fn.registerCount ?? 0);
      const locals: any = Object.create(this.root); // simple scope: locals fall through to root
      fn.params.forEach((p: any, i: number) => { if (p.register) registers[p.register] = args[i]; else locals[p.name] = args[i]; });
      return this.exec(fn.body, { thisObj, registers, locals });
    }
    // builtin by name
    return this.builtin(name, thisObj, args);
  }

  private callMethod(obj: any, key: string | undefined, args: any[]): any {
    if (obj && key && obj[key] && obj[key].__avm1fn) return this.call(obj[key], args, obj);
    return this.builtin(key, obj, args);
  }

  private builtin(name: string | undefined, thisObj: any, args: any[]): any {
    if (!name) return UNDEF;
    if (name === "loadMovieNum" || name === "loadMovie") {
      const url = args[0]; const lvlOrTarget = args[1];
      if (typeof url === "string" && /\.swf$/i.test(url)) this.recordLoad(url, lvlOrTarget);
    }
    return UNDEF;
  }

  private recordLoad(url: string, target: any) {
    const t = typeof target === "string" ? target : target != null ? `_level${target}` : "";
    const m = /_level(\d+)/.exec(t);
    const level = m ? Number(m[1]) : typeof target === "number" ? target : undefined;
    // last write per level wins (mirrors real level loading)
    const existing = this.loads.find((l) => l.level === level && level !== undefined);
    if (existing) existing.swf = url.replace(/^.*\//, "");
    else this.loads.push({ swf: url.replace(/^.*\//, ""), level, target: t || undefined });
  }

  private getVar(frame: any, name: string): any {
    if (name === "this") return frame.thisObj;
    if (name === "_root" || name === "_level0") return this.root;
    if (/^_level\d+$/.test(name)) return (this.root[name] ??= {});
    if (name in frame.locals) return frame.locals[name];
    return resolvePath(this.root, name);
  }
  private setVar(frame: any, name: string, val: any) {
    if (name in frame.locals && frame.locals !== this.root) { frame.locals[name] = val; return; }
    setPath(this.root, name, val);
  }
}

// --- helpers ---
function popArgs(stack: any[]): any[] {
  const n = Number(stack.pop()) | 0;
  const args: any[] = [];
  for (let i = 0; i < n; i++) args.push(stack.pop());
  return args;
}
function truthy(v: any): boolean { return !(v === undefined || v === null || v === false || v === 0 || v === "" || (typeof v === "number" && isNaN(v))); }
function typeofAvm(v: any): string { return v === undefined ? "undefined" : v === null ? "null" : typeof v === "function" || v?.__avm1fn ? "function" : Array.isArray(v) ? "object" : typeof v; }

function setPath(root: any, dotted: string, val: any) {
  const parts = dotted.replace(/^_level0\.|^_root\./, "").split(".");
  let o = root;
  for (let i = 0; i < parts.length - 1; i++) o = (o[parts[i]] ??= {});
  o[parts[parts.length - 1]] = val;
}
function resolvePath(root: any, dotted: string): any {
  const parts = dotted.replace(/^_level0\.|^_root\./, "").split(".");
  let o = root;
  for (const p of parts) { if (o == null) return undefined; o = o[p]; }
  return o;
}
function flatten(root: any, prefix = "", out: Record<string, any> = {}): Record<string, any> {
  for (const [k, v] of Object.entries(root)) {
    if (k.startsWith("__") || (v as any)?.__avm1fn) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
