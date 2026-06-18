import type {
  AssetTimeline,
  BodyStatement,
  ButtonActionRecord,
  ControlAction,
  DefinedFunction,
  TimelineAsset,
  TimelineFrame,
} from "../data/timelineTypes";
import type { DomRenderer } from "../render/DomRenderer";
import { isLocalVar, localizeCondition, splitTopLevelArgs } from "./avm1";
import { buttonNode, findChildByName, isClipAsset, spriteNode, visualSrc } from "./renderNodes";
import { ClipInstance } from "./ClipInstance";
import { evalCondition } from "./conditions";
import { IDENTITY, multiplyMatrix } from "./matrix";
import { Ticker } from "./Ticker";
import { clamp, type RenderNode } from "./types";
import { normalizeVarName } from "./VariableStore";
import type { VariableStore, VarValue } from "./VariableStore";

export type ButtonEvent = "rollOver" | "rollOut" | "press" | "release";

/** A user-defined AVM1 function: gated self-timeline actions (frameActions) plus a
 *  branch-aware body (assignments + method-calls), parameterised by `parameters`. */
type FunctionDef = {
  parameters: string[];
  actions: ControlAction[];
  body: BodyStatement[];
};

/** Local parameter bindings for the currently-executing function call. */
type Locals = Record<string, VarValue | undefined>;

/** Timeline commands that, with a target, are clip controls (vs function calls). */
const TIMELINE_COMMANDS = new Set(["gotoAndPlay", "gotoAndStop", "play", "stop", "nextFrame", "prevFrame"]);
/** AVM1 "wait until condition / timer" helpers handled as a runtime primitive. */
const WAITER_FUNCTIONS = new Set(["waitForVal", "startTimer"]);

export type PlayerOptions = {
  onFrame?: (rootFrame: number, playing: boolean) => void;
  onNavigate?: (action: ControlAction) => void;
  onSound?: (action: ControlAction) => void;
  /** Shared tour variable store (seeded from control.globalDefaults). */
  store?: VariableStore;
  /** Dispatch a function call whose target is another level (`_levelN[.path].fn`). */
  onCallFunction?: (target: string, name: string, args: string) => void;
  /** Run a timeline command (gotoAndPlay/Stop) on a named clip in another level
   *  (e.g. `_level6.yellowPro.gotoAndPlay("over")` — the nav's section highlight). */
  onClipCommand?: (target: string, command: string, frame: VarValue) => void;
  /** Register an AVM1 waiter (`waitForVal`/`startTimer`) whose callback the host polls. */
  onWaiter?: (kind: string, args: (VarValue | undefined)[]) => void;
  /** Load a `loadVariables` text file (`&key=value&…`) into this level's text vars. */
  onLoadVariables?: (action: ControlAction) => void;
  /** Whether the current voice-over segment has finished (drives VO-gated holds). */
  isVoiceDone?: () => boolean;
  /** Frame to start at. Overrides `timeline.entryFrame` — a movie LOADED via loadMovieNum
   *  must start at 0 to run its gating logic; entryFrame is only the standalone preview frame. */
  startFrame?: number;
};

const ROOT_ID = -1;
const MAX_GOTO_DEPTH = 24;
/** A root `gotoAndPlay(self, current-N)` with N ≤ this is a voice-over hold-loop
 *  (`if(!sndDonePlaying())…`); a larger backward jump is a section/end loop. */
const VO_HOLD_DELTA = 3;
const ZERO_ORIGIN = { x: 0, y: 0, width: 0, height: 0 };

/**
 * A focused AVM1 display-list runtime. The root timeline and every sprite become
 * ClipInstances with independent playheads; each clip's frame scripts run on
 * entry (stop/play/gotoAndPlay/Stop) with self/_parent/_root resolution. Each
 * frame the tree is flattened to stage-space RenderNodes (matrices composed
 * down), so a sprite plays its own animation and `_root.gotoAndPlay("robust")`
 * drives the root into the section — matching Flash/Ruffle.
 */
export class Player {
  private readonly timeline: AssetTimeline;
  private readonly renderer: DomRenderer;
  private readonly options: PlayerOptions;
  private readonly ticker: Ticker;

  private readonly assets: Record<string, TimelineAsset>;
  private readonly rootFrames: TimelineFrame[];
  private readonly startFrame: number;

  private readonly rootStop: Set<number>;
  private readonly rootActions = new Map<number, ControlAction[]>();
  private readonly spriteActions = new Map<string, ControlAction[]>();
  private readonly spriteStop = new Map<number, Set<number>>();
  private readonly functions = new Map<string, FunctionDef>();
  /** Sprite-scoped functions (e.g. a button/fade clip's `doFade`), by characterId → name. */
  private readonly spriteFunctions = new Map<number, Map<string, FunctionDef>>();
  private readonly store?: VariableStore;
  /** Text-field variables loaded via loadVariables() (key → value), keyed by the
   *  field's normalized variableName (e.g. `skipIntro`, `h_Segment4`). */
  private readonly textVars = new Map<string, string>();
  /** Normalized variable names that back a dynamic text field, so a frame-script
   *  assignment to one (e.g. the music control's `t_music = _parent.t_musicOn`) is
   *  mirrored into textVars and the bound field re-renders with the new value. */
  private readonly boundTextVars = new Set<string>();
  /** A playVO fired and the next 1-frame hold-loop should wait for it (sndDonePlaying). */
  private voWaiting = false;

  private root: ClipInstance;
  private clipByPath = new Map<string, ClipInstance>();
  private lastNodes: RenderNode[] = [];

  constructor(timeline: AssetTimeline, renderer: DomRenderer, options: PlayerOptions = {}) {
    this.timeline = timeline;
    this.renderer = renderer;
    this.options = options;
    this.assets = timeline.assets ?? {};
    // Collect every dynamic-text field's bound variable name (from the asset's own
    // text binding and any dynamicTexts override) so frame-script assignments to one
    // refresh the displayed field — see the setVariable handler in runScript.
    for (const asset of Object.values(this.assets)) {
      const vn = (asset as TimelineAsset | undefined)?.text?.normalizedVariableName;
      if (vn) this.boundTextVars.add(normalizeVarName(vn));
    }
    for (const dyn of Object.values(timeline.control?.dynamicTexts ?? {})) {
      const vn = (dyn as { normalizedVariableName?: string } | undefined)?.normalizedVariableName;
      if (vn) this.boundTextVars.add(normalizeVarName(vn));
    }
    this.rootFrames = timeline.frames ?? [];
    this.rootStop = new Set(timeline.control?.stopFrames ?? []);
    this.startFrame = clamp(options.startFrame ?? timeline.entryFrame ?? 0, 0, Math.max(0, this.rootFrames.length - 1));

    // Root frame scripts: array of {frame, actions[]}. Keep timeline + branch
    // (if/else) actions; function-context actions belong to the function table.
    for (const record of timeline.control?.frameActions ?? []) {
      const actions = (record.actions ?? []).filter((a) => !a.executionContext || a.executionContext === "timeline" || a.executionContext === "branch");
      if (actions.length) this.rootActions.set(record.frame, [...(this.rootActions.get(record.frame) ?? []), ...actions]);
    }
    // Per-sprite frame scripts: flat list of {spriteId, frame, actions[]}.
    for (const record of (timeline.control?.spriteActions ?? []) as Array<{ spriteId?: number; frame?: number; actions?: ControlAction[] }>) {
      if (typeof record.spriteId !== "number" || typeof record.frame !== "number") continue;
      const actions = (record.actions ?? []).filter((a) => !a.executionContext || a.executionContext === "timeline" || a.executionContext === "branch");
      if (!actions.length) continue;
      const key = `${record.spriteId}:${record.frame}`;
      this.spriteActions.set(key, [...(this.spriteActions.get(key) ?? []), ...actions]);
    }

    this.store = options.store;
    this.buildFunctionTable();

    this.ticker = new Ticker(timeline.fps || 20, () => this.onTick());
    this.root = this.buildRoot(this.startFrame);
    this.primeAmbientSound();
    this.render();
  }

