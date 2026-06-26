// A runtime AVM1 bytecode interpreter for data-driven AS2 apps (e.g. an XML-fed
// site that builds its UI in class methods). Unlike the build-time scanner in
// `convert/avm1/interp.ts`, this VM is host-pluggable: all object/clip/property
// access goes through an `Avm1Host`, so the same core drives plain objects (data
// model extraction) or a live ClipInstance display list (rendering).
//
// Opcode semantics validated against FFDec (jpexs-decompiler). Pure — no DOM.

import type { Avm1Op } from "../data/avm1Bytecode.ts";

export type Avm1Value = any;

export interface Avm1Fn {
  __avm1fn: true;
  params: { register?: number; name: string }[];
  body: Avm1Op[];
  registerCount?: number;
  flags?: number;
  debugName?: string;
  /** `this` captured at definition for methods stored on an object (AS2 binds late,
   *  but most class methods are invoked as `obj.method()` so `this` comes from the call). */
  homeScope?: Avm1Value;
}

/**
 * Everything the VM can't decide on its own — resolving free variables, member
 * get/set, method calls, `new`, and builtins — is delegated to the host so the
 * same core works for headless data extraction and live rendering.
 */
export interface Avm1Host {
  /** Resolve a free variable / path (e.g. "com", "_root", a global class). */
  getVar(name: string): Avm1Value;
  /** Assign a free variable / path. */
  setVar(name: string, value: Avm1Value): void;
  /** Read a member of an object (host may special-case clips, XML nodes, arrays). */
  getMember(obj: Avm1Value, key: string): Avm1Value;
  /** Write a member (host may special-case clip properties, text fields, setters). */
  setMember(obj: Avm1Value, key: string, value: Avm1Value): void;
  deleteMember?(obj: Avm1Value, key: string): boolean;
  deleteVar?(name: string): boolean;
  enumerate?(obj: Avm1Value): string[];
  /** `new className(args)` — construct by name (host owns the class registry / builtins). */
  construct(className: string, args: Avm1Value[]): Avm1Value;
  /** `new ctor(args)` where the constructor is already a resolved function value
   *  (AS2 `new a.b.C()` compiles to NewMethod). Host links the prototype + runs it. */
  instantiate(ctor: Avm1Value, args: Avm1Value[]): Avm1Value;
  /** Call a free function by name (parseInt, Array, user globals…). */
  callNamed(name: string, args: Avm1Value[], thisObj: Avm1Value): Avm1Value;
  /** Call `obj[key](args)` for host-native methods (push, XPath, attachMovie…). */
  callMethod(obj: Avm1Value, key: string | undefined, args: Avm1Value[]): Avm1Value;
  /** AVM1 GetProperty/SetProperty (numbered props: _x, _alpha, _width…). Optional. */
  getProperty?(obj: Avm1Value, index: number): Avm1Value;
  setProperty?(obj: Avm1Value, index: number, value: Avm1Value): void;
}

const UNDEF = undefined;

export class Avm1Vm {
  private steps = 0;
  private host: Avm1Host;
  private budget: number;
  constructor(host: Avm1Host, budget = 5_000_000) {
    this.host = host;
    this.budget = budget;
  }

  /** Invoke an AVM1 function value with `thisObj` bound and `args` passed. */
  callFunction(fn: Avm1Fn, args: Avm1Value[], thisObj: Avm1Value): Avm1Value {
    const registers: Avm1Value[] = new Array(fn.registerCount ?? 0);
    const locals: Record<string, Avm1Value> = Object.create(null);
    // AS2 DefineFunction2 preload flags: this/args/super/root/parent/global go
    // into sequential registers starting at 1, in that order, for each preloaded.
    const flags = fn.flags ?? 0;
    let reg = 1;
    if (flags & 0x01) registers[reg++] = thisObj;                  // preloadThis
    if (flags & 0x04) registers[reg++] = args;                     // preloadArguments
    if (flags & 0x10) registers[reg++] = this.host.getVar("super");// preloadSuper
    if (flags & 0x40) registers[reg++] = this.host.getVar("_root");// preloadRoot
    if (flags & 0x80) registers[reg++] = thisObj?.__parent ?? this.host.getVar("_parent"); // preloadParent
    if (flags & 0x100) registers[reg++] = this.host.getVar("_global"); // preloadGlobal
    for (let i = 0; i < fn.params.length; i++) {
      const p = fn.params[i];
      if (p.register) registers[p.register] = args[i];
      else locals[p.name] = args[i];
    }
    // Expose the AS2 `arguments` object (array + `.callee`) for closures that
    // forward calls (e.g. mx.utils.Delegate's `func.apply(target, arguments)`).
    if (!("arguments" in locals)) { try { (args as any).callee = fn; } catch { /* frozen */ } locals.arguments = args; }
    return this.exec(fn.body, { thisObj, registers, locals, label: debugFunctionName(fn) });
  }

