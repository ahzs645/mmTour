// Runs a data-driven AS2 application (e.g. an XML-fed site that builds its UI in
// class methods) through the Avm1Vm against a live display list. Generic — no
// scene-specific branches. The display-list operations go through a PlayerBridge
// so the AS2 object model (classes/prototypes/getters-setters/events/XML/XPath)
// stays here and the ClipInstance specifics stay in the Player.
//
// Gated on `control.initActions` + `control.frameBytecode` (only data-driven app
// SWFs carry these), so timeline-script SWFs like the tour are never touched.

import { Avm1Vm, ensurePrototype, isFn, type Avm1Host, type Avm1Value } from "./avm1Vm.ts";
import type { Avm1Op } from "../data/avm1Bytecode.ts";

/** A live clip handle the bridge understands (the Player wraps its ClipInstance). */
export type AppClip = { __appClip: true; [k: string]: unknown };
/** A text-field handle (a named text leaf inside a clip). */
export type AppText = { __appText: true; clip: AppClip; field: string };

export interface PlayerBridge {
  /** The root movie clip. */
  root(): AppClip;
  /** A named child of `clip` — a sub-clip (AppClip) or a text leaf (AppText), or undefined. */
  child(clip: AppClip, name: string): AppClip | AppText | undefined;
  /** attachMovie(linkage,name,depth) → the new clip (created from the library + reconciled). */
  attachMovie(parent: AppClip, linkage: string, name: string, depth: number): AppClip | undefined;
  /** createEmptyMovieClip(name,depth) → the new (empty) clip. */
  createEmptyMovieClip(parent: AppClip, name: string, depth: number): AppClip;
  /** Set a text leaf's text (string or html). */
  setText(t: AppText, value: string, html: boolean): void;
  /** Read a text leaf's current text. */
  getText(t: AppText): string;
  /** Read/write AS2 display fields on a text leaf (`_height`, `_width`, `autoSize`, ...). */
  getTextProp?(t: AppText, key: string): Avm1Value;
  setTextProp?(t: AppText, key: string, value: Avm1Value): void;
  /** Read/write a clip display property (_x,_y,_alpha,_width,…). */
  getClipProp(clip: AppClip, key: string): Avm1Value;
  setClipProp(clip: AppClip, key: string, value: Avm1Value): void;
  /** Stored arbitrary AS2 field bag for a clip (clip.id, clip.label, …). */
  clipField(clip: AppClip, key: string): Avm1Value;
  setClipField(clip: AppClip, key: string, value: Avm1Value): void;
  hasClipField(clip: AppClip, key: string): boolean;
  /** Linkage/export name for a clip's character id (to bind placed instances to classes). */
  linkageOf(clip: AppClip): string | undefined;
  /** nextHighestDepth for attach/create. */
  nextDepth(clip: AppClip): number;
  /** Re-render the stage after the bootstrap mutates it. */
  render(): void;
  /** Fetch a text asset (the app's XML), resolving asynchronously. */
  fetchText(url: string, onText: (text: string | null) => void): void;
  /** Register a VM-backed MovieClip pointer dispatcher for clips with AS2 handlers. */
  setPointerEventHandler?(clip: AppClip, handler: ((event: string) => void) | undefined): void;
  /** Run a generic MovieClip timeline command (`gotoAndPlay`, `stop`, etc.). */
  timelineCommand?(clip: AppClip, command: string, frame?: Avm1Value): boolean;
  /** Register a VM-backed class method dispatcher for timeline frame calls on this clip. */
  setClipMethodDispatcher?(clip: AppClip, dispatcher: ((method: string, args: Avm1Value[]) => boolean) | undefined): void;
}

