import type {
  AssetTimeline,
  BodyStatement,
  ButtonActionRecord,
  ControlAction,
  DefinedFunction,
  TimelineAsset,
  TimelineFrame,
} from "../data/timelineTypes";
import { collectExplicitSoundTimings } from "../data/soundTimings";
import type { DomRenderer } from "../render/DomRenderer";
import { isLocalVar, localizeCondition, splitTopLevelArgs } from "./avm1";
import { buttonNode, findChildByName, isClipAsset, spriteNode, visualSrc, type ButtonVisualState } from "./renderNodes";
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
type SoundBinding = { sound: string; soundSrc?: string; soundDurationMs?: number };
type SoundLibraryEntry = { name?: string; src?: string; durationMs?: number; aliases?: string[] };
type SoundActionMetadata = NonNullable<ControlAction["soundAction"]>;

/** Timeline commands that, with a target, are clip controls (vs function calls). */
const TIMELINE_COMMANDS = new Set(["gotoAndPlay", "gotoAndStop", "play", "stop", "nextFrame", "prevFrame"]);
/** AVM1 "wait until condition / timer" helpers handled as a runtime primitive. */
const WAITER_FUNCTIONS = new Set(["waitForVal", "startTimer"]);
/** Timing-only VO marker helpers. */
const SOUND_MARKER_FUNCTIONS = new Set(["markSnd", "markSndSegment"]);
const NON_ROOT_LEVEL_TARGET = /^_level[1-9]\d*\b/i;