  private exec(actions: Avm1Op[], frame: Frame): Avm1Value {
    const stack: Avm1Value[] = [];
    const branchHits = new Map<string, number>();
    let ip = 0;
    while (ip < actions.length) {
      if (++this.steps > this.budget) throw new Error(this.branchError("avm1 budget exceeded", frame, ip, undefined, stack));
      const a = actions[ip];
      switch (a.op) {
        case "ConstantPool": break;
        case "End": return UNDEF;
        case "Push": for (const v of a.values ?? []) stack.push(v.type === "register" ? frame.registers[v.value] : v.value); break;
        case "Pop": stack.pop(); break;
        case "PushDuplicate": stack.push(stack[stack.length - 1]); break;
        case "StackSwap": { const r = stack.pop(); const l = stack.pop(); stack.push(r, l); break; }
        case "StoreRegister": frame.registers[a.register!] = stack[stack.length - 1]; break;
        case "GetVariable": { const name = String(stack.pop()); stack.push(this.getVar(frame, name)); break; }
        case "SetVariable": { const val = stack.pop(); const name = String(stack.pop()); this.setVar(frame, name, val); break; }
        case "GetMember": { const key = String(stack.pop()); const obj = stack.pop(); stack.push(this.host.getMember(obj, key)); break; }
        case "SetMember": { const val = stack.pop(); const key = String(stack.pop()); const obj = stack.pop(); this.host.setMember(obj, key, val); break; }
        case "Delete": { const key = String(stack.pop()); const obj = stack.pop(); stack.push(this.host.deleteMember?.(obj, key) ?? deletePlainMember(obj, key)); break; }
        case "Delete2": { const key = String(stack.pop()); stack.push(this.deleteVar(frame, key)); break; }
        case "DefineLocal": { const val = stack.pop(); const name = String(stack.pop()); frame.locals[name] = val; break; }
        case "DefineLocal2": { const name = String(stack.pop()); if (!(name in frame.locals)) frame.locals[name] = UNDEF; break; }
        case "InitArray": { const n = Number(stack.pop()) | 0; const arr: Avm1Value[] = []; for (let i = 0; i < n; i++) arr.unshift(stack.pop()); stack.push(arr); break; }
        case "InitObject": { const n = Number(stack.pop()) | 0; const o: any = {}; for (let i = 0; i < n; i++) { const v = stack.pop(); const k = String(stack.pop()); o[k] = v; } stack.push(o); break; }
        case "NewObject": { const name = String(stack.pop()); const args = popArgs(stack); stack.push(this.host.construct(name, args)); break; }
        case "NewMethod": { const key = stack.pop(); const obj = stack.pop(); const args = popArgs(stack); stack.push(this.newMethod(obj, key, args)); break; }
        case "Enumerate2": {
          const obj = stack.pop();
          stack.push(null);
          for (const key of this.enumerate(obj)) stack.push(key);
          break;
        }
        case "Not": stack.push(!truthy(stack.pop())); break;
        case "And": { const b = stack.pop(); const aa = stack.pop(); stack.push(truthy(aa) && truthy(b)); break; }
        case "Or": { const b = stack.pop(); const aa = stack.pop(); stack.push(truthy(aa) || truthy(b)); break; }
        case "BitAnd": { const b = stack.pop(); const aa = stack.pop(); stack.push((Number(aa) | 0) & (Number(b) | 0)); break; }
        case "BitOr": { const b = stack.pop(); const aa = stack.pop(); stack.push((Number(aa) | 0) | (Number(b) | 0)); break; }
        case "Equals": case "Equals2": { const b = stack.pop(); const aa = stack.pop(); stack.push(aa == b); break; }
        case "StrictEquals": { const b = stack.pop(); const aa = stack.pop(); stack.push(aa === b); break; }
        case "Less": case "Less2": { const b = stack.pop(); const aa = stack.pop(); stack.push(aa < b); break; }
        case "Greater": { const b = stack.pop(); const aa = stack.pop(); stack.push(aa > b); break; }
        case "StringEquals": { const b = stack.pop(); const aa = stack.pop(); stack.push(String(aa) === String(b)); break; }
        case "StringLess": { const b = stack.pop(); const aa = stack.pop(); stack.push(String(aa) < String(b)); break; }
        case "Add": case "Add2": { const b = stack.pop(); const aa = stack.pop(); stack.push(typeof aa === "string" || typeof b === "string" ? avmStr(aa) + avmStr(b) : Number(aa) + Number(b)); break; }
        case "StringAdd": { const b = stack.pop(); const aa = stack.pop(); stack.push(avmStr(aa) + avmStr(b)); break; }
        case "Subtract": { const b = stack.pop(); const aa = stack.pop(); stack.push(Number(aa) - Number(b)); break; }
        case "Multiply": { const b = stack.pop(); const aa = stack.pop(); stack.push(Number(aa) * Number(b)); break; }
        case "Divide": { const b = stack.pop(); const aa = stack.pop(); stack.push(Number(aa) / Number(b)); break; }
        case "Modulo": { const b = stack.pop(); const aa = stack.pop(); stack.push(Number(aa) % Number(b)); break; }
        case "Increment": stack.push(Number(stack.pop()) + 1); break;
        case "Decrement": stack.push(Number(stack.pop()) - 1); break;
        case "ToInteger": stack.push(Number(stack.pop()) | 0); break;
        case "ToNumber": stack.push(Number(stack.pop())); break;
        case "ToString": stack.push(avmStr(stack.pop())); break;
        case "TypeOf": stack.push(typeofAvm(stack.pop())); break;
        case "Trace": stack.pop(); break;
        case "GetProperty": { const index = Number(stack.pop()) | 0; const obj = stack.pop(); stack.push(this.host.getProperty?.(obj, index)); break; }
        case "SetProperty": { const val = stack.pop(); const index = Number(stack.pop()) | 0; const obj = stack.pop(); this.host.setProperty?.(obj, index, val); break; }
        case "DefineFunction": case "DefineFunction2": {
          const fn: Avm1Fn = { __avm1fn: true, params: a.params ?? [], body: a.body ?? [], registerCount: a.registerCount, flags: a.flags, debugName: a.name };
          if (a.name) this.setVar(frame, a.name, fn); else stack.push(fn);
          break;
        }
        case "Extends": {
          const superCtor = stack.pop();
          const subCtor = stack.pop();
          applyExtends(subCtor, superCtor);
          break;
        }
        case "InstanceOf": {
          const ctor = stack.pop();
          const obj = stack.pop();
          stack.push(instanceOfAvm(obj, ctor));
          break;
        }
        case "CallFunction": { const name = String(stack.pop()); const args = popArgs(stack); stack.push(this.callNamed(frame, name, args)); break; }
        case "CallMethod": {
          const key = stack.pop(); const obj = stack.pop(); const args = popArgs(stack);
          const k = key === UNDEF || key === null || key === "" ? undefined : String(key);
          stack.push(this.callMethod(obj, k, args)); break;
        }
        case "Return": return stack.pop();
        case "Jump": {
          const target = a.jumpTo ?? ip + 1;
          this.checkBackwardBranch(branchHits, frame, ip, target, stack);
          ip = target;
          continue;
        }
        case "If": {
          const cond = truthy(stack.pop());
          if (cond) {
            const target = a.jumpTo ?? ip + 1;
            this.checkBackwardBranch(branchHits, frame, ip, target, stack);
            ip = target;
            continue;
          }
          break;
        }
        case "Stop": case "Play": case "GotoFrame": case "GotoFrame2": case "GotoLabel": case "SetTarget": case "SetTarget2": break;
        default: break; // unknown op — best effort, leave stack as-is
      }
      ip++;
    }
    return UNDEF;
  }