// --- a tiny pure-JS XML DOM (browser-safe): firstChild / childNodes / attributes
//     (plain object) / nodeValue, matching the access patterns AS2 XML uses. ---
type XmlNode = { __xmlNode: true; nodeName: string; nodeValue?: string; attributes: Record<string, string>; childNodes: XmlNode[]; firstChild?: XmlNode | null; nextSibling?: XmlNode | null };
function parseXmlDom(src: string): XmlNode {
  let i = 0;
  const doc: XmlNode = { __xmlNode: true, nodeName: "#document", attributes: {}, childNodes: [] };
  let cur = doc; const stack = [doc];
  const addText = (p: XmlNode, t: string) => p.childNodes.push({ __xmlNode: true, nodeName: "#text", nodeValue: t, attributes: {}, childNodes: [] });
  while (i < src.length) {
    if (src.startsWith("<!--", i)) { const e = src.indexOf("-->", i); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith("<![CDATA[", i)) { const e = src.indexOf("]]>", i); addText(cur, src.slice(i + 9, e)); i = e + 3; continue; }
    if (src.startsWith("<?", i)) { const e = src.indexOf("?>", i); i = e < 0 ? src.length : e + 2; continue; }
    if (src[i] === "<" && src[i + 1] === "/") { const e = src.indexOf(">", i); stack.pop(); cur = stack[stack.length - 1]; i = e + 1; continue; }
    if (src[i] === "<") {
      const e = src.indexOf(">", i); let tag = src.slice(i + 1, e); const selfClose = tag.endsWith("/"); if (selfClose) tag = tag.slice(0, -1);
      const name = (tag.match(/^([\w:.-]+)/) || [, tag])[1] as string;
      const attrs: Record<string, string> = {}; const ar = /([\w:.-]+)\s*=\s*"([^"]*)"/g; let am: RegExpExecArray | null;
      while ((am = ar.exec(tag.slice(name.length)))) attrs[am[1]] = am[2];
      const node: XmlNode = { __xmlNode: true, nodeName: name, attributes: attrs, childNodes: [] };
      cur.childNodes.push(node); if (!selfClose) { stack.push(node); cur = node; }
      i = e + 1; continue;
    }
    const e = src.indexOf("<", i); const txt = src.slice(i, e < 0 ? src.length : e); if (txt.trim()) addText(cur, txt); i = e < 0 ? src.length : e;
  }
  const fin = (n: XmlNode) => { n.firstChild = n.childNodes[0] ?? null; for (let k = 0; k < n.childNodes.length; k++) { n.childNodes[k].nextSibling = n.childNodes[k + 1] ?? null; fin(n.childNodes[k]); } };
  fin(doc); return doc;
}
const isXmlNode = (v: any): v is XmlNode => !!v && v.__xmlNode === true;
function xmlDescendants(ctx: any, name: string): XmlNode[] { const out: XmlNode[] = []; const w = (n: any) => { for (const c of n?.childNodes || []) { if (c.nodeName === name) out.push(c); w(c); } }; w(ctx); return out; }
function xmlSelect(ctx: any, query: string): XmlNode[] { return xmlDescendants(ctx, String(query).replace(/^\/+/, "")); }

const avmCoerce = (v: any): string => { if (v == null) return ""; if (typeof v === "object") { try { return String(v); } catch { return ""; } } return String(v); };
const isClip = (v: any): v is AppClip => !!v && v.__appClip === true;
const isText = (v: any): v is AppText => !!v && v.__appText === true;
const POINTER_EVENTS = new Set(["release", "releaseoutside", "rollover", "rollout", "press"]);
const DIRECT_POINTER_HANDLERS = new Map([
  ["onRelease", "release"],
  ["onReleaseOutside", "releaseoutside"],
  ["onRollOver", "rollover"],
  ["onRollOut", "rollout"],
  ["onPress", "press"],
]);