  get frameCount(): number {
    return Math.max(1, this.rootFrames.length);
  }

  get currentFrame(): number {
    return this.root.currentFrame;
  }

  /** Root clip instance — used by the host to resolve named clips for cross-level commands. */
  get rootClip(): ClipInstance {
    return this.root;
  }

  get isPlaying(): boolean {
    return this.ticker.isPlaying;
  }

  currentLabel(): string {
    const frame = this.rootFrames[this.root.currentFrame];
    if (frame?.label) return frame.label;
    const labels = this.timeline.labels ?? {};
    return Object.entries(labels).find(([, index]) => index === this.root.currentFrame)?.[0] ?? "";
  }

  debugNodes(): RenderNode[] {
    return this.lastNodes;
  }

  play() {
    this.ticker.play();
  }

  pause() {
    this.ticker.pause();
  }

  toggle() {
    if (this.ticker.isPlaying) this.pause();
    else this.play();
  }

  seekRootFrame(frame: number) {
    this.ticker.pause();
    this.voWaiting = false;
    this.root = this.buildRoot(clamp(frame, 0, this.frameCount - 1));
    this.render();
    this.options.onFrame?.(this.root.currentFrame, false);
  }

  restart() {
    this.seekRootFrame(this.startFrame);
    this.primeAmbientSound();
  }

  destroy() {
    this.ticker.destroy();
    this.renderer.clear();
  }

