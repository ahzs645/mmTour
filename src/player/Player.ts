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
import { ClipInstance } from "./ClipInstance";
import { evalCondition } from "./conditions";
import { IDENTITY, multiplyMatrix } from "./matrix";
import { Ticker } from "./Ticker";
import { clamp, type RenderNode } from "./types";
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
    this.rootFrames = timeline.frames ?? [];
    this.rootStop = new Set(timeline.control?.stopFrames ?? []);
    this.startFrame = clamp(timeline.entryFrame ?? 0, 0, Math.max(0, this.rootFrames.length - 1));

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

    // A button release that calls functions (e.g. Skip Intro → `_level0.LoadInitialInteractive()`)
    // runs through the same dispatcher as frame scripts (cross-level calls, clip commands, waiters).
    if (action.functionCalls?.length) this.runCallFunctions(action, owner);
    if (action.command === "loadMovieNum" || action.command === "loadMovie") this.options.onNavigate?.(action);
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
    for (const action of def.actions) {
      if (this.store && !evalCondition(action.functionBranchCondition, this.store)) continue;
      this.runFunctionAction(action);
    }
    // Evaluate every body guard against the store as it is on ENTRY, then run the passing
    // statements. AVM1 checks an `if` once when control reaches it, not per statement — so a
    // statement that sets a variable named in its own block's guard (e.g.
    // LoadInitialInteractive's `if(!blnDisableSkip){ blnDisableSkip=1; blnIntroMode=0; … }`)
    // must not cause the later same-guarded statements to be skipped.
    const decisions = def.body.map((statement) => this.branchPasses(statement.branchCondition, locals));
    def.body.forEach((statement, i) => { if (decisions[i]) this.runBodyStatement(statement, locals); });
    this.render();
    return true;
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
    if (!argsRaw?.trim()) return [];
    const parts: string[] = [];
    let depth = 0, quote = "", start = 0;
    for (let i = 0; i < argsRaw.length; i++) {
      const c = argsRaw[i];
      if (quote) { if (c === quote && argsRaw[i - 1] !== "\\") quote = ""; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "," && depth === 0) { parts.push(argsRaw.slice(start, i)); start = i + 1; }
    }
    parts.push(argsRaw.slice(start));
    return parts.map((p) => this.resolveExpr(p.trim(), locals));
  }

  /** Resolve an assignment RHS / argument expression to a value (param refs → locals). */
  private resolveExpr(raw: string, locals?: Locals): VarValue | undefined {
    const e = raw.trim();
    if (e === "") return undefined;
    if ((e.startsWith('"') && e.endsWith('"')) || (e.startsWith("'") && e.endsWith("'"))) return e.slice(1, -1);
    if (e === "true") return true;
    if (e === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
    if (locals && e in locals) return locals[e];
    // A bare identifier/path is a variable read (e.g. a flag); fall back to the literal.
    if (/^[A-Za-z_$][\w$.]*$/.test(e)) return this.store?.get(e) ?? undefined;
    return e; // array literals etc. — kept as their source text
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
    return evalCondition(this.localizeCondition(condition, locals), this.store);
  }

  /** Substitute bound parameter names in a condition with their literal values. */
  private localizeCondition(condition: string, locals: Locals): string {
    let out = condition;
    for (const [name, value] of Object.entries(locals)) {
      if (value === undefined) continue;
      const literal = typeof value === "string" ? JSON.stringify(value) : String(value);
      out = out.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), literal);
    }
    return out;
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
        this.callFunction(fn, call.arguments);
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
    for (const action of def.actions) {
      if (this.store && !evalCondition(action.functionBranchCondition, this.store)) continue;
      this.runClipAction(clip, action);
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
      if (!asset || !this.isClipAsset(asset)) continue;
      live.add(instance.depth);
      const existing = clip.childClips.get(instance.depth);
      if (!existing || existing.characterId !== instance.characterId) {
        const child = new ClipInstance(instance.characterId, instance.name, clip);
        clip.childClips.set(instance.depth, child);
        this.enterFrame(child, 0, 0);
      }
    }
    for (const [depth] of clip.childClips) {
      if (!live.has(depth)) clip.childClips.delete(depth);
    }
  }

  private runScript(clip: ClipInstance, depth: number) {
    // Inline frame scripts mix unconditional (timeline) actions with the arms of
    // if/else chains (branch). Evaluate each branch arm: a real condition is tested
    // on its own (independent `if`s, e.g. the nav's per-section checks), while an
    // `else` fires only when the branch immediately before it didn't match (e.g. the
    // intro's `if(OSVersion=="Per") gotoAndPlay(343) else gotoAndPlay(195)`). A
    // timeline action resets the chain. This is what advances the intro past its
    // f194 stop into the OS-specific showcase.
    let prevBranchMatched: boolean | null = null;
    for (const action of this.actionsFor(clip)) {
      if (action.executionContext === "branch") {
        const matched: boolean =
          action.branchCondition === "else"
            ? prevBranchMatched !== true
            : !this.store || evalCondition(action.branchCondition, this.store);
        prevBranchMatched = matched;
        if (!matched) continue;
      } else {
        prevBranchMatched = null;
      }
      switch (action.command) {
        case "stop":
          clip.playing = false;
          break;
        case "play":
          clip.playing = true;
          break;
        case "gotoAndPlay":
        case "gotoAndStop": {
          const target = this.resolveTarget(clip, action.target);
          const frame = this.resolveFrame(action, target);
          if (!target || frame < 0) break;
          // A 1-frame root self-loop while a voice-over is playing is a VO hold
          // (`if(!sndDonePlaying())gotoAndPlay(prev)`): keep looping until the VO
          // finishes, then skip the jump so the intro advances to the next beat.
          // (Larger loops — section/idle loops — fall through and loop normally; the
          // intro→menu hand-off is driven by the data's LoadInitialInteractive call.)
          if (action.command === "gotoAndPlay" && clip === this.root && target === this.root && frame < clip.currentFrame) {
            const delta = clip.currentFrame - frame;
            if (delta <= VO_HOLD_DELTA && this.voWaiting && (this.options.isVoiceDone?.() ?? true)) {
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
        case "loadVariables":
          this.options.onLoadVariables?.(action);
          break;
        case "callFunctions":
          this.runCallFunctions(action, clip);
          break;
        case "setVariable": {
          // A frame-script `target = value` assignment into the shared store — the
          // orchestration polls these flags (e.g. `nav.bln_CoreNavLoaded = 1`).
          const value = this.resolveExpr(action.rawValue ?? String(action.value ?? ""));
          if (this.store && action.target && value !== undefined) this.store.set(action.target, value);
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
      node = this.findChildByName(node, name);
    }
    return node;
  }

  private findChildByName(clip: ClipInstance, name: string): ClipInstance | null {
    for (const child of clip.childClips.values()) {
      if (child.name === name) return child;
    }
    return null;
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

  private isClipAsset(asset: TimelineAsset): boolean {
    return asset.kind === "sprite" && Boolean(asset.timeline?.length || asset.frames?.length);
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
        const src = this.visualSrc(asset, child);
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
        const src = this.visualSrc(asset, child);
        if (src) activeMask.group.items.push({ characterId: asset.id, src, origin: asset.origin, matrix, opacity });
        continue;
      }

      // Sprite with baked frames → render the composited frame for visual fidelity
      // (FFDec bakes masks/group-alpha the nested leaves would lose), and overlay
      // transparent button hit areas from its nested timeline so it stays
      // interactive and its frame scripts still run (logic lives in the tree).
      if (asset.kind === "sprite" && asset.frames?.length) {
        const frameIndex = child ? clamp(child.currentFrame, 0, asset.frames.length - 1) : 0;
        out.push(this.spriteNode(key, order.n++, asset, asset.frames[frameIndex], matrix, opacity, instance, child?.currentFrame));
        if (child && asset.timeline?.length) this.collectButtons(child, matrix, key, order, out);
        continue;
      }

      // Sprite with only a nested timeline (no baked frames) → render the tree.
      if (asset.kind === "sprite" && asset.timeline?.length && child && child.characterId === asset.id) {
        this.clipByPath.set(key, child);
        this.flatten(child, matrix, opacity, key, order, out);
        continue;
      }

      if (asset.kind === "button") {
        out.push(this.buttonNode(key, order.n++, asset, matrix, instance, path));
        this.collectButtonText(asset, matrix, key, order, out, instance);
        continue;
      }

      out.push(this.leafNode(key, order.n++, asset, asset.src ?? "", matrix, opacity, instance));
    }
    flushMasks(Number.POSITIVE_INFINITY);
  }

  /** The artwork URL an instance would render (for use as a mask shape or masked item). */
  private visualSrc(asset: TimelineAsset, child: ClipInstance | undefined): string {
    if (asset.kind === "sprite" && asset.frames?.length) {
      const frameIndex = child ? clamp(child.currentFrame, 0, asset.frames.length - 1) : 0;
      return asset.frames[frameIndex] ?? "";
    }
    if (asset.kind === "button") return asset.states?.up?.src ?? asset.src ?? "";
    return asset.src ?? "";
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

    // Track the active SWF clip-mask: a mask at depth D with clipDepth C clips the
    // instances at depths D+1..C. A loadVariables() field inside a mask is part of a
    // title-strip the baked frame already composites (revealing one), so overlaying it
    // here would bypass the mask and stack every title — skip those.
    let maskClip = 0;
    for (const instance of frame.instances) {
      if (maskClip && instance.depth > maskClip) maskClip = 0;
      if (instance.clipDepth) { maskClip = instance.clipDepth; continue; }
      const asset = this.getAsset(instance.characterId);
      if (!asset) continue;
      const matrix = multiplyMatrix(world, instance.matrix);
      const key = `${path}/${instance.depth}`;
      if (asset.kind === "button") {
        out.push(this.buttonNode(key, order.n++, asset, matrix, instance, path));
        this.collectButtonText(asset, matrix, key, order, out, instance);
      } else if (asset.kind === "text") {
        const field = this.resolveTextField(asset.id, asset);
        // Only overlay loadVariables()-bound fields we have a value for (they're baked empty),
        // and only when NOT inside a mask (else the baked frame's masked composite is authoritative).
        if (maskClip === 0 && field?.normalizedVariableName && this.textVars.has(field.normalizedVariableName)) {
          out.push(this.leafNode(key, order.n++, asset, asset.src ?? "", matrix, instance.opacity, instance));
        }
      } else if (asset.kind === "sprite") {
        const child = clip.childClips.get(instance.depth);
        if (child) this.collectButtons(child, matrix, key, order, out);
      }
    }
  }

  private spriteNode(
    key: string,
    order: number,
    asset: TimelineAsset,
    src: string,
    matrix: RenderNode["matrix"],
    opacity: number,
    instance: TimelineFrame["instances"][number],
    spriteFrame?: number,
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
      spriteFrame,
    };
  }

  /** A transparent, sized hit area over a button (its visual is in the baked sprite frame). */
  private buttonNode(
    key: string,
    order: number,
    asset: TimelineAsset,
    matrix: RenderNode["matrix"],
    instance: TimelineFrame["instances"][number],
    ownerPath: string,
  ): RenderNode {
    return {
      key,
      order,
      characterId: asset.id,
      kind: "button",
      name: instance.name,
      src: "",
      origin: asset.origin,
      matrix,
      opacity: 1,
      buttonOwnerPath: ownerPath,
    };
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