  private getVar(frame: Frame, name: string): Avm1Value {
    if (name === "this") return frame.thisObj;
    if (name in frame.locals) return frame.locals[name];
    return this.host.getVar(name);
  }
  private setVar(frame: Frame, name: string, value: Avm1Value) {
    if (name in frame.locals) { frame.locals[name] = value; return; }
    this.host.setVar(name, value);
  }
  private deleteVar(frame: Frame, name: string): boolean {
    if (name in frame.locals) {
      delete frame.locals[name];
      return true;
    }
    return this.host.deleteVar?.(name) ?? false;
  }
  private enumerate(obj: Avm1Value): string[] {
    const keys = this.host.enumerate?.(obj);
    if (keys) return keys;
    if (obj == null) return [];
    if (Array.isArray(obj)) return obj.map((_, index) => String(index));
    if (typeof obj === "object" || typeof obj === "function") {
      try { return Object.keys(obj); } catch { return []; }
    }
    return [];
  }
  private callNamed(frame: Frame, name: string, args: Avm1Value[]): Avm1Value {
    const fn = this.getVar(frame, name);
    if (isFn(fn)) return this.callFunction(fn, args, frame.thisObj);
    return this.host.callNamed(name, args, frame.thisObj);
  }
  private callMethod(obj: Avm1Value, key: string | undefined, args: Avm1Value[]): Avm1Value {
    // AS2 Function.apply / Function.call — universal, so handle in the core.
    if (isFn(obj) && (key === "apply" || key === "call")) {
      const thisArg = args[0];
      const callArgs = key === "apply"
        ? (Array.isArray(args[1]) ? args[1] : args[1] != null ? Array.from(args[1] as ArrayLike<Avm1Value>) : [])
        : args.slice(1);
      return this.callFunction(obj, callArgs, thisArg);
    }
    if (typeof obj === "function" && key === undefined) {
      try { return obj(...args); } catch { return undefined; }
    }
    if (typeof obj === "function" && (key === "apply" || key === "call")) {
      const thisArg = args[0];
      const callArgs = key === "apply"
        ? (Array.isArray(args[1]) ? args[1] : args[1] != null ? Array.from(args[1] as ArrayLike<Avm1Value>) : [])
        : args.slice(1);
      try { return obj.apply(thisArg, callArgs); } catch { return undefined; }
    }
    if (obj != null && key !== undefined) {
      const m = this.host.getMember(obj, key);
      if (isFn(m)) return this.callFunction(m, args, obj);
    }
    return this.host.callMethod(obj, key, args);
  }
  private newMethod(obj: Avm1Value, key: Avm1Value, args: Avm1Value[]): Avm1Value {
    const ctor = key === undefined || key === null || key === "" ? obj : this.host.getMember(obj, String(key));
    return this.host.instantiate(ctor, args);
  }
  private checkBackwardBranch(hits: Map<string, number>, frame: Frame, ip: number, target: number, stack: Avm1Value[]) {
    if (target > ip) return;
    const key = `${ip}->${target}`;
    const next = (hits.get(key) ?? 0) + 1;
    hits.set(key, next);
    if (next > 200_000) throw new Error(this.branchError("avm1 backward branch limit exceeded", frame, ip, target, stack));
  }
  private branchError(prefix: string, frame: Frame, ip: number, target: number | undefined, stack: Avm1Value[]): string {
    return `${prefix}: function=${frame.label}, opcode=${ip}, target=${target ?? "n/a"}, stackTop=${formatStackTop(stack)}`;
  }
}