export type PlayerOptions = {
  onFrame?: (rootFrame: number, playing: boolean) => void;
  onNavigate?: (action: ControlAction) => void;
  onSound?: (action: ControlAction) => void;
  /** Host hook: fired on every button event (including buttons the conversion left
   *  unbound, where `action` is undefined). Returning `true` marks the event handled
   *  and suppresses the player's own default handling, so the host fully owns it. */
  onButton?: (
    characterId: number,
    ownerPath: string,
    event: ButtonEvent,
    action?: { command?: string; target?: string; label?: string; swf?: string; level?: number },
  ) => boolean | void;
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
  /** A cross-level/named-clip command (`proToolbar.gotoAndPlay("hideInner")`) that arrived before
   *  its target clip existed on stage — keyed by the clip's instance name. Applied when that clip is
   *  next reconciled, so the command isn't silently dropped during a mid-transition race. */
  private readonly pendingClipCommands = new Map<string, { command: string; frame: VarValue }>();
  /** A playVO fired and the next 1-frame hold-loop should wait for it (sndDonePlaying). */
  private voWaiting = false;
  /** AVM1 Sound objects discovered from `x = new Sound()` assignments. */
  private readonly soundObjectTargets = new Set<string>();
  /** Last linkage attached to each AVM1 Sound object target, played when `.start()` runs. */
  private readonly soundBindings = new Map<string, SoundBinding>();
  /** Per-rendered-button SimpleButton visual state (over/down), keyed by RenderNode path. */
  private readonly buttonVisualStates = new Map<string, ButtonVisualState>();
  /** Sprite timelines sometimes keep their SimpleButton leaf only in over/down/active frames.
   *  When stopped on the rest art, expose a transparent proxy hit from that button's own
   *  extracted self-timeline actions so hover can enter the interactive state. */
  private readonly latentButtonPlacementsCache = new Map<number, TimelineFrame["instances"]>();
  /** Estimated VO segment durations, keyed by segment id (`TOUR74b`). */
  private readonly soundSegmentDurations = new Map<string, { baseSound: string; soundSrc?: string; durationMs?: number }>();

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
    this.buildSoundSegmentDurations();

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
    this.buttonVisualStates.clear();
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
    this.buttonVisualStates.clear();
    this.renderer.clear();
  }

  /** Dispatch a button event from the owning clip (identified by its tree path). */
  handleButtonEvent(ownerPath: string, characterId: number, event: ButtonEvent, buttonKey?: string) {
    this.setButtonVisualState(buttonKey ?? `${ownerPath}:${characterId}`, event);
    const owner = this.clipByPath.get(ownerPath) ?? this.root;
    const eventScope = this.buttonEventScope(owner, characterId);
    const action = this.buttonActionFor(owner, characterId, event);
    const companions = this.companionButtonActions(owner, characterId, event);
    // Surface the interaction to the host before doing anything with it, so the host
    // can give meaning to unbound buttons (and override bound ones). A `true` return
    // means the host fully handled it — skip the player's own default handling.
    if (this.options.onButton) {
      const summary = action
        ? { command: action.command, target: action.target, label: action.label, swf: action.swf, level: action.level != null ? Number(action.level) : undefined }
        : undefined;
      if (this.options.onButton(characterId, ownerPath, event, summary) === true) {
        this.render();
        return;
      }
    }
    if (!action) {
      this.render();
      return;
    }

    // Apply the handler's simple state assignments first: clip-local flags drive the
    // select/deselect calls below, and shared globals drive cross-movie gating. Some
    // extraction paths also attach an empty higher-level placeholder assignment to a
    // richer click command; because the VariableStore is flat, do not let that clear
    // selection state. Non-empty _levelN writes are real AVM1 state and must flow.
    for (const assign of action.assignments ?? []) {
      const value = this.resolveExpr(assign.rawValue ?? String(assign.value ?? ""));
      if (assign.target && value !== undefined && !isEmptyNonRootLevelAssignment(assign.target, value)) this.scopeSet(owner, assign.target, value);
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
    const calls = this.buttonCallableActions(action, duplicatesCommand);
    if (calls?.length) this.runCallFunctions({ ...action, functionCalls: calls }, owner, undefined, eventScope);
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
      const target = this.resolveTarget(owner, action.target) ?? this.resolveTarget(eventScope, action.target);
      const frame = this.resolveFrame(action, target);
      if (target && frame >= 0) {
        target.playing = action.command === "gotoAndPlay";
        this.enterFrame(target, frame, 0);
      }
    }
    for (const companion of companions) {
      this.runCompanionButtonAction(companion.owner, companion.characterId, companion.action);
    }
    this.render();
  }

  private buttonActionFor(owner: ClipInstance, characterId: number, event: ButtonEvent): ControlAction | undefined {
    const direct = this.timeline.control?.buttonActions?.[String(characterId)]?.[event];
    if (direct) return direct;

    // FFDec/browser extraction can split a control into separate transition and settled
    // button symbols. The transition symbol may carry the same embedded dynamic text but
    // no event bytecode, while the next/previous settled symbol carries the handler.
    // Resolve only within the same owning clip and only across buttons with identical
    // text-field bindings, so the fallback remains data-driven and narrowly scoped.
    const signature = this.buttonTextFieldSignature(characterId);
    if (!signature) return undefined;

    const frames = this.framesFor(owner);
    if (!frames?.length) return undefined;

    let best: { action: ControlAction; distance: number } | undefined;
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const distance = Math.abs(frameIndex - owner.currentFrame);
      if (best && distance > best.distance) continue;
      for (const instance of frames[frameIndex]?.instances ?? []) {
        if (instance.characterId === characterId) continue;
        if (this.buttonTextFieldSignature(instance.characterId) !== signature) continue;
        const action = this.timeline.control?.buttonActions?.[String(instance.characterId)]?.[event];
        if (!action) continue;
        if (!best || distance < best.distance) best = { action, distance };
      }
    }
    return best?.action;
  }

  private companionButtonActions(owner: ClipInstance, characterId: number, event: ButtonEvent): Array<{ owner: ClipInstance; characterId: number; action: ControlAction }> {
    if (event === "release") return [];
    const groups = this.timeline.control?.buttonActions ?? {};
    const group = groups[String(characterId)];
    const releaseKey = buttonReleaseKey(group?.release);
    if (!group || !releaseKey) return [];
    const out: Array<{ owner: ClipInstance; characterId: number; action: ControlAction }> = [];
    const scope = owner.parent ?? owner;
    for (const [candidateId, candidateGroup] of Object.entries(groups)) {
      const id = Number(candidateId);
      if (!Number.isFinite(id) || id === characterId) continue;
      const candidateAction = candidateGroup[event];
      if (!candidateAction) continue;
      if (buttonReleaseKey(candidateGroup.release) !== releaseKey) continue;
      if (!buttonOwnerGroupsOverlap(group, candidateGroup)) continue;
      if (!buttonTimelineActionsMatch(group[event], candidateAction)) continue;
      const candidateOwner = this.findButtonOwnerClip(scope, id) ?? this.findButtonOwnerClip(this.root, id);
      if (!candidateOwner || candidateOwner === owner) continue;
      out.push({ owner: candidateOwner, characterId: id, action: candidateAction });
    }
    return out;
  }

  private runCompanionButtonAction(owner: ClipInstance, characterId: number, action: ControlAction) {
    const eventScope = this.buttonEventScope(owner, characterId);
    for (const assign of action.assignments ?? []) {
      const value = this.resolveExpr(assign.rawValue ?? String(assign.value ?? ""));
      if (assign.target && value !== undefined && !isEmptyNonRootLevelAssignment(assign.target, value)) this.scopeSet(owner, assign.target, value);
    }
    const calls = this.buttonCallableActions(action);
    if (calls?.length) this.runCallFunctions({ ...action, functionCalls: calls }, owner, undefined, eventScope);
    if (action.command !== "gotoAndPlay" && action.command !== "gotoAndStop") return;
    const target = this.resolveTarget(owner, action.target) ?? this.resolveTarget(eventScope, action.target);
    const frame = this.resolveFrame(action, target);
    if (target && frame >= 0) {
      target.playing = action.command === "gotoAndPlay";
      this.enterFrame(target, frame, 0);
    }
  }

  private buttonCallableActions(
    action: ControlAction,
    duplicatesCommand: (call: NonNullable<ControlAction["functionCalls"]>[number]) => boolean = () => false,
  ): ControlAction["functionCalls"] {
    const calls = action.functionCalls;
    if (action.command !== "gotoAndPlay" && action.command !== "gotoAndStop") return calls;
    return (calls ?? []).filter((call) => !duplicatesCommand(call));
  }

  private findButtonOwnerClip(clip: ClipInstance, characterId: number): ClipInstance | null {
    if (this.clipOwnsButton(clip, characterId)) return clip;
    for (const child of clip.childClips.values()) {
      const found = this.findButtonOwnerClip(child, characterId);
      if (found) return found;
    }
    return null;
  }

  private clipOwnsButton(clip: ClipInstance, characterId: number): boolean {
    const frame = this.framesFor(clip)?.[clip.currentFrame];
    if (frame?.instances?.some((instance) => instance.characterId === characterId && this.getAsset(instance.characterId)?.kind === "button")) return true;
    return this.latentButtonPlacements(clip).some((instance) => instance.characterId === characterId);
  }

  private buttonEventScope(owner: ClipInstance, characterId: number): ClipInstance {
    // Button ActionScript sometimes addresses sibling clips through `_parent`,
    // while other handlers use `_parent._parent` to reach the containing root.
    // Hit overlays are not ClipInstances, so keep the real owner as primary and
    // use this transient button scope only as a fallback for sibling resolution.
    return new ClipInstance(characterId, "", owner);
  }

  private setButtonVisualState(key: string, event: ButtonEvent) {
    switch (event) {
      case "rollOver":
        if (this.buttonVisualStates.get(key) !== "down") this.buttonVisualStates.set(key, "over");
        break;
      case "press":
        this.buttonVisualStates.set(key, "down");
        break;
      case "release":
        this.buttonVisualStates.set(key, "over");
        break;
      case "rollOut":
        this.buttonVisualStates.delete(key);
        break;
    }
  }

  private buttonTextFieldSignature(characterId: number): string {
    const asset = this.getAsset(characterId);
    if (asset?.kind !== "button" || !asset.textFields?.length) return "";
    return asset.textFields.map((field) => field.id).sort((a, b) => a - b).join("|");
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
      if (def.actions?.length) entry.actions.push(...def.actions);
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
      if (def.actions?.length) {
        let fns = this.spriteFunctions.get(def.spriteId);
        if (!fns) this.spriteFunctions.set(def.spriteId, (fns = new Map()));
        const entry = fns.get(def.functionName) ?? newDef();
        entry.actions.push(...def.actions);
        fns.set(def.functionName, entry);
        continue;
      }
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
    // The build encodes a function's calls TWICE: in its structured `body` (with the full nested
    // if/else gates) AND as flattened function-tagged actions (which keep only the OUTERMOST
    // guard, losing the nested discrimination). Running both fires a call the body gate would
    // suppress — LoadInitialInteractive's actions fire BOTH `startNavEntrance` (→ nav frame 71)
    // and `startAddedNav` (→ nav frame 115) when the body picks exactly one by nav-loaded state,
    // so the nav jumps PAST its entrance cascade. When the body already issues a call, let the
    // body decide it (below) and skip the lossy action duplicate. Sound actions need the same
    // treatment now that body-form Sound.attachSound/start/stop calls are executable.
    const bodyDecisions = this.functionBodyDecisions(def.body, locals);
    const firedBodyCalls = new Set(
      def.body
        .filter((s, i) => bodyDecisions[i] && s.kind === "call")
        .map((s) => (s as { functionName?: string }).functionName),
    );
    const firedBodySoundKeys = new Set(
      def.body
        .filter((s, i) => bodyDecisions[i] && s.kind === "call")
        .map((s) => this.bodySoundCallKey(s as Extract<BodyStatement, { kind: "call" }>, locals))
        .filter((key): key is string => Boolean(key)),
    );
    def.actions.forEach((action, i) => {
      if (!actionFire[i]) return;
      const calls = action.functionCalls ?? [];
      if (action.command === "callFunctions" && calls.length > 0 && calls.every((c) => firedBodyCalls.has(c.functionName))) return;
      const soundKey = actionSoundKey(action);
      if (soundKey && firedBodySoundKeys.has(soundKey)) return;
      this.runFunctionAction(action, locals);
    });
    this.runFunctionBody(def.body, locals, bodyDecisions);
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
    const evalArg = singleArgCall(e, "eval");
    if (evalArg !== undefined) {
      const name = this.resolveExpr(evalArg, locals);
      return name === undefined ? undefined : this.store?.get(String(name)) ?? this.textVars.get(normalizeVarName(String(name))) ?? undefined;
    }
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

  /**
   * Decide function-body guards against an entry snapshot plus safe prior assigns.
   * Assigns such as `doSndSet = 1` must be visible to a later `if(doSndSet) start()`,
   * but self-blocking guards such as `if(!blnDisableSkip){ blnDisableSkip = 1; ... }`
   * must not cause later statements from the same original block to skip themselves.
   */
  private functionBodyDecisions(body: BodyStatement[], locals: Locals): boolean[] {
    const guardLocals = this.functionGuardLocals(body, locals);
    return body.map((statement) => this.branchPasses(statement.branchCondition, guardLocals));
  }

  private runFunctionBody(body: BodyStatement[], locals: Locals, decisions = this.functionBodyDecisions(body, locals)) {
    body.forEach((statement, i) => {
      if (decisions[i]) this.runBodyStatement(statement, locals);
    });
  }

  private functionGuardLocals(body: BodyStatement[], locals: Locals): Locals {
    const guardLocals: Locals = { ...locals };
    for (const statement of body) {
      if (statement.kind !== "assign") continue;
      if (conditionReferencesTarget(statement.branchCondition, statement.target)) continue;
      if (!this.branchPasses(statement.branchCondition, guardLocals)) continue;
      const value = this.resolveExpr(statement.rawValue, guardLocals);
      if (value !== undefined) guardLocals[statement.target] = value;
    }
    return guardLocals;
  }

  private runBodyStatement(statement: BodyStatement, locals: Locals) {
    if (statement.kind === "assign") {
      const value = this.resolveExpr(statement.rawValue, locals);
      this.trackSoundObject(statement.target, statement.rawValue);
      if (this.store && value !== undefined) this.store.set(statement.target, value);
      return;
    }
    this.runBodyCall(statement, locals);
  }

  /** Dispatch a body call: a waiter, a clip command, or a (possibly cross-level) function call. */
  private runBodyCall(call: Extract<BodyStatement, { kind: "call" }>, locals: Locals) {
    const fn = call.functionName;
    const target = call.target;
    if (this.runMovieLoadCall(fn, call.arguments, locals)) return;
    if (this.runMovieUnloadCall(fn, call.arguments, locals)) return;
    if (this.runSoundMethod(target, fn, call.arguments, locals)) return;
    if (WAITER_FUNCTIONS.has(fn)) {
      this.options.onWaiter?.(fn, this.parseArgs(call.arguments, locals));
      return;
    }
    if (SOUND_MARKER_FUNCTIONS.has(fn)) {
      const segment = this.parseArgs(call.arguments, locals)[0];
      if (segment !== undefined) this.runSoundMarker(target, String(segment), call.arguments);
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
      if (clip === this.root) this.callFunction(fn, call.arguments, locals);
      else if (clip) this.callClipFunction(clip, fn);
    }
  }

  private bodySoundCallKey(call: Extract<BodyStatement, { kind: "call" }>, locals: Locals): string | undefined {
    const [firstArg] = this.parseArgs(call.arguments, locals);
    switch (call.functionName) {
      case "attachSound":
        return soundKey("attachSound", firstArg);
      case "playVO":
        return soundKey("playVO", firstArg);
      case "markSnd":
      case "markSndSegment":
        return soundKey("markSndSegment", firstArg);
      case "stop":
        return call.target ? soundKey("stopSound", normalizeVarName(call.target)) : undefined;
      default:
        return undefined;
    }
  }

  private runMovieLoadCall(fn: string, argsRaw: string | undefined, locals?: Locals): boolean {
    if (fn !== "loadMovieNum" && fn !== "loadMovie") return false;
    const args = this.parseArgs(argsRaw, locals);
    const swf = args[0] === undefined ? "" : String(args[0]);
    if (!swf) return true;
    this.options.onNavigate?.({
      command: fn,
      swf,
      level: fn === "loadMovieNum" ? levelFromValue(args[1], firstRawArg(argsRaw, 1)) : undefined,
      executionContext: "function",
    });
    return true;
  }

  private runMovieUnloadCall(fn: string, argsRaw: string | undefined, locals?: Locals): boolean {
    if (fn !== "unloadMovieNum" && fn !== "unloadMovie") return false;
    const args = this.parseArgs(argsRaw, locals);
    this.options.onNavigate?.({
      command: fn,
      level: levelFromValue(args[0], firstRawArg(argsRaw, 0)),
      executionContext: "function",
    });
    return true;
  }

  private runSoundMarker(target: string | undefined, segment: string, argsRaw?: string, metadata?: SoundActionMetadata) {
    if (!segment) return;
    this.voWaiting = true;
    this.options.onSound?.(this.soundSegmentAction({
      command: "markSndSegment",
      target,
      sound: metadata?.sound ?? segment,
      segment,
      soundSrc: metadata?.soundSrc,
      soundDurationMs: metadata?.soundDurationMs,
      soundRole: metadata?.soundRole ?? "vo",
      executionContext: "function",
      ...(argsRaw ? { arguments: argsRaw } : {}),
    } as ControlAction));
  }

  private soundSegmentAction(action: ControlAction): ControlAction {
    const segment = action.segment ?? action.sound;
    const timing = segment ? this.soundSegmentDurations.get(segment) : undefined;
    return {
      ...action,
      ...(segment ? { segment } : {}),
      soundRole: action.soundRole ?? "vo",
      soundSrc: action.soundSrc ?? timing?.soundSrc,
      soundDurationMs: action.soundDurationMs ?? timing?.durationMs,
      resolvedSound: action.resolvedSound ?? (timing?.baseSound && timing.baseSound !== segment ? timing.baseSound : undefined),
    };
  }

  private runSoundMethod(target: string | undefined, fn: string, argsRaw: string | undefined, locals?: Locals): boolean {
    if (!target) return false;
    const key = this.soundTargetKey(target);
    if (fn === "attachSound") {
      const sound = this.parseArgs(argsRaw, locals)[0];
      const soundName = sound === undefined ? "" : String(sound);
      if (!soundName) return true;
      const soundEntry = this.resolveSound(soundName);
      this.soundObjectTargets.add(key);
      this.soundBindings.set(key, { sound: soundName, soundSrc: soundEntry?.src, soundDurationMs: soundEntry?.durationMs });
      return true;
    }

    if (!this.isSoundTarget(target)) return false;

    if (fn === "start") {
      const binding = this.soundBindings.get(key);
      if (!binding) return true;
      const args = this.parseArgs(argsRaw, locals);
      const loops = Number(args[1] ?? 0);
      const role = loops > 1 || /music/i.test(key) ? "music" : "vo";
      const command = role === "music" ? "attachSound" : "playVO";
      if (role === "vo") this.voWaiting = true;
      this.options.onSound?.({
        command,
        target,
        sound: binding.sound,
        soundSrc: binding.soundSrc,
        soundDurationMs: binding.soundDurationMs,
        soundRole: role,
        executionContext: "function",
      });
      return true;
    }

    if (fn === "stop") {
      this.options.onSound?.({ command: "stopSound", target, executionContext: "function" });
      return true;
    }

    if (fn === "setVolume") {
      const value = this.parseArgs(argsRaw, locals)[0];
      this.options.onSound?.({ command: "setVolume", target, value: typeof value === "boolean" ? Number(value) : value, executionContext: "function" });
      return true;
    }

    return fn === "getVolume";
  }

  private soundTargetKey(target: string): string {
    return normalizeVarName(target);
  }

  private trackSoundObject(target: string | undefined, rawValue: string | undefined) {
    if (!target || !rawValue || !/\bnew\s+Sound\s*\(/.test(rawValue)) return;
    this.soundObjectTargets.add(this.soundTargetKey(target));
  }

  private isSoundTarget(target: string): boolean {
    return this.soundObjectTargets.has(this.soundTargetKey(target)) || this.soundBindings.has(this.soundTargetKey(target));
  }

  private resolveSound(sound: string): SoundLibraryEntry | undefined {
    const library = this.timeline.control?.soundLibrary as Record<string, SoundLibraryEntry | string> | undefined;
    const entry = library?.[sound] ?? library?.[sound.toLowerCase()] ?? this.findSoundByAlias(library, sound);
    return typeof entry === "string" ? { src: entry } : entry;
  }

  private findSoundByAlias(library: Record<string, SoundLibraryEntry | string> | undefined, sound: string): SoundLibraryEntry | undefined {
    if (!library) return undefined;
    const wanted = sound.toLowerCase();
    for (const entry of Object.values(library)) {
      if (typeof entry === "string") continue;
      if (entry.name?.toLowerCase() === wanted || entry.aliases?.some((alias) => alias.toLowerCase() === wanted)) return entry;
    }
    return undefined;
  }

  private buildSoundSegmentDurations() {
    const explicitTimings = collectExplicitSoundTimings(this.timeline.control);
    for (const [segment, timing] of Object.entries(explicitTimings)) {
      this.soundSegmentDurations.set(segment, { baseSound: segment, durationMs: timing.durationMs });
    }

    const groups = new Map<string, Set<string>>();
    const add = (segment: string | undefined) => {
      const normalized = segment?.trim();
      if (!normalized) return;
      const base = this.soundSegmentBase(normalized);
      if (!base) return;
      let set = groups.get(base);
      if (!set) groups.set(base, (set = new Set()));
      set.add(normalized);
    };
    const scanAction = (action: ControlAction | undefined) => {
      if (!action) return;
      if (action.command === "markSndSegment") add(action.segment ?? action.sound);
      const soundAction = action.soundAction;
      if (soundAction?.command === "markSndSegment") add(soundAction.segment ?? soundAction.sound);
      if (soundAction?.command === "playVO") add(soundAction.segment);
      for (const call of action.functionCalls ?? []) {
        const args = splitTopLevelArgs(call.arguments);
        if (call.functionName === "markSnd" || call.functionName === "markSndSegment") add(stripQuotes(args[0]));
        if (call.functionName === "playVO") add(stripQuotes(args[2]));
      }
    };

    for (const record of this.timeline.control?.frameActions ?? []) for (const action of record.actions ?? []) scanAction(action);
    for (const record of this.timeline.control?.spriteActions ?? []) for (const action of record.actions ?? []) scanAction(action);
    for (const definition of Object.values(this.timeline.control?.definedFunctions ?? {}) as DefinedFunction[]) {
      for (const action of definition.actions ?? []) scanAction(action);
    }
    for (const group of Object.values(this.timeline.control?.buttonActions ?? {})) {
      scanAction(group.release);
      scanAction(group.rollOver);
      scanAction(group.rollOut);
      scanAction(group.press);
    }

    for (const [base, segments] of groups) {
      const sound = this.resolveSound(base);
      const fallbackDurationMs = sound?.durationMs && segments.size > 0 ? sound.durationMs / segments.size : undefined;
      for (const segment of segments) {
        const durationMs = explicitTimings[segment]?.durationMs ?? fallbackDurationMs;
        this.soundSegmentDurations.set(segment, { baseSound: sound?.name ?? base, soundSrc: sound?.src, durationMs });
      }
    }
  }

  private soundSegmentBase(segment: string): string | undefined {
    const match = segment.match(/^(.+\d)([a-z]+)$/i);
    if (!match) return undefined;
    const sound = this.resolveSound(match[1]);
    return sound?.name ?? match[1];
  }

  /** Run a timeline command on a clip resolved by name/path (e.g. `yellowPro.gotoAndPlay("over")`). */
  runNamedClipCommand(from: ClipInstance, path: string, command: string, frame: VarValue): boolean {
    const name = path.split(".").filter(Boolean).pop() ?? path;
    const clip = this.resolveTarget(from, path) ?? this.findClipByName(from, name) ?? this.findClipByName(this.root, name);
    if (!clip) {
      // The target clip isn't on stage yet — a cross-level call can land mid-transition (a segment's
      // frame-1 `_level6.proToolbar.gotoAndPlay("hideInner")` fires before the nav has reconciled
      // proToolbar). Remember the intent and apply it when that clip is next created (reconcile),
      // so it isn't dropped and the nav bar actually hides over the segment's title.
      this.pendingClipCommands.set(name, { command, frame });
      return false;
    }
    this.pendingClipCommands.delete(name); // a now-resolvable command supersedes any queued intent
    if (clip.name) this.pendingClipCommands.delete(clip.name);
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

  private runFunctionAction(action: ControlAction, locals?: Locals) {
    switch (action.command) {
      case "stop":
        if (isSelfTimelineTarget(action.target)) this.root.playing = false;
        break;
      case "play":
        if (isSelfTimelineTarget(action.target)) this.root.playing = true;
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
      // A function's sound actions (initMusic's attachSound, a VO function's playVO/stopSound)
      // reach the SoundController exactly as frame-script sound actions do in runScript. This path
      // previously dropped them in `default`, so a function selected a sound branch but never
      // played it — and VO‑gated holds (`isVoiceDone`/`sndDonePlaying`) never saw the VO. A playVO
      // arms the next hold-loop. (Body-form sound `call`s route elsewhere and no-op, so no double.)
      case "attachSound":
      case "playVO":
      case "markSndSegment":
      case "stopSound":
        if (action.command === "playVO") this.voWaiting = true;
        if (action.command === "markSndSegment") this.voWaiting = true;
        this.options.onSound?.(action.command === "markSndSegment" ? this.soundSegmentAction(action) : action);
        break;
      case "loadMovieNum":
      case "loadMovie":
        this.options.onNavigate?.(action);
        break;
      case "unloadMovieNum":
      case "unloadMovie":
        this.options.onNavigate?.(action);
        break;
      case "doRelease":
        if (action.swf) this.options.onNavigate?.({ command: "loadMovie", swf: action.swf, level: action.level, reload: true });
        break;
      case "loadVariables":
        this.options.onLoadVariables?.(action);
        break;
      case "setVariable": {
        // Mirror runScript's setVariable: write to the root's scope, and if the var backs a
        // dynamic text field, update the display cache so the bound field re-renders.
        const value = this.resolveExpr(action.rawValue ?? String(action.value ?? ""));
        this.trackSoundObject(action.target, action.rawValue);
        if (this.store && action.target && value !== undefined) {
          this.scopeSet(this.root, action.target, value);
          const norm = normalizeVarName(action.target);
          if (this.boundTextVars.has(norm)) this.textVars.set(norm, String(value));
        }
        break;
      }
      case "callFunctions":
        this.runCallFunctions(action, this.root, locals);
        break;
      default:
        break;
    }
  }

  private runCallFunctions(action: ControlAction, clip: ClipInstance = this.root, locals?: Locals, fallbackClip?: ClipInstance) {
    let metadataSoundHandled = false;
    for (const call of action.functionCalls ?? []) {
      const handled = this.runFunctionCall(call, clip, locals, fallbackClip);
      if (callMatchesSoundMetadata(call, action.soundAction) && handled) metadataSoundHandled = true;
    }
    if (action.soundAction && !metadataSoundHandled) this.runSoundMetadataFallback(action.soundAction);
  }

  private runFunctionCall(call: NonNullable<ControlAction["functionCalls"]>[number], clip: ClipInstance, locals?: Locals, fallbackClip?: ClipInstance): boolean {
    const target = call.target ?? "self";
    const fn = call.functionName;
    if (this.runSoundMethod(target, fn, call.arguments, locals)) return true;
    if (WAITER_FUNCTIONS.has(fn)) {
      this.options.onWaiter?.(fn, this.parseArgs(call.arguments, locals));
      return true;
    }
    if (SOUND_MARKER_FUNCTIONS.has(fn)) {
      const segment = this.parseArgs(call.arguments, locals)[0];
      if (segment !== undefined) {
        this.runSoundMarker(target, String(segment), call.arguments);
        return true;
      }
    }
    if (TIMELINE_COMMANDS.has(fn) && target !== "self" && target !== "this" && target !== "_root") {
      const frame = this.parseArgs(call.arguments, locals)[0] ?? 0;
      if (/^_level\d+/i.test(target)) {
        this.options.onClipCommand?.(target, fn, frame);
        return true;
      }
      if (this.runNamedClipCommand(clip, target, fn, frame)) return true;
      return fallbackClip ? this.runNamedClipCommand(fallbackClip, target, fn, frame) : false;
    }
    if (target === "self" || target === "this" || target === "_root") {
      // Prefer a sprite-scoped function on the owning clip (a control's over()/out() label
      // reveal lives on its own sprite); fall back to a root/global function.
      if (target !== "_root" && this.spriteFunctions.get(clip.characterId)?.has(fn)) return this.callClipFunction(clip, fn);
      return this.callFunction(fn, call.arguments);
    }
    if (/^_level\d+/i.test(target)) {
      // Absolute level targets (`_level6`, `_level0.x`) are routed to the
      // controller, which maps the level back to its Player. Treat the dispatch as
      // handled here; the target level may exist already or be queued by the host.
      this.options.onCallFunction?.(target, fn, this.resolveArgsString(call.arguments, locals));
      return true;
    }
    // A named nested clip (from `tellTarget("clip")`): resolve it locally and
    // run the clip's own sprite-scoped function (e.g. doFade -> gotoAndPlay).
    // A relative target can also resolve back to the root (`_parent._parent.fn`);
    // in that case call the root function table.
    const name = target.split(".").filter(Boolean).pop() ?? target;
    const targetClip = this.resolveTarget(clip, target)
      ?? this.findClipByName(clip, name)
      ?? (fallbackClip ? (this.resolveTarget(fallbackClip, target) ?? this.findClipByName(fallbackClip, name)) : null);
    if (targetClip === this.root) return this.callFunction(fn, call.arguments, locals);
    if (targetClip) return this.callClipFunction(targetClip, fn);
    return false;
  }

  private runSoundMetadataFallback(soundAction: SoundActionMetadata) {
    // Metadata is a last-resort bridge for browser-extracted callFunctions whose
    // target function/clip could not be resolved. Do not synthesize attachSound or
    // attachSound here: attachSound alone is only a binding in AVM1. A resolved
    // playVO is safe because it is the same externally visible effect the missing
    // function would have had; markSndSegment is timing-only and re-arms VO holds.
    if (soundAction.command === "markSndSegment") {
      const segment = soundAction.segment ?? soundAction.sound;
      if (segment) this.runSoundMarker(soundAction.target, segment, soundAction.arguments, soundAction);
      return;
    }
    if (soundAction.command !== "playVO" || !soundAction.soundSrc) return;
    this.voWaiting = true;
    this.options.onSound?.({
      command: "playVO",
      target: soundAction.target,
      sound: soundAction.sound,
      soundSrc: soundAction.soundSrc,
      soundDurationMs: soundAction.soundDurationMs,
      soundRole: soundAction.soundRole ?? "vo",
      executionContext: "metadata-fallback",
    });
  }

  /** Run a sprite-scoped function (e.g. `doFade`) on a specific nested clip. */
  private callClipFunction(clip: ClipInstance, name: string): boolean {
    const def = this.spriteFunctions.get(clip.characterId)?.get(name);
    if (!def) return false;
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
    return true;
  }

  private runClipAction(clip: ClipInstance, action: ControlAction) {
    switch (action.command) {
      case "stop":
        if (isSelfTimelineTarget(action.target)) clip.playing = false;
        break;
      case "play":
        if (isSelfTimelineTarget(action.target)) clip.playing = true;
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
        this.trackSoundObject(action.target, action.rawValue);
        if (action.target && value !== undefined) this.scopeSet(clip, action.target, value);
        break;
      }
      default:
        break;
    }
  }

  /** Depth-first search for a clip by instance name (tellTarget resolves a clip path). */
  private findClipByName(clip: ClipInstance, name: string): ClipInstance | null {
    const prefixMatches: ClipInstance[] = [];
    const collect = (candidate: ClipInstance): ClipInstance | null => {
      if (candidate.name === name) return candidate;
      if (isPrefixInstanceName(candidate.name, name)) prefixMatches.push(candidate);
      for (const child of candidate.childClips.values()) {
        const found = collect(child);
        if (found) return found;
      }
      return null;
    };
    const exact = collect(clip);
    if (exact) return exact;
    return prefixMatches.length === 1 ? prefixMatches[0] : null;
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
      if (instance.name) clip.depthNames.set(instance.depth, instance.name);
      const instanceName = instance.name || clip.depthNames.get(instance.depth) || "";
      const existing = clip.childClips.get(instance.depth);
      if (!existing || existing.characterId !== instance.characterId) {
        const child = new ClipInstance(instance.characterId, instanceName, clip);
        clip.childClips.set(instance.depth, child);
        this.enterFrame(child, 0, 0);
        // A command that arrived before this clip existed (e.g. the nav's proToolbar hide, issued by
        // a segment on load) is applied now, on creation, instead of being lost.
        const pendingKey = instanceName ? this.pendingClipCommandKey(instanceName) : undefined;
        const pending = pendingKey ? this.pendingClipCommands.get(pendingKey) : undefined;
        if (pending && pendingKey) {
          this.pendingClipCommands.delete(pendingKey);
          const f = this.resolveClipFrame(child, pending.frame);
          if (f >= 0) { child.playing = pending.command === "gotoAndPlay"; this.enterFrame(child, f, 0); }
        }
      } else if (instanceName && existing.name !== instanceName) {
        // A later PlaceObject named this depth, or a later replacement omitted the
        // already-known name. Keep the live clip addressable so extracted AVM1
        // paths such as `_parent.<name>.gotoAndPlay(...)` continue to resolve.
        existing.name = instanceName;
      }
    }
    for (const [depth] of clip.childClips) {
      if (!live.has(depth)) clip.childClips.delete(depth);
    }
  }

  private pendingClipCommandKey(instanceName: string): string | undefined {
    if (this.pendingClipCommands.has(instanceName)) return instanceName;
    const aliasMatches = Array.from(this.pendingClipCommands.keys()).filter((targetName) => isPrefixInstanceName(instanceName, targetName));
    return aliasMatches.length === 1 ? aliasMatches[0] : undefined;
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
          if (isSelfTimelineTarget(action.target)) clip.playing = false;
          break;
        case "play":
          if (isSelfTimelineTarget(action.target)) clip.playing = true;
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
      case "markSndSegment":
      case "stopSound":
        // A new voice-over starts a narrated beat the upcoming hold-loop waits on.
        if (action.command === "playVO") this.voWaiting = true;
        if (action.command === "markSndSegment") this.voWaiting = true;
        this.options.onSound?.(action.command === "markSndSegment" ? this.soundSegmentAction(action) : action);
        break;
        case "loadMovieNum":
        case "loadMovie":
          this.options.onNavigate?.(action);
          break;
        case "unloadMovieNum":
        case "unloadMovie":
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
          this.trackSoundObject(action.target, action.rawValue);
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
    const parts = target.split(".").filter(Boolean);
    let node: ClipInstance | null = clip;
    for (let i = 0; i < parts.length; i += 1) {
      const name = parts[i];
      if (i === 0 && (name === "_root" || name === "_level0" || name === "root")) {
        node = this.root;
        continue;
      }
      if (i === 0 && /^_level\d+$/i.test(name)) {
        node = name.toLowerCase() === "_level0" ? this.root : null;
        continue;
      }
      if (name === "_parent") {
        node = node?.parent ?? node;
        continue;
      }
      if (!node) return null;
      // PlaceObject names can be introduced on a later nested frame. Stay inside
      // the current target scope, but fall back to a named descendant so wrapped
      // controls still receive their extracted sibling/child timeline commands.
      node = findChildByName(node, name) ?? this.findClipByName(node, name);
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
    this.flatten(this.root, IDENTITY, 1, undefined, "0", { n: 0 }, nodes);
    const liveButtons = new Set(nodes.filter((node) => node.kind === "button").map((node) => node.key));
    for (const key of this.buttonVisualStates.keys()) {
      if (!liveButtons.has(key)) this.buttonVisualStates.delete(key);
    }
    this.renderer.apply(nodes);
    this.lastNodes = nodes;
  }

  private flatten(
    clip: ClipInstance,
    world: RenderNode["matrix"],
    worldOpacity: number,
    worldColorTransform: RenderNode["colorTransform"],
    path: string,
    order: { n: number },
    out: RenderNode[],
  ) {
    const frames = this.framesFor(clip);
    if (!frames) return;
    const frame = frames[clip.currentFrame];
    if (!frame) return;
    const occupiedDepths = new Set(frame.instances.map((instance) => instance.depth));

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
      const colorTransform = composeColorTransform(worldColorTransform, instance.colorTransform);
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
            group: { mask: { characterId: asset.id, src, origin: asset.origin, matrix, opacity: 1, colorTransform }, items: [] },
          });
        }
        continue;
      }

      // Inside an active mask → collect the instance as a masked item, not a normal node.
      const activeMask = maskStack[maskStack.length - 1];
      if (activeMask && instance.depth <= activeMask.clipDepth) {
        const src = visualSrc(asset, child);
        if (src) activeMask.group.items.push({ characterId: asset.id, src, origin: asset.origin, matrix, opacity, colorTransform });
        continue;
      }

      // Sprite with baked frames → render the composited frame for visual fidelity
      // (FFDec bakes masks/group-alpha the nested leaves would lose), and overlay
      // transparent button hit areas from its nested timeline so it stays
      // interactive and its frame scripts still run (logic lives in the tree).
      if (asset.kind === "sprite" && asset.frames?.length && !asset.overflowsBounds) {
        const frameIndex = child ? clamp(child.currentFrame, 0, asset.frames.length - 1) : 0;
        out.push(spriteNode(key, order.n++, asset, asset.frames[frameIndex], matrix, opacity, instance, child?.currentFrame, colorTransform));
        if (child && asset.timeline?.length) this.collectButtons(child, matrix, colorTransform, key, order, out);
        continue;
      }

      // Sprite whose animated content slides outside its baked-frame bounds (e.g. the nav
      // cascade buttons), or a sprite with only a nested timeline (no baked frames) →
      // render from the display-list tree so the moving content isn't clipped/dropped.
      if (asset.kind === "sprite" && asset.timeline?.length && child && child.characterId === asset.id) {
        this.clipByPath.set(key, child);
        this.flatten(child, matrix, opacity, colorTransform, key, order, out);
        continue;
      }

      if (asset.kind === "button") {
        // Tree path: no baked frame behind the button, so render its up-state artwork (its
        // icon). The build strips any embedded editText glyphs from that art (FFDec bakes
        // them clipped/mispositioned), so the live field value is drawn by collectButtonText
        // on top — giving the icon AND the correct label (e.g. segment5's Replay button).
        out.push(buttonNode(key, order.n++, asset, matrix, instance, path, true, opacity, this.buttonVisualStates.get(key), colorTransform));
        this.collectButtonText(asset, matrix, colorTransform, key, order, out, instance);
        continue;
      }

      out.push(this.leafNode(key, order.n++, asset, asset.src ?? "", matrix, opacity, instance, colorTransform));
    }
    this.collectLatentButtons(clip, world, worldColorTransform, path, order, out, occupiedDepths, worldOpacity);
    flushMasks(Number.POSITIVE_INFINITY);
  }


  /**
   * Overlay interactive/dynamic leaves living inside a baked sprite: transparent
   * button hit areas, and dynamic text fields bound to a loadVariables() variable
   * (those are baked EMPTY in the sprite frame, so we draw them on top — e.g. the
   * nav's "Skip Intro" and "Best for Business" headings).
   */
  private collectButtons(
    clip: ClipInstance,
    world: RenderNode["matrix"],
    worldColorTransform: RenderNode["colorTransform"],
    path: string,
    order: { n: number },
    out: RenderNode[],
  ) {
    this.clipByPath.set(path, clip);
    const frames = this.framesFor(clip);
    if (!frames) return;
    const frame = frames[clip.currentFrame];
    if (!frame) return;
    const occupiedDepths = new Set(frame.instances.map((instance) => instance.depth));

    for (const instance of frame.instances) {
      if (instance.clipDepth) continue; // a mask shape — not an overlay leaf
      const asset = this.getAsset(instance.characterId);
      if (!asset) continue;
      const matrix = multiplyMatrix(world, instance.matrix);
      const colorTransform = composeColorTransform(worldColorTransform, instance.colorTransform);
      const key = `${path}/${instance.depth}`;
      if (asset.kind === "button") {
        // Baked path: the button's visual is in the composited frame — just a hit area.
        out.push(buttonNode(key, order.n++, asset, matrix, instance, path, false, 1, this.buttonVisualStates.get(key), colorTransform));
        this.collectButtonText(asset, matrix, colorTransform, key, order, out, instance);
      } else if (asset.kind === "text") {
        // editText is stripped from the baked sprite frame (FFDec bakes it mispositioned),
        // so re-draw it here at its own bounds: a loadVariables()-bound field once its value
        // loads, or a static field (e.g. the "Best for Business" nav title) from its own text.
        const field = this.resolveTextField(asset.id, asset);
        const show = field?.normalizedVariableName
          ? this.textVars.has(field.normalizedVariableName)
          : Boolean(field?.text && String(field.text).trim());
        if (show) {
          out.push(this.leafNode(key, order.n++, asset, asset.src ?? "", matrix, instance.opacity, instance, colorTransform));
        }
      } else if (asset.kind === "sprite") {
        const child = clip.childClips.get(instance.depth);
        if (child) this.collectButtons(child, matrix, colorTransform, key, order, out);
      }
    }
    this.collectLatentButtons(clip, world, worldColorTransform, path, order, out, occupiedDepths);
  }

  private collectLatentButtons(
    clip: ClipInstance,
    world: RenderNode["matrix"],
    worldColorTransform: RenderNode["colorTransform"],
    path: string,
    order: { n: number },
    out: RenderNode[],
    occupiedDepths: Set<number>,
    opacity = 1,
  ) {
    if (clip.characterId === ROOT_ID || clip.playing) return;
    for (const instance of this.latentButtonPlacements(clip)) {
      if (occupiedDepths.has(instance.depth)) continue;
      const asset = this.getAsset(instance.characterId);
      if (!asset || asset.kind !== "button") continue;
      const matrix = multiplyMatrix(world, instance.matrix);
      const colorTransform = composeColorTransform(worldColorTransform, instance.colorTransform);
      const key = `${path}/${instance.depth}`;
      out.push(buttonNode(key, order.n++, asset, matrix, instance, path, false, opacity, this.buttonVisualStates.get(key), colorTransform));
    }
  }

  private latentButtonPlacements(clip: ClipInstance): TimelineFrame["instances"] {
    const cacheKey = clip.characterId;
    const cached = this.latentButtonPlacementsCache.get(cacheKey);
    if (cached) return cached;
    const frames = this.framesFor(clip);
    if (!frames?.length) {
      this.latentButtonPlacementsCache.set(cacheKey, []);
      return [];
    }

    const byDepth = new Map<number, TimelineFrame["instances"][number]>();
    for (const frame of frames) {
      for (const instance of frame.instances ?? []) {
        if (byDepth.has(instance.depth)) continue;
        const asset = this.getAsset(instance.characterId);
        if (asset?.kind !== "button" || !this.buttonControlsOwnerTimeline(instance.characterId)) continue;
        byDepth.set(instance.depth, instance);
      }
    }
    const placements = [...byDepth.values()];
    this.latentButtonPlacementsCache.set(cacheKey, placements);
    return placements;
  }

  private buttonControlsOwnerTimeline(characterId: number): boolean {
    const group = this.timeline.control?.buttonActions?.[String(characterId)];
    if (!group) return false;
    return (["rollOver", "press", "release", "rollOut"] as const).some((event) => {
      const action = group[event];
      return Boolean(action && (action.command === "gotoAndPlay" || action.command === "gotoAndStop") && isSelfTimelineTarget(action.target));
    });
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
    buttonColorTransform: RenderNode["colorTransform"],
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
      out.push(this.leafNode(`${key}/txt:${field.id}`, order.n++, fieldAsset, fieldAsset.src ?? "", matrix, instance.opacity, instance, buttonColorTransform));
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
    colorTransform: RenderNode["colorTransform"] = instance.colorTransform,
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
      colorTransform,
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
    if (varName && this.textVars.has(varName)) {
      const text = this.textVars.get(varName) ?? "";
      return { ...merged, text, align: loadedTextAlign(text, merged.align, Boolean(merged.html)) };
    }
    return merged;
  }

  // --- ambient sound ----------------------------------------------------

  private primeAmbientSound() {
    if (!this.options.onSound) return;
    let music: ControlAction | undefined;
    for (let frame = 0; frame < this.root.currentFrame; frame += 1) {
      for (const action of this.rootActions.get(frame) ?? []) {
        if (action.command === "attachSound" && action.soundRole === "music") music = action;
      }
    }
    if (music) this.options.onSound(music);
  }
}