export function runDataDrivenApp(
  control: { initActions?: Avm1Op[][]; frameBytecode?: { frame: number; ops: Avm1Op[] }[]; registeredClasses?: Record<string, string> },
  bridge: PlayerBridge,
): boolean {
  const initActions = control.initActions ?? [];
  const frameBytecode = control.frameBytecode ?? [];
  const registeredClasses = control.registeredClasses ?? {};
  if (!initActions.length || !frameBytecode.length) return false;

  const globals: any = Object.create(null);
  const registry: Record<string, any> = Object.create(null); // linkage → class fn
  const clipClass = new WeakMap<object, any>();              // clip → bound AS2 class fn
  const clipMethodDispatchers = new WeakSet<object>();
  const constructed = new WeakSet<object>();                 // clips whose AS2 constructor has run
  const listeners = new WeakMap<object, Record<string, any[]>>();
  const root = bridge.root();
  const timers = new Map<number, ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();
  let nextTimerId = 1;

  const vmRef: { vm?: Avm1Vm } = {};
  const invoke = (fn: any, args: any[], thisObj: any): any => {
    if (!fn) return undefined;
    if (isFn(fn)) return vmRef.vm!.callFunction(fn, args, thisObj);
    return undefined;
  };
  const protoOf = (fn: any) => {
    const proto = ensurePrototype(fn);
    if (proto && !(proto as any).__constructor) (proto as any).__constructor = fn;
    return proto;
  };
  const resolveProto = (cls: any, key: string): any => { let p = protoOf(cls); let g = 0; while (p && g++ < 40) { if (key in p) return p[key]; p = Object.getPrototypeOf(p); } return undefined; };
  const resolveAccessor = (cls: any, key: string): any => { let p = protoOf(cls); let g = 0; while (p && g++ < 40) { if (p.__accessors && key in p.__accessors) return p.__accessors[key]; p = Object.getPrototypeOf(p); } return undefined; };
  const resolveGetter = (cls: any, key: string): any => resolveAccessor(cls, key)?.get ?? resolveProto(cls, `__get__${key}`) ?? resolveProto(cls, `get ${key}`);
  const resolveSetter = (cls: any, key: string): any => resolveAccessor(cls, key)?.set ?? resolveProto(cls, `__set__${key}`) ?? resolveProto(cls, `set ${key}`);
  const normLinkage = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const registryNorm = new Map<string, any>();
  const resolvePath = (path: string): any => { let o: any = globals; for (const part of path.split(".")) { if (o == null) return undefined; o = o[part]; } return isFn(o) ? o : undefined; };
  const classFor = (clip: AppClip): any => {
    let c = clipClass.get(clip);
    if (!c) {
      const lk = bridge.linkageOf(clip);
      if (lk) {
        // Prefer the build-time linkage→class-path resolved against the now-complete
        // class tree (registerClass can capture undefined during init ordering); fall
        // back to whatever the runtime registry captured.
        const path = registeredClasses[lk] ?? registeredClasses[lk.trim()];
        c = (path && resolvePath(path)) || registry[lk] || registry[lk.trim()] || registryNorm.get(normLinkage(lk));
      }
      if (c) {
        clipClass.set(clip, c);
        if (!clipMethodDispatchers.has(clip)) {
          clipMethodDispatchers.add(clip);
          bridge.setClipMethodDispatcher?.(clip, (method, args) => callObjectMethod(clip, method, args));
        }
        // A class-linked clip placed on the timeline (a section reveal panel, a
        // robot subnav, …) gets its AS2 constructor exactly once, like an
        // attachMovie'd one — Flash runs it on instantiation, and it is where a
        // component sets its initial state (e.g. a Section hides itself until shown).
        // Isolated: a single component's constructor failing must not break method
        // dispatch on this clip or the rest of the bootstrap.
        if (!constructed.has(clip)) {
          constructed.add(clip);
          try { invoke(c, [], clip); } catch (error) { console.warn("[avm1App] placed-clip constructor failed", error); }
        }
      }
    }
    return c;
  };
  const listenersOf = (obj: any): Record<string, any[]> => { let l = listeners.get(obj); if (!l) { l = Object.create(null) as Record<string, any[]>; listeners.set(obj, l); } return l; };
  const callObjectMethod = (obj: any, method: string, args: any[] = []): boolean => {
    if (!obj || !method) return false;
    if (isClip(obj)) {
      const cls = classFor(obj);
      const fn = cls ? resolveProto(cls, method) : undefined;
      if (!fn) return false;
      invoke(fn, args, obj);
      bridge.render();
      return true;
    }
    const fn = obj[method] ?? obj.props?.[method];
    if (isFn(fn)) {
      invoke(fn, args, obj);
      bridge.render();
      return true;
    }
    return false;
  };
  const scheduleCallback = (repeat: boolean, args: any[]): number => {
    const target = args[0];
    const method = String(args[1] ?? "");
    const delay = Math.max(16, Number(args[2] ?? 0) || 0);
    const id = nextTimerId++;
    if (repeat) {
      // Repeating AS2 timers often back mouse-tracking loops. Until the player
      // emulates Flash hit-testing for those loops, firing them on wall-clock JS
      // time can immediately undo visible state such as opened menus.
      return id;
    }
    const callback = () => {
      timers.delete(id);
      callObjectMethod(target, method);
    };
    timers.set(id, setTimeout(callback, delay));
    return id;
  };
  const clearTimer = (id: any) => {
    const handle = timers.get(Number(id));
    if (!handle) return;
    clearTimeout(handle);
    clearInterval(handle);
    timers.delete(Number(id));
  };
  const createTween = (args: any[]) => {
    const target = args[0];
    const prop = String(args[1] ?? "");
    const begin = args[3];
    const finish = args[4];
    const duration = Number(args[5] ?? 0);
    const useSeconds = Boolean(args[6]);
    const tween: any = { __tween: true, target, prop, begin, finish, duration, completed: false };
    const finishTween = () => {
      tween.completed = true;
      if (target && prop) host.setMember(target, prop, finish);
      const callback = tween.onMotionFinished;
      if (callback) {
        tween.completed = false;
        invoke(callback, [tween], tween);
      }
      bridge.render();
    };
    if (!target || !prop) {
      tween.completed = true;
      return tween;
    }
    host.setMember(target, prop, begin);
    if (!useSeconds || !Number.isFinite(duration) || duration <= 0) {
      finishTween();
      return tween;
    }
    const beginNumber = Number(begin);
    const finishNumber = Number(finish);
    const durationMs = Math.max(16, duration * 1000);
    const start = Date.now();
    const id = nextTimerId++;
    const handle = setInterval(() => {
      const progress = Math.min(1, (Date.now() - start) / durationMs);
      if (Number.isFinite(beginNumber) && Number.isFinite(finishNumber)) {
        host.setMember(target, prop, beginNumber + (finishNumber - beginNumber) * progress);
      }
      if (progress >= 1) {
        clearTimer(id);
        finishTween();
      } else {
        bridge.render();
      }
    }, 33);
    timers.set(id, handle);
    tween.__timerId = id;
    bridge.render();
    return tween;
  };
  const hasPointerInterest = (clip: AppClip): boolean => {
    for (const [name] of DIRECT_POINTER_HANDLERS) if (bridge.clipField(clip, name)) return true;
    const L = listenersOf(clip);
    return Object.keys(L).some((name) => POINTER_EVENTS.has(name.toLowerCase()) && L[name]?.length);
  };
  const dispatchPointerEvent = (clip: AppClip, type: string) => {
    const directName = [...DIRECT_POINTER_HANDLERS.entries()].find(([, event]) => event === type)?.[0];
    const direct = directName ? bridge.clipField(clip, directName) : undefined;
    if (direct) {
      // Direct AS2 handlers often call dispatchEvent with custom fields; a
      // second synthetic listener event would lose those fields and double-fire.
      invoke(direct, [{ target: clip, type }], clip);
      bridge.render();
      return;
    }
    const L = listenersOf(clip);
    for (const name of Object.keys(L)) {
      if (name.toLowerCase() !== type) continue;
      const eventObject = { target: clip, type: name };
      for (const listener of L[name] || []) invoke(listener, [eventObject], clip);
    }
    bridge.render();
  };
  const syncPointerClip = (clip: AppClip) => {
    if (hasPointerInterest(clip)) {
      bridge.setClipField(clip, "__appPointerEvents", true);
      bridge.setPointerEventHandler?.(clip, (event) => dispatchPointerEvent(clip, event));
      return;
    }
    bridge.setClipField(clip, "__appPointerEvents", undefined);
    bridge.setPointerEventHandler?.(clip, undefined);
  };

  const host: Avm1Host = {
    getVar(name) {
      if (name === "_global") return globals;
      if (name === "_root" || name === "_level0" || name === "this") return root;
      if (name in globals) return globals[name];
      return undefined;
    },
    setVar(name, v) { globals[name] = v; },
    getMember(obj, key) {
      if (obj == null) return undefined;
      if (key === "addEventListener" || key === "removeEventListener" || key === "dispatchEvent") return undefined;
      if ((key === "selectNodes" || key === "selectSingleNode") && obj.__fqn === "com.xfactorstudio.xml.xpath.XPath") return undefined;
      if (isFn(obj)) { if (key === "prototype") return protoOf(obj); return (key in obj) ? (obj as any)[key] : undefined; }
      if (isText(obj)) {
        if (key === "text" || key === "htmlText") return bridge.getText(obj);
        return bridge.getTextProp?.(obj, key) ?? (obj as any)[key];
      }
      if (isClip(obj)) {
        const cls = classFor(obj);
        const getter = cls ? resolveGetter(cls, key as string) : undefined;
        if (getter) return invoke(getter, [], obj);
        if (bridge.hasClipField(obj, key as string)) return bridge.clipField(obj, key as string);
        const ch = bridge.child(obj, key as string);
        if (ch !== undefined) { if (isClip(ch) && !clipClass.has(ch)) classFor(ch); return ch; }
        if (cls) { const m = resolveProto(cls, key as string); if (m !== undefined) return m; }
        return bridge.getClipProp(obj, key as string);
      }
      if (isXmlNode(obj)) { return (obj as any)[key]; } // firstChild/childNodes/attributes/nodeValue/nodeName
      if (typeof obj === "string" || obj instanceof String) {
        if (key === "length") return avmCoerce(obj).length;
        const member = (String.prototype as any)[key];
        return typeof member === "function" ? (...args: any[]) => member.apply(avmCoerce(obj), args) : undefined;
      }
      if (Array.isArray(obj)) {
        const member = (obj as any)[key];
        return typeof member === "function" ? (...args: any[]) => member.apply(obj, args) : member;
      }
      if (obj.__class) {
        if (obj.props && key in obj.props) return obj.props[key];
        if (key in obj) return obj[key];
        const m = resolveProto(obj.__class, key as string); if (m !== undefined) return m;
        return undefined;
      }
      try { return obj[key]; } catch { return undefined; }
    },
    setMember(obj, key, value) {
      if (obj == null) return;
      if (obj.__tween) {
        obj[key] = value;
        if (key === "onMotionFinished" && obj.completed && value) {
          obj.completed = false;
          invoke(value, [], obj);
          bridge.render();
        }
        return;
      }
      if (isFn(obj)) { (obj as any)[key] = value; return; }
      if (isText(obj)) {
        if (key === "text" || key === "htmlText") { bridge.setText(obj, avmCoerce(value), key === "htmlText"); return; }
        bridge.setTextProp?.(obj, key, value);
        (obj as any)[key] = value;
        return;
      }
      if (isClip(obj)) {
        const cls = classFor(obj);
        const setter = cls ? resolveSetter(cls, key as string) : undefined;
        if (setter) { invoke(setter, [value], obj); return; }
        if (key.startsWith("_")) { bridge.setClipProp(obj, key, value); return; }
        bridge.setClipField(obj, key as string, value);
        if (DIRECT_POINTER_HANDLERS.has(key as string)) syncPointerClip(obj);
        return;
      }
      try { obj[key] = value; } catch { /* frozen */ }
    },
    deleteMember(obj, key) {
      if (obj == null) return false;
      if (isFn(obj)) { try { return delete (obj as any)[key]; } catch { return false; } }
      if (isText(obj)) {
        try { return delete (obj as any)[key]; } catch { return false; }
      }
      if (isClip(obj)) {
        bridge.setClipField(obj, key, undefined);
        if (DIRECT_POINTER_HANDLERS.has(key)) syncPointerClip(obj);
        return true;
      }
      try { return delete obj[key]; } catch { return false; }
    },
    deleteVar(name) {
      if (name in globals) {
        delete globals[name];
        return true;
      }
      return false;
    },
    enumerate(obj) {
      if (obj == null) return [];
      if (isXmlNode(obj)) return Object.keys(obj).filter((key) => obj[key as keyof XmlNode] !== undefined);
      if (isClip(obj)) {
        const out = new Set<string>();
        for (const key of Object.keys((obj as any) || {})) out.add(key);
        for (const key of Object.keys((obj as any).props || {})) if (bridge.clipField(obj, key) !== undefined) out.add(key);
        return [...out];
      }
      if (obj.props && typeof obj.props === "object") return Object.keys(obj.props).filter((key) => obj.props[key] !== undefined);
      try { return Object.keys(obj).filter((key) => obj[key] !== undefined); } catch { return []; }
    },
    construct(className, args) {
      if (className === "Object") return Object.create(null);
      if (className === "Array") return args.length === 1 && typeof args[0] === "number" ? new Array(args[0]) : [...args];
      if (className === "XML" || className === "LoadVars") return { __xml: true, props: Object.create(null), ignoreWhite: true };
      if (className === "mx.transitions.Tween" || className.endsWith(".Tween")) return createTween(args);
      const path = String(className).split(".");
      let cf: any = globals; for (const p of path) cf = cf?.[p];
      return this.instantiate(cf, args);
    },
    instantiate(ctor, args) {
      const fqn = typeof ctor?.__fqn === "string" ? ctor.__fqn : "";
      if (fqn === "mx.transitions.Tween" || fqn.endsWith(".Tween")) return createTween(args);
      if (!isFn(ctor)) return Object.create(null);
      const inst: any = Object.create(null); inst.props = Object.create(null); inst.__class = ctor;
      invoke(ctor, args, inst);
      return inst;
    },
    callNamed(name, args) {
      switch (name) {
        case "parseInt": return parseInt(args[0], 10);
        case "parseFloat": return parseFloat(args[0]);
        case "Number": return Number(args[0]);
        case "String": return String(args[0] ?? "");
        case "Boolean": return Boolean(args[0]);
        case "Array": return args.length === 1 && typeof args[0] === "number" ? new Array(args[0]) : [...args];
        case "Object": return Object.create(null);
        case "getTimer": return 0;
        case "setTimeout": return scheduleCallback(false, args);
        case "setInterval": return scheduleCallback(true, args);
        case "clearInterval": case "clearTimeout": clearTimer(args[0]); return undefined;
        case "updateAfterEvent":
        case "trace": case "ASSetPropFlags": case "getURL": return undefined;
        default: return undefined;
      }
    },
    callMethod(obj, key, args) {
      if (obj == null || key === undefined) return undefined;
      // EventDispatcher (generic, host-managed so add/dispatch stay consistent)
      if (key === "addEventListener") {
        const t = String(args[0]);
        const L = listenersOf(obj);
        L[t] = [...(L[t] || []), args[1]];
        if (isClip(obj) && POINTER_EVENTS.has(t.toLowerCase())) syncPointerClip(obj);
        return undefined;
      }
      if (key === "removeEventListener") {
        const t = String(args[0]);
        const L = listenersOf(obj);
        if (L[t]?.length) L[t] = L[t].filter((listener) => listener !== args[1]);
        if (isClip(obj) && POINTER_EVENTS.has(t.toLowerCase())) syncPointerClip(obj);
        return undefined;
      }
      if (key === "dispatchEvent") { const ev = args[0]; const t = String(ev?.type ?? ""); for (const l of listenersOf(obj)[t] || []) invoke(l, [ev], obj); return undefined; }
      if ((key === "setTimeout" || key === "setInterval") && obj === globals) return scheduleCallback(key === "setInterval", args);
      if ((key === "clearTimeout" || key === "clearInterval") && obj === globals) { clearTimer(args[0]); return undefined; }
      if (key === "addProperty") { (obj.__accessors ??= Object.create(null))[String(args[0])] = { get: args[1], set: args[2] }; return true; }
      // XML object: fetch + parse, then fire onLoad and re-render.
      if (obj.__xml) {
        if (key === "load") {
          bridge.fetchText(String(args[0]), (text) => {
            const doc = text != null ? parseXmlDom(text) : null;
            obj.firstChild = doc; obj.childNodes = doc?.childNodes; obj.loaded = true;
            const cb = obj.onLoad ?? obj.props?.onLoad;
            try {
              if (cb) invoke(cb, [true], obj);
            } catch (error) {
              console.warn("[avm1App] XML onLoad failed", error);
            } finally {
              bridge.render();
            }
          });
          return true;
        }
        return undefined;
      }
      // XPath (xfactorstudio static class) + node-level selectNodes/selectSingleNode.
      if (obj.__fqn === "com.xfactorstudio.xml.xpath.XPath") {
        const nodes = xmlSelect(args[0], String(args[1]));
        return key === "selectNodes" ? nodes : nodes[0];
      }
      if (isXmlNode(obj)) {
        if (key === "selectNodes") return xmlSelect(obj, String(args[0]));
        if (key === "selectSingleNode") return xmlSelect(obj, String(args[0]))[0];
      }
      if (typeof obj === "string" || obj instanceof String) {
        const s = avmCoerce(obj);
        switch (key) {
          case "split": return s.split(avmCoerce(args[0]), args[1] === undefined ? undefined : Number(args[1]));
          case "substr": return s.substr(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
          case "substring": return s.substring(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
          case "indexOf": return s.indexOf(avmCoerce(args[0]), args[1] === undefined ? undefined : Number(args[1]));
          case "charAt": return s.charAt(Number(args[0] ?? 0));
          case "toUpperCase": return s.toUpperCase();
          case "toLowerCase": return s.toLowerCase();
          case "slice": return s.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
          default: return undefined;
        }
      }
      if (Array.isArray(obj)) { const m = (obj as any)[key]; return typeof m === "function" ? m.apply(obj, args) : undefined; }
      if (key === "registerClass") { registry[String(args[0])] = args[1]; return true; }
      // clip natives
      if (isClip(obj)) {
        switch (key) {
          case "attachMovie": { const c = bridge.attachMovie(obj, String(args[0]), String(args[1]), Number(args[2] ?? bridge.nextDepth(obj))); if (c) classFor(c); return c ?? Object.create(null); }
          case "createEmptyMovieClip": return bridge.createEmptyMovieClip(obj, String(args[0]), Number(args[1] ?? bridge.nextDepth(obj)));
          case "createTextField": return bridge.createEmptyMovieClip(obj, String(args[0]), Number(args[2] ?? bridge.nextDepth(obj)));
          case "getNextHighestDepth": return bridge.nextDepth(obj);
          case "getBytesLoaded": case "getBytesTotal": return 100;
          case "gotoAndPlay":
          case "gotoAndStop":
          case "play":
          case "stop":
          case "nextFrame":
          case "prevFrame":
            return bridge.timelineCommand?.(obj, key, args[0]) ?? undefined;
          default: return undefined; // no-op
        }
      }
      const m = this.getMember(obj, key); if (isFn(m)) return invoke(m, args, obj);
      return undefined;
    },
    getProperty() { return 0; },
    setProperty() { /* numbered props unused by these apps */ },
  };

  const vm = new Avm1Vm(host, 60_000_000);
  vmRef.vm = vm;
  globals.Object = { __nativeCtor: "Object", prototype: Object.create(null) };
  globals.Array = { __nativeCtor: "Array", prototype: Object.create(null) };
  globals.MovieClip = { __nativeCtor: "MovieClip", prototype: Object.create(null) };
  globals._global = globals;

  // 1) class registrations (#initclip): build _global.* classes + the linkage registry.
  // Run the #initclip programs: build the _global class tree + the linkage registry.
  for (const prog of initActions) {
    try { vm.callFunction({ __avm1fn: true, params: [], body: prog, registerCount: 256, flags: 0 } as any, [], root); } catch { /* skip a bad init program */ }
  }
  // Tag classes with their fully-qualified name (so XPath/EventDispatcher overrides
  // can recognise them). Skip the circular `_global`/`_root` self-references and
  // guard against cycles, else names accumulate bogus `_global.` prefixes.
  const tagged = new WeakSet<object>();
  const tagFqn = (o: any, prefix: string, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 8 || tagged.has(o)) return;
    tagged.add(o);
    for (const k of Object.keys(o)) {
      if (k === "_global" || k === "_root" || k === "_level0") continue;
      const v: any = o[k];
      if (v && typeof v === "object") {
        const fqn = prefix ? prefix + "." + k : k;
        if (isFn(v) && !(v as any).__fqn) (v as any).__fqn = fqn;
        tagFqn(v, fqn, depth + 1);
      }
    }
  };
  tagFqn(globals, "");

  // 2) the entry-point frame(s) (e.g. App.main(this)).
  let ran = false;
  let bootErr: unknown = null;
  for (const fb of frameBytecode) {
    try { vm.callFunction({ __avm1fn: true, params: [], body: fb.ops, registerCount: 256, flags: 0 } as any, [], root); ran = true; } catch (e) { bootErr = e; }
  }
  for (const k of Object.keys(registry)) registryNorm.set(normLinkage(k), registry[k]);
  bridge.render();
  return ran;
}