interface Frame { thisObj: Avm1Value; registers: Avm1Value[]; locals: Record<string, Avm1Value>; label: string; }

export function isFn(v: Avm1Value): v is Avm1Fn { return !!v && typeof v === "object" && (v as any).__avm1fn === true; }
export function ensurePrototype(fn: Avm1Value): Record<string, Avm1Value> | undefined {
  if (!fn || typeof fn !== "object") return undefined;
  const obj = fn as { prototype?: Record<string, Avm1Value> };
  if (!obj.prototype) obj.prototype = Object.create(null);
  return obj.prototype;
}
/** Safe AS2 string coercion: null-prototype objects (our class instances) have no
 *  toString, so `String(obj)` throws "Cannot convert object to primitive value". */
function avmStr(v: Avm1Value): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") { try { return String(v); } catch { return "[object Object]"; } }
  return String(v);
}
function truthy(v: Avm1Value): boolean { return !(v === undefined || v === null || v === false || v === 0 || v === "" || (typeof v === "number" && isNaN(v))); }
function typeofAvm(v: Avm1Value): string { return v === undefined ? "undefined" : v === null ? "null" : isFn(v) || typeof v === "function" ? "function" : Array.isArray(v) ? "object" : typeof v; }
function popArgs(stack: Avm1Value[]): Avm1Value[] { const n = Number(stack.pop()) | 0; const args: Avm1Value[] = []; for (let i = 0; i < n; i++) args.push(stack.pop()); return args; }