function isSelfTimelineTarget(target: string | undefined): boolean {
  return !target || target === "self" || target === "this" || target === "_root" || target === "_level0" || target === "root";
}

function isEmptyNonRootLevelAssignment(target: string, value: VarValue): boolean {
  return value === "" && NON_ROOT_LEVEL_TARGET.test(target);
}

function composeColorTransform(parent: RenderNode["colorTransform"], child: RenderNode["colorTransform"]): RenderNode["colorTransform"] {
  if (!parent) return child;
  if (!child) return parent;
  const rm = (child.rm ?? 1) * (parent.rm ?? 1);
  const gm = (child.gm ?? 1) * (parent.gm ?? 1);
  const bm = (child.bm ?? 1) * (parent.bm ?? 1);
  const ra = (child.ra ?? 0) * (parent.rm ?? 1) + (parent.ra ?? 0);
  const ga = (child.ga ?? 0) * (parent.gm ?? 1) + (parent.ga ?? 0);
  const ba = (child.ba ?? 0) * (parent.bm ?? 1) + (parent.ba ?? 0);
  if (rm === 1 && gm === 1 && bm === 1 && ra === 0 && ga === 0 && ba === 0) return undefined;
  return { rm, gm, bm, ra, ga, ba };
}

function buttonReleaseKey(action: ControlAction | undefined): string {
  if (!action) return "";
  const nav = action.exitNavigation;
  if (nav) return ["exit", nav.variable, nav.value, nav.swf, nav.level ?? "", nav.exitLabel ?? "", nav.exitFrame].join("|");
  if (!action.swf && action.frame === undefined && !action.label) return "";
  return ["release", action.command ?? "", action.target ?? "", action.swf ?? "", action.level ?? "", action.label ?? "", action.frame ?? ""].join("|");
}