  /** Dispatch a button event from the owning clip (identified by its tree path). */
  handleButtonEvent(ownerPath: string, characterId: number, event: ButtonEvent) {
    const record = this.timeline.control?.buttonActions?.[String(characterId)] as ButtonActionRecord | undefined;
    const action = record?.[event];
    if (!action) return;
    const owner = this.clipByPath.get(ownerPath) ?? this.root;

    // Apply the handler's simple state assignments first: clip‑local flags (a section icon's
    // `isActive = 1;`, `_parent.holdState = 1;`) drive the select/deselect calls below, and the
    // shared‑global `_level0.bkgd.*` flags drive cross‑movie gating — notably the restart button's
    // `_level0.bkgd.doAttractLoop = 1`, which keeps the reloaded segment BLANK when returning to the
    // menu (without it the old segment's content paints over the nav menu). `_level0` is the shared
    // store, so it reaches the segment's player. Only OTHER levels' player vars (`_level6.nav.*`)
    // are skipped — those belong to the build's navigation inference, not this dispatch.
    for (const assign of action.assignments ?? []) {
      if (/^_level[1-9]\d*\b/i.test(assign.target)) continue;
      const value = this.resolveExpr(assign.rawValue ?? String(assign.value ?? ""));
      if (assign.target && value !== undefined) this.scopeSet(owner, assign.target, value);
    }

    // A section button's on(release) is extracted as BOTH a top-level timeline command
    // (`gotoAndPlay <label>`) AND the SAME call inside functionCalls (`_parent.gotoAndPlay(<label>)`).
    // Running both double-navigates: the functionCall enters the destination frame (its `stop()`
    // fires → playing=false), then the command re-enters the SAME frame — but `enterFrame`
    // early-returns on re-entry, so the freshly-set `playing=true` is never cleared by the
    // destination's `stop()`, and the clip advances one frame past the chosen section. Drop the
    // redundant local-timeline nav call so the navigation runs exactly once (via the command path,
    // which runs the destination's frame scripts). Cross-level / named-clip calls are never dropped.
    const isLocalTarget = (t?: string) =>
      !t || t === "self" || t === "this" || t === "_root" || t === "_level0" || t === "_parent";
    const duplicatesCommand = (call: NonNullable<ControlAction["functionCalls"]>[number]) => {
      if (call.functionName !== action.command || !isLocalTarget(call.target)) return false;
      const arg = (call.arguments ?? "").trim().replace(/^["']|["']$/g, "");
      if (action.label && arg === action.label) return true;
      const n = Number(arg);
      return typeof action.frame === "number" && Number.isFinite(n) && (n - 1 === action.frame || n === action.frame);
    };
    const isGoto = action.command === "gotoAndPlay" || action.command === "gotoAndStop";
    const calls = isGoto ? (action.functionCalls ?? []).filter((c) => !duplicatesCommand(c)) : action.functionCalls;
    if (calls?.length) this.runCallFunctions({ ...action, functionCalls: calls }, owner);
    if (action.command === "loadMovieNum" || action.command === "loadMovie") this.options.onNavigate?.(action);
    // A nav section button is an exit-navigation: it plays the nav's exit animation (the gotoAndPlay
    // below) AND loads the chosen segment into the content level. The SWF load is otherwise lost
    // because the command is gotoAndPlay (the exit), not loadMovie — so dispatch it explicitly. A
    // handler may request more than one load (e.g. a "restart the whole tour" button: segment1 into
    // the content level + an MS-logo overlay into a higher level), so honor every load, not just the
    // first. `action.loads` carries them when present; otherwise fall back to the single swf/level.
    if (action.command !== "loadMovieNum" && action.command !== "loadMovie") {
      const loads = action.loads?.length ? action.loads : action.swf ? [{ swf: action.swf, level: action.level }] : [];
      for (const load of loads) {
        this.options.onNavigate?.({ command: "loadMovie", swf: load.swf, level: load.level, reload: true });
      }
    }
    if (action.command === "gotoAndPlay" || action.command === "gotoAndStop") {
      const target = this.resolveTarget(owner, action.target);
      const frame = this.resolveFrame(action, target);
      if (target && frame >= 0) {
        target.playing = action.command === "gotoAndPlay";
        this.enterFrame(target, frame, 0);
      }
    }
    this.render();
  }

  // --- AVM1 function dispatch -------------------------------------------
  // The tour's inter-level orchestration (bring nav on stage, swap intro→menu,
  // pick the OS edition) lives in named AVM1 functions gated by `OSVersion`.
  // We reconstruct each function from the extracted data — its variable
  // `assignments` (definedFunctions) plus its gated timeline `actions`
  // (frameActions tagged with the same functionName) — and execute them against
  // a shared VariableStore, so behaviour comes from the SWF's own data, not
  // hard-coded scene logic.

  private buildFunctionTable() {
    const control = this.timeline.control as
      | { definedFunctions?: DefinedFunction[] | Record<string, DefinedFunction>; frameActions?: { actions?: ControlAction[] }[] }
      | undefined;
    const newDef = (): FunctionDef => ({ parameters: [], actions: [], body: [] });
    for (const def of Object.values(control?.definedFunctions ?? {})) {
      const name = def?.functionName;
      if (!name) continue;
      const entry = this.functions.get(name) ?? newDef();
      if (def.parameters?.length) entry.parameters = def.parameters;
      if (def.body?.length) entry.body.push(...def.body);
      this.functions.set(name, entry);
    }
    for (const record of control?.frameActions ?? []) {
      for (const action of record.actions ?? []) {
        if (!action.functionName) continue;
        const entry = this.functions.get(action.functionName) ?? newDef();
        entry.actions.push(action);
        this.functions.set(action.functionName, entry);
      }
    }
    // Sprite-scoped functions whose body is inner self-gotos + assigns (a control's over()/out()
    // label reveal `if(!musicOn)gotoAndPlay(28);else gotoAndPlay(5)`, or a toolbar button's
    // hideMe `if(btnDown){labelHidden=1;gotoAndPlay(36)}`). Each body statement carries its if/else
    // guard, so it becomes a branch-gated action; callClipFunction runs it against the clip's scope.
    for (const def of Object.values(control?.definedFunctions ?? {}) as DefinedFunction[]) {
      if (def.scope !== "sprite" || typeof def.spriteId !== "number" || !def.functionName) continue;
      const usable = (def.body ?? []).filter((s) =>
        (s.kind === "call" && Boolean(s.functionName?.startsWith("gotoAnd")) && (!s.target || s.target === "self" || s.target === "this"))
        || (s.kind === "assign" && isLocalVar(s.target)));
      if (!usable.length) continue;
      let fns = this.spriteFunctions.get(def.spriteId);
      if (!fns) this.spriteFunctions.set(def.spriteId, (fns = new Map()));
      const entry = fns.get(def.functionName) ?? newDef();
      for (const s of usable) {
        if (s.kind === "assign") {
          entry.actions.push({ command: "setVariable", target: s.target, value: s.value, rawValue: s.rawValue, functionBranchCondition: s.branchCondition });
          continue;
        }
        const arg = (s.arguments ?? "").trim();
        const num = Number(arg);
        entry.actions.push({
          command: s.functionName as ControlAction["command"],
          target: "self",
          ...(Number.isFinite(num) && arg !== "" ? { frame: num - 1 } : { label: arg.replace(/^["']|["']$/g, "") }),
          ...(s.branchCondition ? { functionBranchCondition: s.branchCondition } : {}),
        });
      }
      fns.set(def.functionName, entry);
    }
    // Sprite-scoped functions (doFade etc.) from each sprite's tagged actions, so a
    // `tellTarget("clip"){ doFade() }` can run the clip's own function.
    const spriteRecords = (this.timeline.control?.spriteActions ?? []) as Array<{ spriteId?: number; actions?: ControlAction[] }>;
    for (const record of spriteRecords) {
      if (typeof record.spriteId !== "number") continue;
      for (const action of record.actions ?? []) {
        if (!action.functionName) continue;
        let fns = this.spriteFunctions.get(record.spriteId);
        if (!fns) this.spriteFunctions.set(record.spriteId, (fns = new Map()));
        const entry = fns.get(action.functionName) ?? newDef();
        entry.actions.push(action);
        fns.set(action.functionName, entry);
      }
    }
  }

  hasFunction(name: string): boolean {
    return this.functions.has(name);
  }

  /**
   * Invoke a named AVM1 function. Arguments (a raw `"a",b,…` string) bind to the
   * function's parameters as locals; its self-timeline actions (gated gotos) run
   * first, then its branch-aware body — assignments and method-calls each guarded
   * by their if/else condition. This is what drives the tour's orchestration:
   * `sceneStarting("BestForBusiness")` sets `currScene`, and `showSceneMenu()`
   * fires only the active section's `_level6.<button>.gotoAndPlay("over")`.
   */
  callFunction(name: string, argsRaw?: string, callerLocals?: Locals): boolean {
    const def = this.functions.get(name);
    if (!def) return false;
    const locals = this.bindParams(def.parameters, argsRaw, callerLocals);
    // The function's frame-tagged actions are an if/else chain (initMusic's per-section music,
    // startNavEntrance's Pro/Per goto). Decide them GROUP-WISE and localized — same semantics as
    // runScript/callClipFunction: a bare `else` arm evaluated alone reads as true
    // (evalCondition("else") === true) and would fire alongside the matched arm, and a condition on
    // a parameter (initMusic's `whichSection == …`, playVO's `!doRamp`) must resolve against the
    // call's locals. The old per-action evalCondition loop did neither.
    const actionFire = this.functionActionDecisions(def.actions, locals);
    def.actions.forEach((action, i) => { if (actionFire[i]) this.runFunctionAction(action); });
    // Decide every body guard against the store as it is on ENTRY — AVM1 checks an `if` once
    // when control reaches it, so a CONDITIONAL mutation inside a block (LoadInitialInteractive's
    // `if(!blnDisableSkip){ blnDisableSkip=1; … }`, whose nested arms all re-include the
    // `!blnDisableSkip` guard) must not retro-skip its own block. The one exception is an
    // UNCONDITIONAL simple-name assign earlier in the body, which a later `if` legitimately reads
    // (setSelect's `scene = currScene; if(scene=="BestForBusiness"){ yellowPro… }`) — overlay those
    // onto the guard locals so the highlight arm fires.
    const guardLocals: Locals = { ...locals };
    for (const statement of def.body) {
      if (!statement.branchCondition && statement.kind === "assign" && /^[A-Za-z_$][\w$]*$/.test(statement.target)) {
        guardLocals[statement.target] = this.resolveExpr(statement.rawValue, guardLocals);
      }
    }
    const decisions = def.body.map((statement) => this.branchPasses(statement.branchCondition, guardLocals));
    def.body.forEach((statement, i) => { if (decisions[i]) this.runBodyStatement(statement, locals); });
    this.render();
    return true;
  }

  /** Decide which of a function's frame-tagged actions fire, group-wise (cf. runScript). A run of
   *  consecutive actions carrying a `functionBranchCondition` is one if/else chain: a real-condition
   *  arm fires when its (parameter-localized) condition holds, and an `else` arm fires only when NO
   *  real arm in that group matched. Unconditional actions break the run and always fire. */
  private functionActionDecisions(actions: ControlAction[], locals: Locals): boolean[] {
    const fire = actions.map(() => true);
    if (!this.store) return fire;
    const isElse = (c: string | undefined) => c === "else";
    const passes = (c: string | undefined) => !c || this.evalGuard(localizeCondition(c, locals));
    for (let i = 0; i < actions.length; ) {
      if (!actions[i].functionBranchCondition) { i += 1; continue; }
      let j = i;
      while (j < actions.length && actions[j].functionBranchCondition) j += 1;
      const anyReal = actions.slice(i, j).some((a) => !isElse(a.functionBranchCondition) && passes(a.functionBranchCondition));
      for (let k = i; k < j; k += 1) {
        const cond = actions[k].functionBranchCondition;
        fire[k] = isElse(cond) ? !anyReal : passes(cond);
      }
      i = j;
    }
    return fire;
  }

  /** Bind a call's raw argument string to a function's parameter names. */
  private bindParams(parameters: string[], argsRaw?: string, callerLocals?: Locals): Locals {
    const locals: Locals = {};
    if (!parameters.length) return locals;
    const values = this.parseArgs(argsRaw, callerLocals);
    parameters.forEach((param, i) => { locals[param] = values[i]; });
    return locals;
  }

  /** Split a raw arg string on top-level commas and resolve each to a value. */
  private parseArgs(argsRaw: string | undefined, locals?: Locals): (VarValue | undefined)[] {
    return splitTopLevelArgs(argsRaw).map((p) => this.resolveExpr(p.trim(), locals));
  }

  /** Milliseconds since page start — AVM1 `getTimer()`. Absolute, so it's consistent
   *  across levels (the nav reads `bkgd.timeTarg` set by `_level0.setTimeMark`). */
  private getTimer(): number {
    return performance.now();
  }

  /** Resolve an assignment RHS / argument expression to a value (param refs → locals). */
  private resolveExpr(raw: string, locals?: Locals): VarValue | undefined {
    const e = raw.trim();
    if (e === "") return undefined;
    if (e === "getTimer()") return this.getTimer();
    if ((e.startsWith('"') && e.endsWith('"')) || (e.startsWith("'") && e.endsWith("'"))) return e.slice(1, -1);
    if (e === "true") return true;
    if (e === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
    if (locals && e in locals) return locals[e];
    // A bare identifier/path is a variable read (e.g. a flag), then a loadVariables()
    // text var (the music control's `_parent.t_musicOn`, which lives in textVars not the store).
    if (/^[A-Za-z_$][\w$.]*$/.test(e)) return this.store?.get(e) ?? this.textVars.get(normalizeVarName(e)) ?? undefined;
    return e; // array literals etc. — kept as their source text
  }

  /** Read a variable in a clip's scope: a clip-local timeline var first, else the shared store. */
  private scopeGet(clip: ClipInstance, name: string): VarValue | undefined {
    if (isLocalVar(name) && name in clip.locals) return clip.locals[name];
    return this.store?.get(name);
  }

  /** Write a variable in a clip's scope. A local var is kept on the clip (so each toolbar button
   *  has its own `btnDown`/`labelHidden`) AND mirrored to the store for any non-scoped reader. */
  private scopeSet(clip: ClipInstance, name: string, value: VarValue): void {
    if (isLocalVar(name)) clip.locals[name] = value;
    this.store?.set(name, value);
  }

  /** A store-shaped view that resolves clip-local vars first — pass to evalCondition for a clip. */
  private scopeFor(clip: ClipInstance): VariableStore {
    return {
      get: (name: string) => this.scopeGet(clip, name),
      set: (name: string, value: VarValue) => this.scopeSet(clip, name, value),
      has: (name: string) => (isLocalVar(name) && name in clip.locals) || (this.store?.has(name) ?? false),
    } as unknown as VariableStore;
  }

  /** Evaluate a branch guard, first resolving the AVM1 `timeMarkDone(inc)` timer
   *  (true once `inc` ms have elapsed since the last `setTimeMark` set `bkgd.timeTarg`).
   *  This is what holds the nav attract-loop cascade for AttractLoopWaitTime before it exits.
   *  Pass the clip whose script is running so guards on its local vars (e.g. a toolbar button's
   *  `btnDown`) resolve against that clip. */
  private evalGuard(condition: string | undefined, clip?: ClipInstance): boolean {
    if (!this.store) return !condition;
    if (!condition) return true;
    const resolved = condition.replace(/[\w.]*\btimeMarkDone\s*\(([^)]*)\)/g, (_m, arg: string) => {
      const inc = Number(this.resolveExpr(arg.trim()) ?? 0);
      const mark = Number(this.store?.get("bkgd.timeTarg") ?? 0);
      return this.getTimer() > mark + inc ? "1" : "0";
    });
    return evalCondition(resolved, clip ? this.scopeFor(clip) : this.store);
  }

  /** Re-serialise a call's arguments to a literal string for crossing a level boundary. */
  private resolveArgsString(argsRaw: string | undefined, locals?: Locals): string {
    return this.parseArgs(argsRaw, locals)
      .map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v)))
      .join(",");
  }

  /** Evaluate a body statement's if/else guard, substituting local parameters. */
  private branchPasses(condition: string | undefined, locals: Locals): boolean {
    if (!condition || !this.store) return condition ? false : true;
    return evalCondition(localizeCondition(condition, locals), this.store);
  }

  private runBodyStatement(statement: BodyStatement, locals: Locals) {
    if (statement.kind === "assign") {
      const value = this.resolveExpr(statement.rawValue, locals);
      if (this.store && value !== undefined) this.store.set(statement.target, value);
      return;
    }
    this.runBodyCall(statement, locals);
  }

  /** Dispatch a body call: a waiter, a clip command, or a (possibly cross-level) function call. */
  private runBodyCall(call: Extract<BodyStatement, { kind: "call" }>, locals: Locals) {
    const fn = call.functionName;
    const target = call.target;
    if (WAITER_FUNCTIONS.has(fn)) {
      this.options.onWaiter?.(fn, this.parseArgs(call.arguments, locals));
      return;
    }
    if (TIMELINE_COMMANDS.has(fn) && target) {
      const frame = this.parseArgs(call.arguments, locals)[0] ?? 0;
      if (/^_level\d+/i.test(target)) this.options.onClipCommand?.(target, fn, frame);
      else this.runNamedClipCommand(this.root, target, fn, frame);
      return;
    }
    if (!target || target === "self" || target === "this" || target === "_root" || target === "_level0") {
      this.callFunction(fn, call.arguments, locals);
    } else if (/^_level\d+/i.test(target)) {
      this.options.onCallFunction?.(target, fn, this.resolveArgsString(call.arguments, locals));
    } else {
      const clip = this.resolveTarget(this.root, target) ?? this.findClipByName(this.root, target);
      if (clip) this.callClipFunction(clip, fn);
    }
  }

  /** Run a timeline command on a clip resolved by name/path (e.g. `yellowPro.gotoAndPlay("over")`). */
  runNamedClipCommand(from: ClipInstance, path: string, command: string, frame: VarValue): boolean {
    const clip = this.resolveTarget(from, path) ?? this.findClipByName(from, path) ?? this.findClipByName(this.root, path);
    if (!clip) return false;
    const frameIndex = this.resolveClipFrame(clip, frame);
    if (frameIndex < 0) return false;
    clip.playing = command === "gotoAndPlay";
    this.enterFrame(clip, frameIndex, 0);
    this.render();
    return true;
  }

  /** Resolve a label or 1-based frame number against a clip's own timeline. */
  private resolveClipFrame(clip: ClipInstance, frame: VarValue): number {
    if (typeof frame === "number") return frame > 0 ? frame - 1 : 0;
    const frames = this.framesFor(clip);
    const byLabel = frames?.findIndex((f) => f.label === frame) ?? -1;
    if (byLabel >= 0) return byLabel;
    const n = Number(frame);
    return Number.isFinite(n) ? Math.max(0, n - 1) : -1;
  }

  private runFunctionAction(action: ControlAction) {
    switch (action.command) {
      case "stop":
        this.root.playing = false;
        break;
      case "play":
        this.root.playing = true;
        break;
      case "gotoAndPlay":
      case "gotoAndStop": {
        const target = this.resolveTarget(this.root, action.target);
        const frame = this.resolveFrame(action, target);
        if (target && frame >= 0) {
          target.playing = action.command === "gotoAndPlay";
          this.enterFrame(target, frame, 0);
        }
        break;
      }
      case "loadMovieNum":
      case "loadMovie":
        this.options.onNavigate?.(action);
        break;
      case "callFunctions":
        this.runCallFunctions(action);
        break;
      default:
        break;
    }
  }

  private runCallFunctions(action: ControlAction, clip: ClipInstance = this.root) {
    for (const call of action.functionCalls ?? []) {
      const target = call.target ?? "self";
      const fn = call.functionName;
      if (WAITER_FUNCTIONS.has(fn)) {
        this.options.onWaiter?.(fn, this.parseArgs(call.arguments));
      } else if (TIMELINE_COMMANDS.has(fn) && target !== "self" && target !== "this" && target !== "_root") {
        const frame = this.parseArgs(call.arguments)[0] ?? 0;
        if (/^_level\d+/i.test(target)) this.options.onClipCommand?.(target, fn, frame);
        else this.runNamedClipCommand(clip, target, fn, frame);
      } else if (target === "self" || target === "this" || target === "_root") {
        // Prefer a sprite-scoped function on the owning clip (a control's over()/out() label
        // reveal lives on its own sprite); fall back to a root/global function.
        if (target !== "_root" && this.spriteFunctions.get(clip.characterId)?.has(fn)) {
          this.callClipFunction(clip, fn);
        } else {
          this.callFunction(fn, call.arguments);
        }
      } else if (/^_level\d+/i.test(target)) {
        // Absolute level targets (`_level6`, `_level0.x`) are routed to the
        // controller, which maps the level back to its Player.
        this.options.onCallFunction?.(target, fn, this.resolveArgsString(call.arguments));
      } else {
        // A named nested clip (from `tellTarget("clip")`): resolve it locally and
        // run the clip's own sprite-scoped function (e.g. doFade → gotoAndPlay).
        const targetClip = this.resolveTarget(clip, target) ?? this.findClipByName(clip, target);
        if (targetClip) this.callClipFunction(targetClip, fn);
      }
    }
  }

  /** Run a sprite-scoped function (e.g. `doFade`) on a specific nested clip. */
  private callClipFunction(clip: ClipInstance, name: string) {
    const def = this.spriteFunctions.get(clip.characterId)?.get(name);
    if (!def) return;
    // Guards resolve against the CLIP's scope — a toolbar button's hideMe/showMe gate on its own
    // local `btnDown`/`labelHidden`, so hovering one button only hides the others' labels.
    const scope = this.scopeFor(clip);
    // An `else` arm fires only if NO real-condition arm in this function matched. The action list
    // is merged from the sprite's defined-function body AND its frame-tagged actions, so an
    // if/else pair can appear as a literal-`else` action alongside its `if`; evaluated in
    // isolation a bare `else` reads as true and would fire unconditionally — e.g. the music
    // control's over() runs `gotoAndPlay(28)` (slash, music-off) then its `else gotoAndPlay(5)`
    // (no slash) overrides it, so the mute icon never sticks. Decide `else` group-wise instead.
    const isElse = (c: string | undefined) => c === "else";
    const anyReal = def.actions.some((a) => a.functionBranchCondition && !isElse(a.functionBranchCondition) && evalCondition(a.functionBranchCondition, scope));
    // Decide every guard against the clip scope as it is on ENTRY — AVM1 evaluates an `if` once
    // when control reaches it. The build flattens an `if(g){ g-mutating-assign; goto }` block into
    // a (now unconditional) assign followed by the still-guarded goto, so checking the goto's guard
    // AFTER that assign runs would wrongly skip it (segment1's `unSelect` = `if(isActive){ isActive=0;
    // gotoAndPlay(68) }`: the icon's return-to-shelf goto never fires and the icons stack at the
    // replay slot). Snapshot the decisions first, then run.
    const fire = def.actions.map((action) => {
      const cond = action.functionBranchCondition;
      return isElse(cond) ? !anyReal : !cond || evalCondition(cond, scope);
    });
    for (let i = 0; i < def.actions.length; i += 1) {
      if (this.store && !fire[i]) continue;
      this.runClipAction(clip, def.actions[i]);
    }
    this.render();
  }

  private runClipAction(clip: ClipInstance, action: ControlAction) {
    switch (action.command) {
      case "stop":
        clip.playing = false;
        break;
      case "play":
        clip.playing = true;
        break;
      case "gotoAndPlay":
      case "gotoAndStop": {
        const target = !action.target || action.target === "self" || action.target === "this" ? clip : (this.resolveTarget(clip, action.target) ?? clip);
        const frame = this.resolveFrame(action, target);
        if (frame >= 0) {
          target.playing = action.command === "gotoAndPlay";
          this.enterFrame(target, frame, 0);
        }
        break;
      }
      case "callFunctions":
        this.runCallFunctions(action, clip);
        break;
      case "setVariable": {
        // A clip-function assignment (hideMe's `labelHidden = 1`) — into the clip's scope.
        const value = this.resolveExpr(action.rawValue ?? String(action.value ?? ""));
        if (action.target && value !== undefined) this.scopeSet(clip, action.target, value);
        break;
      }
      default:
        break;
    }
  }

  /** Depth-first search for a clip by instance name (tellTarget resolves a clip path). */
  private findClipByName(clip: ClipInstance, name: string): ClipInstance | null {
    for (const child of clip.childClips.values()) {
      if (child.name === name) return child;
      const found = this.findClipByName(child, name);
      if (found) return found;
    }
    return null;
  }

  // --- tree construction ------------------------------------------------

  private buildRoot(frame: number): ClipInstance {
    const root = new ClipInstance(ROOT_ID, "_root", null);
    this.enterFrame(root, frame, 0);
    return root;
  }

  // --- per-frame advance ------------------------------------------------

  private onTick() {
    this.tickClip(this.root);
    this.render();
    this.options.onFrame?.(this.root.currentFrame, this.ticker.isPlaying);
  }

  private tickClip(clip: ClipInstance) {
    const frameCount = this.frameCountFor(clip);
    if (clip.playing && frameCount > 1) {
      const next = clip.currentFrame + 1 >= frameCount ? 0 : clip.currentFrame + 1;
      this.enterFrame(clip, next, 0);
    } else if (clip.enteredFrame < 0) {
      this.enterFrame(clip, clip.currentFrame, 0);
    }
    for (const child of clip.childClips.values()) this.tickClip(child);
  }

  /** Move a clip to a frame: reconcile children, then run the frame's entry scripts.
   *  stop() is a frame-entry script, so it (and the stop-frame pin) only apply when a
   *  frame is NEWLY entered — re-issuing gotoAndPlay to the current frame resumes
   *  playback (this is what makes a button's rollOver "gotoAndPlay(currentFrame)"
   *  expand the clip instead of immediately re-stopping it). */
  private enterFrame(clip: ClipInstance, frame: number, depth: number) {
    clip.currentFrame = clamp(frame, 0, Math.max(0, this.frameCountFor(clip) - 1));
    this.reconcile(clip);

    if (clip.enteredFrame === clip.currentFrame) return;
    clip.enteredFrame = clip.currentFrame;
    if (this.stopFramesFor(clip).has(clip.currentFrame)) clip.playing = false;
    if (depth < MAX_GOTO_DEPTH) this.runScript(clip, depth);
  }

  /** Create/prune child clips for the clip's current frame. */
  private reconcile(clip: ClipInstance) {
    const frames = this.framesFor(clip);
    if (!frames) return; // leaf-rendered sprite (baked frames only) — no children
    const instances = frames[clip.currentFrame]?.instances ?? [];

    const live = new Set<number>();
    for (const instance of instances) {
      const asset = this.getAsset(instance.characterId);
      if (!asset || !isClipAsset(asset)) continue;
      live.add(instance.depth);
      const existing = clip.childClips.get(instance.depth);
      if (!existing || existing.characterId !== instance.characterId) {
        const child = new ClipInstance(instance.characterId, instance.name, clip);
        clip.childClips.set(instance.depth, child);
        this.enterFrame(child, 0, 0);
      } else if (instance.name && existing.name !== instance.name) {
        // A later PlaceObject named this instance (FFDec emits the name on a frame
        // after its first placement, e.g. nav's btn_yellow_pro_anim ring) — apply it
        // so `_parent.<name>` clip commands (the hover-glow) can resolve it.
        existing.name = instance.name;
      }
    }
    for (const [depth] of clip.childClips) {
      if (!live.has(depth)) clip.childClips.delete(depth);
    }
  }

  private runScript(clip: ClipInstance, depth: number) {
    const actions = this.actionsFor(clip);
    // Inline frame scripts mix unconditional (timeline) actions with the arms of if/else
    // chains (branch). Decide each branch arm GROUP-WISE rather than by adjacency: within a
    // run of consecutive branch actions, an arm with a real condition fires when that
    // condition holds, and an `else` arm fires only when NO real arm in the group matched.
    // (Order-independent — the build can emit the `else` arm before its `if`, e.g. segment4's
    // `if(doAttractLoop==1) doAttractLoop=0; else gotoAndPlay(11)` extracts the goto first.)
    const fire = actions.map(() => true);
    for (let i = 0; i < actions.length; ) {
      if (actions[i].executionContext !== "branch") { i += 1; continue; }
      let j = i;
      while (j < actions.length && actions[j].executionContext === "branch") j += 1;
      const isElse = (a: ControlAction) => !a.branchCondition || a.branchCondition === "else";
      const anyReal = actions.slice(i, j).some((a) => !isElse(a) && this.evalGuard(a.branchCondition, clip));
      for (let k = i; k < j; k += 1) {
        fire[k] = isElse(actions[k]) ? !anyReal : this.evalGuard(actions[k].branchCondition, clip);
      }
      i = j;
    }
    for (let idx = 0; idx < actions.length; idx += 1) {
      if (!fire[idx]) continue;
      const action = actions[idx];
      switch (action.command) {
        case "stop":
          clip.playing = false;
          break;
        case "play":
          clip.playing = true;
          break;
        case "gotoAndPlay":
        case "gotoAndStop": {
          // A cross-level timeline command (`_level4.gotoAndPlay("segStart")` — the attract loop
          // telling the loaded segment to play its content) routes through the controller to that
          // level's player. (_level0 stays local: it's the shared-global alias for this root.)
          if (action.target && /^_level[1-9]\d*\b/i.test(action.target)) {
            this.options.onClipCommand?.(action.target, action.command, action.label ?? action.frame ?? 0);
            break;
          }
          const target = this.resolveTarget(clip, action.target);
          const frame = this.resolveFrame(action, target);
          if (!target || frame < 0) break;
          // A 1-frame self-loop GATED BY sndDonePlaying is a VO hold
          // (`if(!sndDonePlaying())gotoAndPlay(prev)`): keep looping until the VO finishes,
          // then skip the jump so playback advances to the next narrated beat. This drives BOTH
          // the intro/root narration AND a section's demo content clip (e.g. segment5's
          // mc_StartMenu plays a beat, holds for its VO, then continues) — so the loop is
          // released for any clip looping on itself, not just the root. An UNCONDITIONAL
          // `gotoAndPlay(_currentframe-1)` is a structural hold (the nav's toolbar/loading
          // wait that polls nav.setSelect) and a `timeMarkDone` loop is a timer hold — neither
          // is a VO hold, so the VO release must NOT skip them (else the nav skips its toolbar
          // state and the section highlight/restart button never appear).
          const isVoHold = action.branchCondition?.includes("sndDonePlaying");
          if (isVoHold && action.command === "gotoAndPlay" && target === clip && frame < clip.currentFrame) {
            const delta = clip.currentFrame - frame;
            const voiceDone = this.options.isVoiceDone?.() ?? true;
            // Root keeps its proven intro pacing: release only once the beat's VO is started
            // and finished. A nested content demo (mc_StartMenu…) has SEVERAL holds per VO
            // segment, so a later hold sees no pending VO (voWaiting already consumed) — there
            // `sndDonePlaying()` is true, so it must advance rather than loop forever.
            const release = (this.voWaiting && voiceDone) || (clip !== this.root && !this.voWaiting);
            if (delta <= VO_HOLD_DELTA && release) {
              this.voWaiting = false;
              break;
            }
          }
          target.playing = action.command === "gotoAndPlay";
          if (target !== clip || frame !== clip.currentFrame) this.enterFrame(target, frame, depth + 1);
          break;
        }
        case "attachSound":
        case "playVO":
        case "stopSound":
          // A new voice-over starts a narrated beat the upcoming hold-loop waits on.
          if (action.command === "playVO") this.voWaiting = true;
          this.options.onSound?.(action);
          break;
        case "loadMovieNum":
        case "loadMovie":
          this.options.onNavigate?.(action);
          break;
        case "doRelease":
          // The nav's `doRelease("segmentN.swf")` (a frame action on the click/exit path) =
          // load that segment fresh into the content level, like the on-click navigation.
          if (action.swf) this.options.onNavigate?.({ command: "loadMovie", swf: action.swf, level: action.level, reload: true });
          break;
        case "loadVariables":
          this.options.onLoadVariables?.(action);
          break;
        case "callFunctions":
          this.runCallFunctions(action, clip);
          break;
        case "setVariable": {
          // A frame-script `target = value` assignment — into the clip's scope so a bare
          // timeline var (a toolbar button's `btnDown`/`labelHidden`) stays local to it, while
          // a dotted flag (`nav.bln_CoreNavLoaded = 1`) the orchestration polls goes to the store.
          const value = this.resolveExpr(action.rawValue ?? String(action.value ?? ""));
          if (this.store && action.target && value !== undefined) {
            this.scopeSet(clip, action.target, value);
            // If the assigned variable backs a dynamic text field, mirror it into the display
            // cache the field reads (the music control's `t_music` status label flips to its
            // toggled value; loadVariables-bound fields otherwise only show their loaded text).
            const norm = normalizeVarName(action.target);
            if (this.boundTextVars.has(norm)) this.textVars.set(norm, String(value));
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // --- target / frame resolution ---------------------------------------

  private resolveTarget(clip: ClipInstance, target: string | undefined): ClipInstance | null {
    if (!target || target === "self" || target === "this") return clip;
    if (target === "_root" || target === "_level0" || target === "root") return this.root;
    if (target === "_parent") return clip.parent ?? clip;

    // Dotted path like "_root.s1.mc" — walk by instance name.
    const parts = target.split(".").filter(Boolean);
    let node: ClipInstance | null =
      parts[0] === "_root" || parts[0] === "_level0" ? this.root : parts[0] === "_parent" ? clip.parent : clip;
    const rest = parts[0]?.startsWith("_") ? parts.slice(1) : parts;
    for (const name of rest) {
      if (!node) return null;
      node = findChildByName(node, name);
    }
    return node;
  }


  private resolveFrame(action: ControlAction, target: ClipInstance | null): number {
    if (action.label) {
      // Sprite-local label first, then root labels.
      const localFrames = target ? this.framesFor(target) : null;
      const local = localFrames?.findIndex((f) => f.label === action.label) ?? -1;
      if (local >= 0) return local;
      const labels = this.timeline.labels ?? {};
      if (action.label in labels) return labels[action.label];
    }
    if (typeof action.frame === "number") return action.frame;
    // Relative self-jump like `gotoAndPlay(_currentframe - 1)` (the attract-loop hold).
    const rel = action.frameExpression?.match(/^_currentframe\s*([+-])\s*(\d+)$/);
    if (rel && target) {
      const delta = Number(rel[2]) * (rel[1] === "-" ? -1 : 1);
      return clamp(target.currentFrame + delta, 0, Math.max(0, this.frameCountFor(target) - 1));
    }
    return -1;
  }

  // --- timeline data helpers -------------------------------------------

  private framesFor(clip: ClipInstance): TimelineFrame[] | null {
    if (clip.characterId === ROOT_ID) return this.rootFrames;
    return this.assets[String(clip.characterId)]?.timeline ?? null;
  }

  private frameCountFor(clip: ClipInstance): number {
    if (clip.characterId === ROOT_ID) return Math.max(1, this.rootFrames.length);
    const asset = this.assets[String(clip.characterId)];
    return Math.max(1, asset?.timeline?.length ?? asset?.frames?.length ?? 1);
  }

  private stopFramesFor(clip: ClipInstance): Set<number> {
    if (clip.characterId === ROOT_ID) return this.rootStop;
    let set = this.spriteStop.get(clip.characterId);
    if (!set) {
      set = new Set(this.timeline.control?.spriteStopFrames?.[String(clip.characterId)] ?? []);
      this.spriteStop.set(clip.characterId, set);
    }
    return set;
  }

  private actionsFor(clip: ClipInstance): ControlAction[] {
    if (clip.characterId === ROOT_ID) return this.rootActions.get(clip.currentFrame) ?? [];
    return this.spriteActions.get(`${clip.characterId}:${clip.currentFrame}`) ?? [];
  }


  /** Resolve a placed character; buttons are stored under a `button:<id>` key. */
  private getAsset(characterId: number): TimelineAsset | undefined {
    return this.assets[String(characterId)] ?? this.assets[`button:${characterId}`];
  }

  // --- render (flatten tree to stage-space nodes) ----------------------

  private render() {
    const nodes: RenderNode[] = [];
    this.clipByPath = new Map();
    this.clipByPath.set("0", this.root);
    this.flatten(this.root, IDENTITY, 1, "0", { n: 0 }, nodes);
    this.renderer.apply(nodes);
    this.lastNodes = nodes;
  }

  private flatten(
    clip: ClipInstance,
    world: RenderNode["matrix"],
    worldOpacity: number,
    path: string,
    order: { n: number },
    out: RenderNode[],
  ) {
    const frames = this.framesFor(clip);
    if (!frames) return;
    const frame = frames[clip.currentFrame];
    if (!frame) return;

    // Active masks (SWF clipDepth): a mask collects the instances at depths it
    // clips, and is emitted as one alpha-masked SVG group once its range ends.
    const maskStack: Array<{ key: string; order: number; clipDepth: number; group: NonNullable<RenderNode["maskGroup"]> }> = [];
    const flushMasks = (depth: number) => {
      while (maskStack.length && depth > maskStack[maskStack.length - 1].clipDepth) {
        const mask = maskStack.pop()!;
        out.push({ key: mask.key, order: mask.order, characterId: 0, kind: "shape", name: "", src: "", origin: ZERO_ORIGIN, matrix: world, opacity: 1, maskGroup: mask.group });
      }
    };

    for (const instance of frame.instances) {
      flushMasks(instance.depth);
      const asset = this.getAsset(instance.characterId);
      if (!asset) continue;
      const matrix = multiplyMatrix(world, instance.matrix);
      const opacity = worldOpacity * instance.opacity;
      const key = `${path}/${instance.depth}`;
      const child = clip.childClips.get(instance.depth);

      // A mask: capture its shape, then clip the instances below it (up to clipDepth).
      if (instance.clipDepth) {
        const src = visualSrc(asset, child);
        if (src) {
          maskStack.push({
            key: `${key}#mask`,
            order: order.n++,
            clipDepth: instance.clipDepth,
            group: { mask: { characterId: asset.id, src, origin: asset.origin, matrix, opacity: 1 }, items: [] },
          });
        }
        continue;
      }

      // Inside an active mask → collect the instance as a masked item, not a normal node.
      const activeMask = maskStack[maskStack.length - 1];
      if (activeMask && instance.depth <= activeMask.clipDepth) {
        const src = visualSrc(asset, child);
        if (src) activeMask.group.items.push({ characterId: asset.id, src, origin: asset.origin, matrix, opacity });
        continue;
      }

      // Sprite with baked frames → render the composited frame for visual fidelity
      // (FFDec bakes masks/group-alpha the nested leaves would lose), and overlay
      // transparent button hit areas from its nested timeline so it stays
      // interactive and its frame scripts still run (logic lives in the tree).
      if (asset.kind === "sprite" && asset.frames?.length && !asset.overflowsBounds) {
        const frameIndex = child ? clamp(child.currentFrame, 0, asset.frames.length - 1) : 0;
        out.push(spriteNode(key, order.n++, asset, asset.frames[frameIndex], matrix, opacity, instance, child?.currentFrame));
        if (child && asset.timeline?.length) this.collectButtons(child, matrix, key, order, out);
        continue;
      }

      // Sprite whose animated content slides outside its baked-frame bounds (e.g. the nav
      // cascade buttons), or a sprite with only a nested timeline (no baked frames) →
      // render from the display-list tree so the moving content isn't clipped/dropped.
      if (asset.kind === "sprite" && asset.timeline?.length && child && child.characterId === asset.id) {
        this.clipByPath.set(key, child);
        this.flatten(child, matrix, opacity, key, order, out);
        continue;
      }

      if (asset.kind === "button") {
        // Tree path: no baked frame behind the button, so render its up-state artwork (its
        // icon). The build strips any embedded editText glyphs from that art (FFDec bakes
        // them clipped/mispositioned), so the live field value is drawn by collectButtonText
        // on top — giving the icon AND the correct label (e.g. segment5's Replay button).
        out.push(buttonNode(key, order.n++, asset, matrix, instance, path, true, opacity));
        this.collectButtonText(asset, matrix, key, order, out, instance);
        continue;
      }

      out.push(this.leafNode(key, order.n++, asset, asset.src ?? "", matrix, opacity, instance));
    }
    flushMasks(Number.POSITIVE_INFINITY);
  }


  /**
   * Overlay interactive/dynamic leaves living inside a baked sprite: transparent
   * button hit areas, and dynamic text fields bound to a loadVariables() variable
   * (those are baked EMPTY in the sprite frame, so we draw them on top — e.g. the
   * nav's "Skip Intro" and "Best for Business" headings).
   */
  private collectButtons(clip: ClipInstance, world: RenderNode["matrix"], path: string, order: { n: number }, out: RenderNode[]) {
    this.clipByPath.set(path, clip);
    const frames = this.framesFor(clip);
    if (!frames) return;
    const frame = frames[clip.currentFrame];
    if (!frame) return;

    for (const instance of frame.instances) {
      if (instance.clipDepth) continue; // a mask shape — not an overlay leaf
      const asset = this.getAsset(instance.characterId);
      if (!asset) continue;
      const matrix = multiplyMatrix(world, instance.matrix);
      const key = `${path}/${instance.depth}`;
      if (asset.kind === "button") {
        // Baked path: the button's visual is in the composited frame — just a hit area.
        out.push(buttonNode(key, order.n++, asset, matrix, instance, path, false));
        this.collectButtonText(asset, matrix, key, order, out, instance);
      } else if (asset.kind === "text") {
        // editText is stripped from the baked sprite frame (FFDec bakes it mispositioned),
        // so re-draw it here at its own bounds: a loadVariables()-bound field once its value
        // loads, or a static field (e.g. the "Best for Business" nav title) from its own text.
        const field = this.resolveTextField(asset.id, asset);
        const show = field?.normalizedVariableName
          ? this.textVars.has(field.normalizedVariableName)
          : Boolean(field?.text && String(field.text).trim());
        if (show) {
          out.push(this.leafNode(key, order.n++, asset, asset.src ?? "", matrix, instance.opacity, instance));
        }
      } else if (asset.kind === "sprite") {
        const child = clip.childClips.get(instance.depth);
        if (child) this.collectButtons(child, matrix, key, order, out);
      }
    }
  }



  /**
   * Overlay a button's embedded dynamic editText (e.g. the nav "Skip Intro" button's
   * settled state). FFDec bakes such fields at the field registration — mispositioned —
   * and leaves the composited sprite frame's button empty, so we draw the live
   * loadVariables() value on top using the field's own bounds. The field's button-record
   * matrix composed with the button's instance matrix lands at the same spot the
   * standalone fade-in field used, so "Skip Intro" stays put once it settles.
   */
  private collectButtonText(
    asset: TimelineAsset,
    buttonMatrix: RenderNode["matrix"],
    key: string,
    order: { n: number },
    out: RenderNode[],
    instance: TimelineFrame["instances"][number],
  ) {
    for (const field of asset.textFields ?? []) {
      const fieldAsset = this.getAsset(field.id);
      if (!fieldAsset) continue;
      const resolved = this.resolveTextField(field.id, fieldAsset);
      // Only overlay once a loadVariables() value exists (else the baked frame is authoritative).
      if (!resolved?.normalizedVariableName || !this.textVars.has(resolved.normalizedVariableName)) continue;
      const matrix = multiplyMatrix(buttonMatrix, field.matrix);
      out.push(this.leafNode(`${key}/txt:${field.id}`, order.n++, fieldAsset, fieldAsset.src ?? "", matrix, instance.opacity, instance));
    }
  }

  private leafNode(
    key: string,
    order: number,
    asset: TimelineAsset,
    src: string,
    matrix: RenderNode["matrix"],
    opacity: number,
    instance: TimelineFrame["instances"][number],
  ): RenderNode {
    return {
      key,
      order,
      characterId: asset.id,
      kind: asset.kind,
      name: instance.name,
      src,
      origin: asset.origin,
      matrix,
      opacity,
      colorTransform: instance.colorTransform,
      clipDepth: instance.clipDepth,
      text: asset.kind === "text" ? this.resolveTextField(asset.id, asset) : undefined,
    };
  }

  /** Merge loadVariables() text into the player and re-render bound fields. */
  setTextVars(vars: Record<string, string>) {
    for (const [key, value] of Object.entries(vars)) this.textVars.set(key, value);
    this.render();
  }

  private resolveTextField(characterId: number, asset: TimelineAsset) {
    const base = asset.text;
    const dynamic = this.timeline.control?.dynamicTexts?.[String(characterId)];
    const merged = base && dynamic ? { ...base, ...dynamic } : (base ?? dynamic);
    if (!merged) return merged;
    // A field bound to a loadVariables() variable shows that value (these fields
    // are baked empty in their sprite frames).
    const varName = merged.normalizedVariableName;
    if (varName && this.textVars.has(varName)) return { ...merged, text: this.textVars.get(varName) };
    return merged;
  }

  // --- ambient sound ----------------------------------------------------

  private primeAmbientSound() {
    if (!this.options.onSound) return;
    let music: ControlAction | undefined;
    for (let frame = 0; frame <= this.root.currentFrame; frame += 1) {
      for (const action of this.rootActions.get(frame) ?? []) {
        if (action.command === "attachSound" && action.soundRole === "music") music = action;
      }
    }
    if (music) this.options.onSound(music);
  }
}