function debugFunctionName(fn: Avm1Fn): string {
  const named = fn.debugName || (fn as Record<string, Avm1Value>).__fqn;
  return typeof named === "string" && named ? named : "<anonymous>";
}

function deletePlainMember(obj: Avm1Value, key: string): boolean {
  if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) return false;
  try { return delete obj[key]; } catch { return false; }
}

function formatStackTop(stack: Avm1Value[]): string {
  return JSON.stringify(stack.slice(-5).map((value) => {
    if (value === undefined) return "undefined";
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (isFn(value)) return `[Function ${debugFunctionName(value)}]`;
    if (Array.isArray(value)) return `[Array(${value.length})]`;
    if (typeof value === "object") return value.__appClip ? "[MovieClip]" : value.__appText ? "[TextField]" : "[Object]";
    return String(value);
  }));
}

function applyExtends(subCtor: Avm1Value, superCtor: Avm1Value) {
  const subProto = ensurePrototype(subCtor);
  const superProto = ensurePrototype(superCtor);
  if (!subProto || !superProto) return;
  if (Object.getPrototypeOf(subProto) !== superProto) Object.setPrototypeOf(subProto, superProto);
  if (!(subProto as Record<string, Avm1Value>).__constructor) (subProto as Record<string, Avm1Value>).__constructor = subCtor;
  if (!(superProto as Record<string, Avm1Value>).__constructor) (superProto as Record<string, Avm1Value>).__constructor = superCtor;
  try { (subCtor as Record<string, Avm1Value>).__super = superCtor; } catch { /* frozen */ }
}

function instanceOfAvm(obj: Avm1Value, ctor: Avm1Value): boolean {
  if (ctor?.__nativeCtor === "Array") return Array.isArray(obj);
  if (ctor?.__nativeCtor === "Object") return obj !== null && (typeof obj === "object" || typeof obj === "function");
  if (!obj || typeof obj !== "object" || !ctor || typeof ctor !== "object") return false;
  const ctorProto = ensurePrototype(ctor);
  if (!ctorProto) return false;
  let proto = Object.getPrototypeOf(obj);
  while (proto) {
    if (proto === ctorProto) return true;
    proto = Object.getPrototypeOf(proto);
  }
  let cls = (obj as Record<string, Avm1Value>).__class;
  let guard = 0;
  while (cls && guard++ < 40) {
    if (cls === ctor) return true;
    const clsProto = ensurePrototype(cls);
    if (!clsProto) break;
    const parentProto = Object.getPrototypeOf(clsProto);
    if (!parentProto) break;
    cls = (parentProto as Record<string, Avm1Value>).__constructor;
  }
  return false;
}