function buttonOwnerGroupsOverlap(a: ButtonActionRecord, b: ButtonActionRecord): boolean {
  const owners = new Set((a.ownerSpriteIds ?? []).map(String));
  return (b.ownerSpriteIds ?? []).some((id) => owners.has(String(id)));
}

function buttonTimelineActionsMatch(a: ControlAction | undefined, b: ControlAction | undefined): boolean {
  if (!a || !b) return false;
  if (a.command !== b.command) return false;
  if ((a.target ?? "self") !== (b.target ?? "self")) return false;
  if ((a.label ?? "") !== (b.label ?? "")) return false;
  if ((a.frame ?? "") !== (b.frame ?? "")) return false;
  if ((a.frameExpression ?? "") !== (b.frameExpression ?? "")) return false;
  return true;
}

function conditionReferencesTarget(condition: string | undefined, target: string): boolean {
  if (!condition) return false;
  const normalized = normalizeVarName(target);
  const variants = new Set([
    target,
    normalized,
    normalized.replace(/^_root\./i, ""),
    normalized.replace(/^_level0\./i, ""),
  ].filter(Boolean));
  for (const name of variants) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`).test(condition)) return true;
  }
  return false;
}

function firstRawArg(argsRaw: string | undefined, index: number): string | undefined {
  return splitTopLevelArgs(argsRaw)[index]?.trim();
}

function levelFromValue(value: VarValue | undefined, raw?: string): number | undefined {
  const fromValue = parseLevel(value);
  return fromValue ?? parseLevel(raw);
}

function parseLevel(value: VarValue | string | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).replace(/^["']|["']$/g, "").trim();
  const match = /^_level(\d+)$/i.exec(text);
  const n = Number(match?.[1] ?? text);
  return Number.isFinite(n) ? n : undefined;
}

function loadedTextAlign(text: string, fallback: string | undefined, html: boolean): string | undefined {
  if (!html) return fallback;
  const declared = text.match(/<p\b[^>]*\balign\s*=\s*["']?(left|center|right|justify)\b/i)
    ?? text.match(/\btext-align\s*:\s*(left|center|right|justify)\b/i);
  if (declared?.[1]) return declared[1].toLowerCase();
  return "left";
}

function isPrefixInstanceName(candidate: string, target: string): boolean {
  if (!candidate || !target || candidate === target || !candidate.startsWith(target)) return false;
  return /^[A-Z0-9_$]/.test(candidate.slice(target.length));
}

function callMatchesSoundMetadata(call: NonNullable<ControlAction["functionCalls"]>[number], soundAction: SoundActionMetadata | undefined): boolean {
  if (!soundAction) return false;
  if (soundAction.command === "markSndSegment") return call.functionName === "markSnd" || call.functionName === "markSndSegment";
  return call.functionName === soundAction.command;
}

function actionSoundKey(action: ControlAction): string | undefined {
  switch (action.command) {
    case "attachSound":
      return soundKey("attachSound", action.sound ?? action.resolvedSound);
    case "playVO":
      return soundKey("playVO", action.sound ?? action.resolvedSound);
    case "markSndSegment":
      return soundKey("markSndSegment", action.segment ?? action.sound ?? action.resolvedSound);
    case "stopSound":
      return action.target ? soundKey("stopSound", normalizeVarName(action.target)) : undefined;
    default:
      return undefined;
  }
}

function soundKey(kind: string, value: VarValue | string | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return `${kind}:${String(value)}`;
}

function stripQuotes(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return undefined;
}

function singleArgCall(token: string, name: string): string | undefined {
  const prefix = `${name}(`;
  if (!token.startsWith(prefix) || !token.endsWith(")")) return undefined;
  let depth = 0;
  let quote = "";
  for (let i = name.length; i < token.length; i += 1) {
    const c = token[i];
    if (quote) {
      if (c === quote && token[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0 && i !== token.length - 1) return undefined;
    }
  }
  return depth === 0 ? token.slice(prefix.length, -1).trim() : undefined;
}
