// Runs a data-driven AS2 application (e.g. an XML-fed site that builds its UI in
// class methods) through the Avm1Vm against a live display list. Generic — no
// scene-specific branches. The display-list operations go through a PlayerBridge
// so the AS2 object model (classes/prototypes/getters-setters/events/XML/XPath)
// stays here and the ClipInstance specifics stay in the Player.
//
// Gated on `control.initActions` + `control.frameBytecode` (only data-driven app
// SWFs carry these), so timeline-script SWFs like the tour are never touched.

import { Avm1Vm, isFn, type Avm1Host, type Avm1Value } from "./avm1Vm.ts";
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
  const listeners = new WeakMap<object, Record<string, any[]>>();
  const root = bridge.root();

  const vmRef: { vm?: Avm1Vm } = {};
  const invoke = (fn: any, args: any[], thisObj: any): any => {
    if (!fn) return undefined;
    if (isFn(fn)) return vmRef.vm!.callFunction(fn, args, thisObj);
    return undefined;
  };
  const protoOf = (fn: any) => { if (!fn) return undefined; if (!fn.prototype) fn.prototype = Object.create(null); return fn.prototype; };
  const resolveProto = (cls: any, key: string): any => { let p = cls?.prototype; let g = 0; while (p && g++ < 40) { if (key in p) return p[key]; p = p.__proto__; } return undefined; };
  const resolveAccessor = (cls: any, key: string): any => { let p = cls?.prototype; let g = 0; while (p && g++ < 40) { if (p.__accessors && key in p.__accessors) return p.__accessors[key]; p = p.__proto__; } return undefined; };
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
      if (c) clipClass.set(clip, c);
    }
    return c;
  };
  const listenersOf = (obj: any): Record<string, any[]> => { let l = listeners.get(obj); if (!l) { l = Object.create(null) as Record<string, any[]>; listeners.set(obj, l); } return l; };

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
      if (isText(obj)) { if (key === "text" || key === "htmlText") return bridge.getText(obj); return (obj as any)[key]; }
      if (isClip(obj)) {
        const cls = classFor(obj);
        const acc = cls ? resolveAccessor(cls, key as string) : undefined;
        if (acc?.get) return invoke(acc.get, [], obj);
        if (bridge.hasClipField(obj, key as string)) return bridge.clipField(obj, key as string);
        const ch = bridge.child(obj, key as string);
        if (ch !== undefined) { if (isClip(ch) && !clipClass.has(ch)) classFor(ch); return ch; }
        if (cls) { const m = resolveProto(cls, key as string); if (m !== undefined) return m; }
        return bridge.getClipProp(obj, key as string);
      }
      if (isXmlNode(obj)) { return (obj as any)[key]; } // firstChild/childNodes/attributes/nodeValue/nodeName
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
      if (isFn(obj)) { (obj as any)[key] = value; return; }
      if (isText(obj)) { if (key === "text" || key === "htmlText") { bridge.setText(obj, avmCoerce(value), key === "htmlText"); return; } (obj as any)[key] = value; return; }
      if (isClip(obj)) {
        const cls = classFor(obj);
        const acc = cls ? resolveAccessor(cls, key as string) : undefined;
        if (acc?.set) { invoke(acc.set, [value], obj); return; }
        if (key.startsWith("_")) { bridge.setClipProp(obj, key, value); return; }
        bridge.setClipField(obj, key as string, value);
        return;
      }
      try { obj[key] = value; } catch { /* frozen */ }
    },
    construct(className, args) {
      if (className === "Object") return Object.create(null);
      if (className === "Array") return args.length === 1 && typeof args[0] === "number" ? new Array(args[0]) : [...args];
      if (className === "XML" || className === "LoadVars") return { __xml: true, props: Object.create(null), ignoreWhite: true };
      const path = String(className).split(".");
      let cf: any = globals; for (const p of path) cf = cf?.[p];
      return this.instantiate(cf, args);
    },
    instantiate(ctor, args) {
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
        case "setInterval": case "setTimeout": case "clearInterval": case "updateAfterEvent":
        case "trace": case "ASSetPropFlags": case "getURL": return undefined;
        default: return undefined;
      }
    },
    callMethod(obj, key, args) {
      if (obj == null || key === undefined) return undefined;
      // EventDispatcher (generic, host-managed so add/dispatch stay consistent)
      if (key === "addEventListener") { const t = String(args[0]); const L = listenersOf(obj); L[t] = [...(L[t] || []), args[1]]; return undefined; }
      if (key === "removeEventListener") return undefined;
      if (key === "dispatchEvent") { const ev = args[0]; const t = String(ev?.type ?? ""); for (const l of listenersOf(obj)[t] || []) invoke(l, [ev], obj); return undefined; }
      if (key === "addProperty") { (obj.__accessors ??= Object.create(null))[String(args[0])] = { get: args[1], set: args[2] }; return true; }
      // XML object: fetch + parse, then fire onLoad and re-render.
      if (obj.__xml) {
        if (key === "load") {
          bridge.fetchText(String(args[0]), (text) => {
            const doc = text != null ? parseXmlDom(text) : null;
            obj.firstChild = doc; obj.childNodes = doc?.childNodes; obj.loaded = true;
            const cb = obj.onLoad ?? obj.props?.onLoad;
            if (cb) invoke(cb, [true], obj);
            bridge.render();
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
      if (Array.isArray(obj)) { const m = (obj as any)[key]; return typeof m === "function" ? m.apply(obj, args) : undefined; }
      if (key === "registerClass") { registry[String(args[0])] = args[1]; return true; }
      // clip natives
      if (isClip(obj)) {
        switch (key) {
          case "attachMovie": { const c = bridge.attachMovie(obj, String(args[0]), String(args[1]), Number(args[2] ?? bridge.nextDepth(obj))); if (c) { const cls = classFor(c); if (cls) invoke(cls, [], c); } return c ?? Object.create(null); }
          case "createEmptyMovieClip": return bridge.createEmptyMovieClip(obj, String(args[0]), Number(args[1] ?? bridge.nextDepth(obj)));
          case "createTextField": return bridge.createEmptyMovieClip(obj, String(args[0]), Number(args[2] ?? bridge.nextDepth(obj)));
          case "getNextHighestDepth": return bridge.nextDepth(obj);
          case "getBytesLoaded": case "getBytesTotal": return 100;
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
  globals.Object = { __obj: true };
  globals._global = globals;

  // 1) class registrations (#initclip): build _global.* classes + the linkage registry.
  // Run the #initclip programs: build the _global class tree + the linkage registry.
  for (const prog of initActions) {
    try { vm.callFunction({ __avm1fn: true, params: [], body: prog, registerCount: 256, flags: 0 } as any, [], root); } catch { /* skip a bad init program */ }
  }
  // tag the mx/* framework + xfactorstudio classes with their fully-qualified name.
  const tagFqn = (o: any, prefix: string, depth = 0) => { if (!o || typeof o !== "object" || depth > 7) return; for (const k of Object.keys(o)) { const v: any = o[k]; if (v && typeof v === "object") { if (isFn(v) && !(v as any).__fqn) (v as any).__fqn = prefix ? prefix + "." + k : k; tagFqn(v, prefix ? prefix + "." + k : k, depth + 1); } } };
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
