import type {
  AssetTimeline,
  BodyStatement,
  ButtonActionRecord,
  ControlAction,
  DefinedFunction,
  DynamicText,
  Matrix,
  TimelineAsset,
  TimelineFrame,
} from "../data/timelineTypes";
import { assetUrl } from "../data/TimelineLoader";
import { collectExplicitSoundTimings } from "../data/soundTimings";
import type { DomRenderer } from "../render/DomRenderer";
import { isLocalVar, localizeCondition, normalizeAvm1PropertyName, splitTopLevelArgs } from "./avm1";
import {
  buttonNode,
  composeRenderColorTransform,
  findChildByName,
  isClipAsset,
  renderMetadataFromInstance,
  spriteNode,
  visualSrc,
  type ButtonVisualState,
} from "./renderNodes";
import { ClipInstance } from "./ClipInstance";
import { runDataDrivenApp, type AppClip, type AppText, type DataDrivenApp, type PlayerBridge } from "./avm1App";
import { evalCondition } from "./conditions";
import { IDENTITY, multiplyMatrix } from "./matrix";
import { Ticker } from "./Ticker";
import { clamp, type RenderNode, type RenderPlacementMetadata } from "./types";
import { normalizeVarName } from "./VariableStore";
import type { VariableStore, VarValue } from "./VariableStore";

export type ButtonEvent = "rollOver" | "rollOut" | "press" | "release" | "releaseOutside";
type ButtonActionEvent = Exclude<ButtonEvent, "releaseOutside">;

/** A user-defined AVM1 function: gated self-timeline actions (frameActions) plus a
 *  branch-aware body (assignments + method-calls), parameterised by `parameters`. */
type FunctionDef = {
  parameters: string[];
  actions: ControlAction[];
  body: BodyStatement[];
  calls: NonNullable<DefinedFunction["calls"]>;
};

/** Local parameter bindings for the currently-executing function call. */
type Locals = Record<string, VarValue | undefined>;
type SoundBinding = { sound: string; soundSrc?: string; soundDurationMs?: number };
type SoundLibraryEntry = { name?: string; src?: string; durationMs?: number; aliases?: string[] };
type SoundActionMetadata = NonNullable<ControlAction["soundAction"]>;
type RuntimeTimerId = ReturnType<typeof setTimeout>;
type DragState = { clip: ClipInstance; left?: number; top?: number; right?: number; bottom?: number };
type TextOverride = Partial<DynamicText> & { text?: string; html?: boolean };
type RuntimeControl = "break" | "continue" | undefined;

/** Timeline commands that, with a target, are clip controls (vs function calls). */
const TIMELINE_COMMANDS = new Set(["gotoAndPlay", "gotoAndStop", "play", "stop", "nextFrame", "prevFrame"]);
/** AVM1 "wait until condition / timer" helpers handled as a runtime primitive. */
const WAITER_FUNCTIONS = new Set(["waitForVal", "startTimer"]);
/** Timing-only VO marker helpers. */
const SOUND_MARKER_FUNCTIONS = new Set(["markSnd", "markSndSegment"]);
const NON_ROOT_LEVEL_TARGET = /^_level[1-9]\d*\b/i;
const AVM1_OWNER_CLIP = "__avm1OwnerClip";
const AVM1_OWNER_PROPERTY = "__avm1OwnerProperty";

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
  /** Host hook: fired when the movie issues an AVM1 `fscommand(command, args)` (e.g. the
   *  tour's quit button → `fscommand("quit")`). The host decides what it means. */
  onFsCommand?: (command: string, args: string) => void;
  /** Host hook: fired when AVM1 asks the player to open/navigate to a URL. */
  onGetURL?: (url: string, target?: string) => void;
  /** Resolve a SWF loaded into a MovieClipLoader target to its extracted timeline, if available. */
  loadTimeline?: (swf: string) => Promise<AssetTimeline | null>;
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
  /** Resolve a text field's fontId to its CSS font-family stack (shared with the renderer),
   *  so the player can measure `textWidth`/autoSize `_width` with the real embedded metrics. */
  resolveFontFamily?: (fontId?: number) => string | undefined;
  /** Resolves once the scene's embedded fonts have loaded. A data-driven app's bootstrap
   *  waits on this so its one-shot, `textWidth`-driven layout measures the real faces. */
  awaitFonts?: () => Promise<void>;
};

const ROOT_ID = -1;
const MAX_GOTO_DEPTH = 24;
const MAX_FUNCTION_REENTRY = 8;
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
  private destroyed = false;
  /** Frame driver for a running data-driven app (bnl), advanced on each tick. */
  private dataApp: DataDrivenApp | null = null;

  private readonly assets: Record<string, TimelineAsset>;
  private readonly linkageAssetIds = new Map<string, number>();
  private readonly linkageClassKeys = new Map<string, string>();
  private readonly rootFrames: TimelineFrame[];
  private readonly startFrame: number;

  private readonly rootStop: Set<number>;
  private readonly rootActions = new Map<number, ControlAction[]>();
  private readonly spriteActions = new Map<string, ControlAction[]>();
  private readonly spriteStop = new Map<number, Set<number>>();
  private readonly functions = new Map<string, FunctionDef>();
  private readonly methodFunctions = new Map<string, FunctionDef>();
  /** Sprite-scoped functions (e.g. a button/fade clip's `doFade`), by characterId → name. */
  private readonly spriteFunctions = new Map<number, Map<string, FunctionDef>>();
  private readonly store?: VariableStore;
  /** Text-field variables loaded via loadVariables() (key → value), keyed by the
   *  field's normalized variableName (e.g. `skipIntro`, `h_Segment4`). */
  private readonly textVars = new Map<string, string>();
  private readonly textOverrides = new Map<number, TextOverride>();
  private readonly clipTextOverrides = new WeakMap<ClipInstance, Map<string, TextOverride>>();
  private readonly explicitLeafProps = new WeakMap<Record<string, VarValue | undefined>, Set<string>>();
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
  // Set once any clip gains a runtime-attached child (attachMovie/createEmptyMovieClip).
  // Gates the per-frame subtree scan in flatten() so attachMovie-free scenes pay nothing.
  private hasAnyDynamicInstances = false;
  private readonly functionReentry = new Map<string, number>();
  private readonly runtimeTimers = new Set<RuntimeTimerId>();
  private activeDrag: DragState | undefined;

  constructor(timeline: AssetTimeline, renderer: DomRenderer, options: PlayerOptions = {}) {
    this.timeline = timeline;
    this.renderer = renderer;
    this.options = options;
    this.assets = timeline.assets ?? {};
    for (const asset of Object.values(this.assets)) {
      for (const name of asset.linkageNames ?? []) this.linkageAssetIds.set(normalizeLinkageName(name), asset.id);
    }
    for (const [linkageName, classPath] of Object.entries(timeline.control?.registeredClasses ?? {})) {
      const className = classPath.split(".").pop() ?? classPath;
      const sourceKey = normalizeMethodKey(className);
      if (sourceKey) this.linkageClassKeys.set(normalizeLinkageName(linkageName), sourceKey);
    }
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
    this.tryRunDataDrivenApp();
  }

  /** If this scene is a data-driven AS2 app (carries #initclip class programs + an
   *  entry frame), run it through the AVM1 VM so it builds its own UI from its XML.
   *  Gated on that bytecode, so timeline-script SWFs (the tour) are untouched. */
  private tryRunDataDrivenApp() {
    const control = this.timeline.control as { initActions?: unknown[]; frameBytecode?: { frame: number }[] } | undefined;
    if (!control?.initActions?.length || !control?.frameBytecode?.length) return;
    // The app lays itself out from `textWidth` (e.g. the top-nav positions each item
    // by the previous label's measured width). Those measurements are only correct
    // once the embedded fonts have loaded, and the layout runs once — so wait for the
    // fonts first. Without this the layout can measure the fallback face and the bar
    // drifts permanently. Falls through synchronously when no awaitFonts is provided.
    const fontsReady = this.options.awaitFonts?.();
    if (fontsReady) {
      fontsReady.then(() => this.runDataDrivenAppNow(control)).catch(() => this.runDataDrivenAppNow(control));
      return;
    }
    this.runDataDrivenAppNow(control);
  }

  private runDataDrivenAppNow(control: { initActions?: unknown[]; frameBytecode?: { frame: number }[] }) {
    if (this.destroyed) return; // torn down during the async font wait
    // The app's entry script (e.g. App.main) lives on a later root frame that also
    // places the View container instances. Advance the root there so they exist.
    const bootFrame = Math.max(0, ...control.frameBytecode!.map((f) => Number(f.frame) || 0));
    if (this.root.currentFrame !== bootFrame) this.root = this.buildRoot(bootFrame);
    const idToLinkage = new Map<number, string>();
    for (const [name, id] of Object.entries((this.timeline as { linkage?: Record<string, number> }).linkage ?? {})) {
      if (!idToLinkage.has(id)) idToLinkage.set(id, name);
    }
    for (const asset of Object.values(this.assets)) {
      const names = (asset as { linkageNames?: string[] }).linkageNames;
      if (!names?.length || idToLinkage.has(asset.id)) continue;
      idToLinkage.set(asset.id, names[0]);
    }
    try {
      this.dataApp = runDataDrivenApp(control as never, this.makeAppBridge(idToLinkage));
    } catch (error) {
      console.warn("[avm1App] data-driven app bootstrap failed", error);
    }
  }

  private makeAppBridge(idToLinkage: Map<number, string>): PlayerBridge {
    const asClip = (clip: ClipInstance): AppClip => { (clip as unknown as { __appClip: boolean }).__appClip = true; return clip as unknown as AppClip; };
    const toClip = (c: AppClip): ClipInstance => c as unknown as ClipInstance;
    return {
      root: () => asClip(this.root),
      child: (clip, name) => {
        const owner = toClip(clip);
        const sub = findChildByName(owner, name) ?? this.findClipByName(owner, name);
        if (sub) return asClip(sub);
        const textId = this.findTextChildByName(owner, name);
        if (textId !== undefined) return { __appText: true, clip, field: name } as AppText;
        return undefined;
      },
      attachMovie: (parent, linkage, name, depth) => {
        const child = this.attachMovieByLinkage(toClip(parent), linkage, name, depth);
        return child ? asClip(child) : undefined;
      },
      createEmptyMovieClip: (parent, name, depth) => asClip(this.createEmptyClip(toClip(parent), name, depth)),
      setText: (t, value, html) => {
        const owner = toClip(t.clip);
        const id = this.findTextChildByName(owner, t.field);
        if (id === undefined) return;
        const override = this.textOverrideFor({ id, owner, name: t.field });
        override.text = value; override.html = html;
        owner.mutatedLeaves.add(t.field);
      },
      getText: (t) => {
        const owner = toClip(t.clip);
        const id = this.findTextChildByName(owner, t.field);
        if (id === undefined) return "";
        return String(this.clipTextOverrides.get(owner)?.get(t.field)?.text ?? this.textOverrides.get(id)?.text ?? "");
      },
      getTextProp: (t, key) => this.getAppTextProp(toClip(t.clip), t.field, normalizeAvm1PropertyName(key) ?? key),
      setTextProp: (t, key, value) => {
        const owner = toClip(t.clip);
        this.setLeafDisplayProp(owner, t.field, normalizeAvm1PropertyName(key) ?? key, value as VarValue);
      },
      getClipProp: (clip, key) => this.getAppClipProp(toClip(clip), normalizeAvm1PropertyName(key) ?? key),
      setClipProp: (clip, key, value) => { setClipProperty(toClip(clip), normalizeAvm1PropertyName(key) ?? key, value as VarValue); },
      clipField: (clip, key) => toClip(clip).props[key],
      setClipField: (clip, key, value) => {
        const owner = toClip(clip);
        if (value === undefined || value === null) delete owner.props[key];
        else owner.props[key] = value as VarValue;
      },
      hasClipField: (clip, key) => Object.prototype.hasOwnProperty.call(toClip(clip).props, key),
      linkageOf: (clip) => idToLinkage.get(toClip(clip).characterId),
      nextDepth: (clip) => this.nextHighestDepth(toClip(clip)),
      render: () => this.render(),
      fetchText: (url, onText) => {
        void fetch(assetUrl(url))
          .then((response) => (response.ok && !/\btext\/html\b/i.test(response.headers.get("content-type") ?? "") ? response.text() : null))
          .then(onText)
          .catch(() => onText(null));
      },
      setPointerEventHandler: (clip, handler) => {
        const owner = toClip(clip);
        if (handler) owner.props.__appPointerDispatcher = handler as unknown as VarValue;
        else delete owner.props.__appPointerDispatcher;
      },
      timelineCommand: (clip, command, frame) => this.runAppClipTimelineCommand(toClip(clip), command, frame as VarValue | undefined),
      setClipMethodDispatcher: (clip, dispatcher) => {
        const owner = toClip(clip);
        if (dispatcher) owner.props.__appMethodDispatcher = dispatcher as unknown as VarValue;
        else delete owner.props.__appMethodDispatcher;
      },
    };
  }

  /** attachMovie() by linkage name, returning the new clip (no legacy AS2 constructor —
   *  the data-driven app VM runs the class constructor itself). */
  private attachMovieByLinkage(owner: ClipInstance, linkage: string, name: string, depth: number): ClipInstance | undefined {
    const characterId = this.linkageAssetIds.get(normalizeLinkageName(linkage));
    if (!characterId || !this.getAsset(characterId) || !Number.isFinite(depth)) return undefined;
    owner.dynamicInstances.set(depth, { depth, characterId, placedFrame: owner.currentFrame, matrix: { ...IDENTITY }, opacity: 1, name });
    this.hasAnyDynamicInstances = true;
    owner.displayListMutated = true;
    owner.depthNames.set(depth, name);
    const child = new ClipInstance(characterId, name, owner);
    child.scriptKey = this.clipSourceKey(this.getAsset(characterId), name);
    owner.childClips.set(depth, child);
    this.enterFrame(child, 0, 0);
    return child;
  }

  private createEmptyClip(owner: ClipInstance, name: string, depth: number): ClipInstance {
    owner.dynamicInstances.set(depth, { depth, characterId: 0, placedFrame: owner.currentFrame, matrix: { ...IDENTITY }, opacity: 1, name });
    this.hasAnyDynamicInstances = true;
    owner.displayListMutated = true;
    owner.depthNames.set(depth, name);
    const child = new ClipInstance(0, name, owner);
    owner.childClips.set(depth, child);
    return child;
  }

  private runAppClipTimelineCommand(clip: ClipInstance, command: string, frame?: VarValue): boolean {
    switch (command) {
      case "play":
        clip.playing = true;
        this.render();
        return true;
      case "stop":
        clip.playing = false;
        this.render();
        return true;
      case "nextFrame": {
        const frames = this.framesFor(clip);
        if (!frames?.length) return false;
        clip.playing = false;
        this.enterFrame(clip, Math.min(frames.length - 1, clip.currentFrame + 1), 0);
        this.render();
        return true;
      }
      case "prevFrame": {
        clip.playing = false;
        this.enterFrame(clip, Math.max(0, clip.currentFrame - 1), 0);
        this.render();
        return true;
      }
      case "gotoAndPlay":
      case "gotoAndStop": {
        const frameIndex = this.resolveClipFrame(clip, frame ?? 1);
        if (frameIndex < 0) return false;
        clip.playing = command === "gotoAndPlay";
        this.enterFrame(clip, frameIndex, 0);
        this.render();
        return true;
      }
      default:
        return false;
    }
  }

  private getAppClipProp(clip: ClipInstance, key: string): VarValue | undefined {
    if (this.shouldUseLiveClipBounds(clip) && ((key === "_width" && clip.width === undefined) || (key === "_height" && clip.height === undefined))) {
      const bounds = this.liveClipBounds(clip);
      if (key === "_width" && bounds) return bounds.width;
      if (key === "_height" && bounds) return bounds.height;
    }
    return readClipProperty(clip, key, this.getAsset(clip.characterId));
  }

  private getAppTextProp(owner: ClipInstance, name: string, key: string): VarValue | undefined {
    const props = this.leafDisplayProps(owner, name);
    const explicit = this.explicitLeafProps.get(props);
    if (explicit?.has(key)) return props[key];
    const id = this.findTextChildByName(owner, name);
    const asset = id === undefined ? undefined : this.getAsset(id);
    if (!asset || asset.kind !== "text") return undefined;
    const text = this.resolveTextField(asset.id, asset, owner, name);
    const metrics = this.liveTextMetrics(asset, text, props);
    switch (key) {
      case "_width":
      case "textWidth":
        return metrics.width;
      case "_height":
      case "textHeight":
        return metrics.height;
      case "textColor":
        return Number.parseInt((text?.color ?? "#000000").replace(/^#/, ""), 16);
      default:
        return undefined;
    }
  }

  private liveClipBounds(clip: ClipInstance): { width: number; height: number } | undefined {
    const frame = this.framesFor(clip)?.[clip.currentFrame];
    const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (const instance of this.instancesForFrame(clip, frame)) {
      const asset = this.getAsset(instance.characterId);
      if (!asset) continue;
      const props = instance.name ? clip.leafProps.get(instance.name) : undefined;
      let origin = asset.origin;
      if (asset.kind === "text" && clip.mutatedLeaves.has(instance.name ?? "")) {
        const text = this.resolveTextField(asset.id, asset, clip, instance.name);
        const metrics = this.liveTextMetrics(asset, text, props);
        origin = { ...origin, width: metrics.width, height: metrics.height };
      } else if (props) {
        origin = applyLeafOriginOverrides(asset, props);
      }
      if (!origin.width && !origin.height) continue;
      boxes.push(transformedBounds(origin, instance.matrix));
    }
    if (!boxes.length) return undefined;
    const minX = Math.min(...boxes.map((box) => box.x));
    const minY = Math.min(...boxes.map((box) => box.y));
    const maxX = Math.max(...boxes.map((box) => box.x + box.width));
    const maxY = Math.max(...boxes.map((box) => box.y + box.height));
    return { width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
  }

  private shouldUseLiveClipBounds(clip: ClipInstance): boolean {
    return clip.displayListMutated || clip.mutatedLeaves.size > 0;
  }

  private setLeafDisplayProp(clip: ClipInstance, name: string, key: string, value: VarValue | undefined) {
    if (key === "textColor") {
      const id = this.findTextChildByName(clip, name);
      if (id !== undefined) {
        const override = this.textOverrideFor({ id, owner: clip, name });
        const color = flashColor(value);
        if (color) override.color = color;
        else delete override.color;
        clip.mutatedLeaves.add(name);
      }
      return;
    }
    const props = this.leafDisplayProps(clip, name);
    if (value === undefined || value === null) delete props[key];
    else props[key] = value;
    let explicit = this.explicitLeafProps.get(props);
    if (!explicit) {
      explicit = new Set();
      this.explicitLeafProps.set(props, explicit);
    }
    if (value === undefined || value === null) explicit.delete(key);
    else explicit.add(key);
    clip.mutatedLeaves.add(name);
  }

  private liveTextMetrics(asset: TimelineAsset, text: ReturnType<Player["resolveTextField"]>, props?: Record<string, VarValue | undefined>): { width: number; height: number } {
    const fallbackWidth = asset.text?.width ?? asset.origin.width ?? 0;
    const fallbackHeight = asset.text?.height ?? asset.origin.height ?? 0;
    if (!text) return { width: fallbackWidth, height: fallbackHeight };
    const fontHeight = Number(text.fontHeight);
    const explicitLineHeight = Number(text.lineHeight);
    const lineHeight = Math.max(
      1,
      Number.isFinite(explicitLineHeight) && explicitLineHeight > 0
        ? explicitLineHeight
        : Number.isFinite(fontHeight) && fontHeight > 0
          ? fontHeight + Number(text.leading ?? 0)
          : fallbackHeight || 12,
    );
    const autoSize = props?.autoSize !== undefined ? avm1Boolean(props.autoSize) : false;
    const realWidth = this.measureTextWidthPx(text.text ?? "", Number(text.fontHeight), text.fontId ?? asset.text?.fontId);
    const width = realWidth != null
      // Flash autoSize fields are textWidth + a 2px gutter on each side; non-autoSize
      // fields keep their authored bounds unless the text is wider (then it reports the
      // text width, matching the heuristic path the app already relied on).
      ? (autoSize ? realWidth + 4 : Math.max(fallbackWidth, realWidth))
      : measuredTextWidth(text.text ?? "", text.fontHeight, fallbackWidth, autoSize);
    const charsPerLine = Math.max(1, Math.floor(Math.max(1, autoSize ? fallbackWidth || width : fallbackWidth || width) / Math.max(1, lineHeight * 0.62)));
    const plain = (text.text ?? "").replace(/<[^>]+>/g, "").trim();
    const explicitLines = plain ? plain.split(/\r?\n/).length : 1;
    const wrappedLines = plain ? Math.ceil(plain.length / charsPerLine) : 1;
    const contentHeight = Math.max(lineHeight, Math.max(explicitLines, wrappedLines) * lineHeight);
    return { width, height: autoSize ? contentHeight : Math.max(fallbackHeight, contentHeight) };
  }

  private measureCtx?: CanvasRenderingContext2D | null;
  /** Measure a line's pixel width with the field's real embedded font (its advance
   *  widths, like Flash's `textWidth`) so autoSize/`_width`-driven layouts — e.g. the
   *  bnl top-nav, which positions each item by the previous one's measured width —
   *  match Ruffle instead of a fixed char-count estimate. Returns undefined when no
   *  DOM/canvas is available or the embedded face has not loaded yet (the caller then
   *  falls back to the estimate), and the widest line's width for multi-line text. */
  private measureTextWidthPx(text: string, fontHeightPx: number, fontId?: number): number | undefined {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return undefined;
    if (!Number.isFinite(fontHeightPx) || fontHeightPx <= 0) return undefined;
    const family = this.options.resolveFontFamily?.(fontId);
    if (!family) return undefined;
    const stripped = text.replace(/<[^>]+>/g, "");
    if (!stripped.trim()) return 0;
    // Only trust real metrics once the embedded face has loaded; otherwise canvas would
    // measure a fallback system font and report the wrong width.
    const primary = family.split(",")[0].trim().replace(/^["']|["']$/g, "");
    try { if (document.fonts && !document.fonts.check(`${fontHeightPx}px "${primary}"`)) return undefined; } catch { return undefined; }
    if (this.measureCtx === undefined) this.measureCtx = document.createElement("canvas").getContext("2d");
    const ctx = this.measureCtx;
    if (!ctx) return undefined;
    ctx.font = `${fontHeightPx}px ${family}`;
    let max = 0;
    for (const line of stripped.split(/\r?\n/)) {
      const w = ctx.measureText(line.replace(/\s+$/, "")).width;
      if (w > max) max = w;
    }
    return max;
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
    this.clearRuntimeTimers();
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
    this.destroyed = true;
    this.dataApp = null;
    this.ticker.destroy();
    this.clearRuntimeTimers();
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
      this.dispatchMovieClipPointerEvent(owner, event);
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
    // fscommand(command, args) — e.g. the tour's quit button. Surface it so the host
    // decides the response (close the tour, etc.); there is no in-player default.
    if (action.command === "fsCommand") this.options.onFsCommand?.(String(action.value ?? ""), action.arguments ?? "");
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

  handlePointerDrag(dx: number, dy: number) {
    const drag = this.activeDrag;
    if (!drag) return;
    const nextX = clamp(Number(drag.clip.x ?? 0) + dx, drag.left ?? Number.NEGATIVE_INFINITY, drag.right ?? Number.POSITIVE_INFINITY);
    const nextY = clamp(Number(drag.clip.y ?? 0) + dy, drag.top ?? Number.NEGATIVE_INFINITY, drag.bottom ?? Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextX)) drag.clip.x = nextX;
    if (Number.isFinite(nextY)) drag.clip.y = nextY;
    this.render();
  }

  private buttonActionFor(owner: ClipInstance, characterId: number, event: ButtonEvent): ControlAction | undefined {
    if (event === "releaseOutside") return undefined;
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
    if (event === "release" || event === "releaseOutside") return [];
    const groups = this.timeline.control?.buttonActions ?? {};
    const group = groups[String(characterId)];
    const releaseKey = buttonReleaseKey(group?.release);
    if (!group || !releaseKey) return [];
    const out: Array<{ owner: ClipInstance; characterId: number; action: ControlAction }> = [];
    const scope = owner.parent ?? owner;
    for (const [candidateId, candidateGroup] of Object.entries(groups)) {
      const id = Number(candidateId);
      if (!Number.isFinite(id) || id === characterId) continue;
      const actionEvent = event as ButtonActionEvent;
      const candidateAction = candidateGroup[actionEvent];
      if (!candidateAction) continue;
      if (buttonReleaseKey(candidateGroup.release) !== releaseKey) continue;
      if (!buttonOwnerGroupsOverlap(group, candidateGroup)) continue;
      if (!buttonTimelineActionsMatch(group[actionEvent], candidateAction)) continue;
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
      case "releaseOutside":
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
    const newDef = (): FunctionDef => ({ parameters: [], actions: [], body: [], calls: [] });
    for (const def of Object.values(control?.definedFunctions ?? {})) {
      const name = def?.functionName;
      if (!name) continue;
      const entry = this.functions.get(name) ?? newDef();
      if (def.parameters?.length) entry.parameters = def.parameters;
      if (def.actions?.length) entry.actions.push(...def.actions);
      if (def.body?.length) entry.body.push(...def.body);
      if (def.calls?.length) entry.calls.push(...def.calls);
      this.functions.set(name, entry);
      const sourceKey = methodSourceKey(def.source);
      if (sourceKey) {
        const methodKey = methodFunctionKey(sourceKey, name);
        const methodEntry = this.methodFunctions.get(methodKey) ?? newDef();
        if (def.parameters?.length) methodEntry.parameters = def.parameters;
        if (def.actions?.length) methodEntry.actions.push(...def.actions);
        if (def.body?.length) methodEntry.body.push(...def.body);
        if (def.calls?.length) methodEntry.calls.push(...def.calls);
        this.methodFunctions.set(methodKey, methodEntry);
      }
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
    return this.callFunctionDef(name, def, argsRaw, callerLocals, this.root);
  }

  private callFunctionDef(
    key: string,
    def: FunctionDef,
    argsRaw: string | undefined,
    callerLocals: Locals | undefined,
    scope: ClipInstance,
    argScope: ClipInstance = scope,
  ): boolean {
    const reentry = this.functionReentry.get(key) ?? 0;
    if (reentry >= MAX_FUNCTION_REENTRY) return false;
    this.functionReentry.set(key, reentry + 1);
    try {
    const locals = this.bindParams(def.parameters, argsRaw, callerLocals, argScope);
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
    const bodyDecisions = this.functionBodyDecisions(def.body, locals, scope);
    const bodyConstructors = new Set(
      def.body
        .filter((s, i) => bodyDecisions[i] && s.kind === "assign")
        .map((s) => constructorCallName((s as Extract<BodyStatement, { kind: "assign" }>).rawValue))
        .filter((name): name is string => Boolean(name)),
    );
    const firedBodyCalls = new Set<string | undefined>([
      ...bodyConstructors,
      ...def.body
        .filter((s, i) => bodyDecisions[i] && s.kind === "call")
        .map((s) => (s as { functionName?: string }).functionName),
    ]);
    for (const call of def.calls) {
      if (firedBodyCalls.has(call.functionName)) continue;
      this.runFunctionCall(call, scope, locals);
    }
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
      this.runFunctionAction(action, locals, scope);
    });
    this.runFunctionBody(def.body, locals, bodyDecisions, scope);
    this.render();
    return true;
    } finally {
      if (reentry) this.functionReentry.set(key, reentry);
      else this.functionReentry.delete(key);
    }
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
  private bindParams(parameters: string[], argsRaw?: string, callerLocals?: Locals, scope: ClipInstance = this.root): Locals {
    const locals: Locals = {};
    if (!parameters.length) return locals;
    const values = this.parseArgs(argsRaw, callerLocals, scope);
    parameters.forEach((param, i) => { locals[param] = values[i]; });
    return locals;
  }

  /** Split a raw arg string on top-level commas and resolve each to a value. */
  private parseArgs(argsRaw: string | undefined, locals?: Locals, scope: ClipInstance = this.root): (VarValue | undefined)[] {
    return splitTopLevelArgs(argsRaw).map((p) => this.resolveExpr(p.trim(), locals, scope));
  }

  /** Milliseconds since page start — AVM1 `getTimer()`. Absolute, so it's consistent
   *  across levels (the nav reads `bkgd.timeTarg` set by `_level0.setTimeMark`). */
  private getTimer(): number {
    return performance.now();
  }

  /** Resolve an assignment RHS / argument expression to a value (param refs → locals). */
  private resolveExpr(raw: string, locals?: Locals, scope: ClipInstance = this.root): VarValue | undefined {
    let e = raw.trim();
    if (e === "") return undefined;
    while (e.startsWith("(") && matchingParenRuntime(e) === e.length - 1) e = e.slice(1, -1).trim();
    if (e === "undefined") return undefined;
    if (e === "null") return null;
    if (e === "_global.Infinity" || e === "Infinity") return Number.POSITIVE_INFINITY;
    if (e === "NaN") return Number.NaN;
    const ternary = splitTopLevelTernary(e);
    if (ternary) return this.resolveExpr(this.evalRuntimeCondition(ternary.condition, locals ?? {}, scope) ? ternary.whenTrue : ternary.whenFalse, locals, scope);
    if (e === "getTimer()") return this.getTimer();
    if (e === "Math.random()") return Math.random();
    if (e === "new Object()") return {};
    if (e === "new Array()" || e === "[]") return [];
    if (e === "new MovieClipLoader()") return { __avm1Type: "MovieClipLoader", listeners: [] };
    const newArrayArgs = singleArgCall(e, "new Array");
    if (newArrayArgs !== undefined) return this.parseArgs(newArrayArgs, locals, scope);
    if (e.startsWith("{") && e.endsWith("}")) return this.resolveObjectLiteral(e, locals, scope);
    const parseIntArg = singleArgCall(e, "parseInt");
    if (parseIntArg !== undefined) {
      const value = this.resolveExpr(parseIntArg, locals, scope);
      const parsed = Number.parseInt(String(value ?? ""), 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    const parseFloatArg = singleArgCall(e, "parseFloat");
    if (parseFloatArg !== undefined) {
      const value = this.resolveExpr(parseFloatArg, locals, scope);
      const parsed = Number.parseFloat(String(value ?? ""));
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    const numberArg = singleArgCall(e, "Number");
    if (numberArg !== undefined) return Number(this.resolveExpr(numberArg, locals, scope) ?? 0);
    const stringArg = singleArgCall(e, "String");
    if (stringArg !== undefined) return String(this.resolveExpr(stringArg, locals, scope) ?? "");
    const booleanArg = singleArgCall(e, "Boolean");
    if (booleanArg !== undefined) return avm1Boolean(this.resolveExpr(booleanArg, locals, scope) ?? false);
    const floorArg = singleArgCall(e, "Math.floor");
    if (floorArg !== undefined) return Math.floor(Number(this.resolveExpr(floorArg, locals, scope) ?? 0));
    const ceilArg = singleArgCall(e, "Math.ceil");
    if (ceilArg !== undefined) return Math.ceil(Number(this.resolveExpr(ceilArg, locals, scope) ?? 0));
    const roundArg = singleArgCall(e, "Math.round");
    if (roundArg !== undefined) return Math.round(Number(this.resolveExpr(roundArg, locals, scope) ?? 0));
    const absArg = singleArgCall(e, "Math.abs");
    if (absArg !== undefined) return Math.abs(Number(this.resolveExpr(absArg, locals, scope) ?? 0));
    if (e.startsWith("typeof ")) return avm1Typeof(this.resolveExpr(e.slice(7).trim(), locals, scope));
    const xpath = parseXPathCall(e);
    if (xpath) {
      const [context, path] = this.parseArgs(xpath.arguments, locals, scope);
      return xpath.name === "selectNodes" ? selectXmlNodes(context, String(path ?? "")) : selectXmlNodes(context, String(path ?? ""))[0];
    }
    const xpathMember = parseXPathMemberCall(e);
    if (xpathMember) {
      const [context, path] = this.parseArgs(xpathMember.arguments, locals, scope);
      let current: unknown = xpathMember.name === "selectNodes" ? selectXmlNodes(context, String(path ?? "")) : selectXmlNodes(context, String(path ?? ""))[0];
      for (const token of objectPathTokens(xpathMember.memberPath)) {
        if (current instanceof ClipInstance) current = this.resolveClipMember(current, token);
        else if (Array.isArray(current)) current = token === "length" ? current.length : current[Number(this.resolveExpr(token, locals, scope) ?? token)];
        else if (isXmlNode(current)) current = readXmlNodeProperty(current, token);
        else if (isAvm1Object(current)) current = current[token];
        else return undefined;
      }
      return isVarValue(current) ? current : undefined;
    }
    const delegate = parseDelegateCreate(e);
    if (delegate) {
      return {
        __avm1Delegate: true,
        target: this.resolveValueTarget(scope, delegate.target, locals),
        method: delegate.method.split(".").pop() ?? delegate.method,
      };
    }
    if (e === "new XML()") return { __avm1Type: "XML" };
    const tween = parseNewTween(e);
    if (tween) return this.createTweenObject(tween.arguments, locals, scope);
    const intervalArgs = singleArgCall(e, "setInterval");
    if (intervalArgs !== undefined) return this.createInterval(intervalArgs, locals, scope);
    const constructed = this.constructObject(e, locals, scope);
    if (constructed) return constructed;
    const upper = parseMethodCall(e, "toUpperCase");
    if (upper) {
      const target = upper.target ? this.resolveValueTarget(scope, upper.target, locals) : undefined;
      return target === undefined ? undefined : String(target).toUpperCase();
    }
    const split = parseMethodCall(e, "split");
    if (split) {
      const target = split.target ? this.resolveValueTarget(scope, split.target, locals) : undefined;
      const [separator] = this.parseArgs(split.arguments, locals, scope);
      return target === undefined ? undefined : String(target).split(String(separator ?? ""));
    }
    const substring = parseMethodCall(e, "substring");
    if (substring) {
      const target = substring.target ? this.resolveValueTarget(scope, substring.target, locals) : undefined;
      const [start, end] = this.parseArgs(substring.arguments, locals, scope);
      return target === undefined ? undefined : String(target).substring(Number(start ?? 0), end === undefined ? undefined : Number(end));
    }
    const substr = parseMethodCall(e, "substr");
    if (substr) {
      const target = substr.target ? this.resolveValueTarget(scope, substr.target, locals) : undefined;
      const [start, length] = this.parseArgs(substr.arguments, locals, scope);
      return target === undefined ? undefined : String(target).substr(Number(start ?? 0), length === undefined ? undefined : Number(length));
    }
    const charCodeAt = parseMethodCall(e, "charCodeAt");
    if (charCodeAt) {
      const target = charCodeAt.target ? this.resolveValueTarget(scope, charCodeAt.target, locals) : undefined;
      const [index] = this.parseArgs(charCodeAt.arguments, locals, scope);
      return target === undefined ? undefined : String(target).charCodeAt(Number(index ?? 0));
    }
    const indexOf = parseMethodCall(e, "indexOf");
    if (indexOf) {
      const target = indexOf.target ? this.resolveValueTarget(scope, indexOf.target, locals) : undefined;
      const [needle, start] = this.parseArgs(indexOf.arguments, locals, scope);
      return target === undefined ? undefined : String(target).indexOf(String(needle ?? ""), start === undefined ? undefined : Number(start));
    }
    const join = parseMethodCall(e, "join");
    if (join) {
      const target = join.target ? this.resolveValueTarget(scope, join.target, locals) : undefined;
      const [separator] = this.parseArgs(join.arguments, locals, scope);
      return Array.isArray(target) ? target.map((value) => value === null || value === undefined ? "" : String(value)).join(String(separator ?? ",")) : undefined;
    }
    const splice = parseMethodCall(e, "splice");
    if (splice) {
      const target = splice.target ? this.resolveValueTarget(scope, splice.target, locals) : undefined;
      const [start, deleteCount, ...items] = this.parseArgs(splice.arguments, locals, scope);
      return Array.isArray(target) ? target.splice(Number(start ?? 0), deleteCount === undefined ? target.length : Number(deleteCount), ...items) : undefined;
    }
    const pop = parseMethodCall(e, "pop");
    if (pop) {
      const target = pop.target ? this.resolveValueTarget(scope, pop.target, locals) : undefined;
      return Array.isArray(target) ? target.pop() : undefined;
    }
    const reverse = parseMethodCall(e, "reverse");
    if (reverse) {
      const target = reverse.target ? this.resolveValueTarget(scope, reverse.target, locals) : undefined;
      return Array.isArray(target) ? target.reverse() : undefined;
    }
    const concat = parseMethodCall(e, "concat");
    if (concat) {
      const target = concat.target ? this.resolveValueTarget(scope, concat.target, locals) : undefined;
      const values = this.parseArgs(concat.arguments, locals, scope);
      if (Array.isArray(target)) return target.concat(...values);
      return target === undefined ? undefined : String(target).concat(...values.map((value) => String(value ?? "")));
    }
    const toString = parseMethodCall(e, "toString");
    if (toString) {
      const target = toString.target ? this.resolveValueTarget(scope, toString.target, locals) : undefined;
      return target === undefined ? undefined : String(target);
    }
    const attach = parseMethodCall(e, "attachMovie");
    if (attach) {
      const target = attach.target ? this.resolveValueTarget(scope, attach.target, locals) : scope;
      return target instanceof ClipInstance ? this.attachMovie(target, attach.arguments, locals) : undefined;
    }
    const emptyClip = parseMethodCall(e, "createEmptyMovieClip");
    if (emptyClip) {
      const target = emptyClip.target ? this.resolveValueTarget(scope, emptyClip.target, locals) : scope;
      return target instanceof ClipInstance ? this.createEmptyMovieClip(target, emptyClip.arguments, locals) : undefined;
    }
    const depthTarget = singleArgCall(e, "getNextHighestDepth");
    if (depthTarget !== undefined) return this.nextHighestDepth(scope);
    if (/\.getNextHighestDepth\s*\(\s*\)$/.test(e)) {
      const owner = e.replace(/\.getNextHighestDepth\s*\(\s*\)$/, "");
      const target = this.resolveValueTarget(scope, owner, locals);
      return target instanceof ClipInstance ? this.nextHighestDepth(target) : undefined;
    }
    const parts = splitTopLevelOperator(e, "+");
    if (parts.length > 1) {
      const values = parts.map((part) => this.resolveExpr(part, locals, scope));
      if (values.some((value) => typeof value === "string")) return values.map((value) => value === undefined ? "" : String(value)).join("");
      const sum = values.reduce<number>((total, value) => total + Number(value ?? 0), 0);
      return Number.isFinite(sum) ? sum : undefined;
    }
    if (e.startsWith("-") && !/^-?\d+(\.\d+)?$/.test(e)) {
      const value = Number(this.resolveExpr(e.slice(1), locals, scope) ?? 0);
      return Number.isFinite(value) ? -value : undefined;
    }
    if (!e.startsWith("-")) {
      const minusParts = splitTopLevelOperator(e, "-");
      if (minusParts.length > 1) {
        const [first, ...rest] = minusParts.map((part) => Number(this.resolveExpr(part, locals, scope) ?? 0));
        const value = rest.reduce((total, item) => total - item, first);
        return Number.isFinite(value) ? value : undefined;
      }
    }
    for (const op of ["*", "/", "%"]) {
      const mathParts = splitTopLevelOperator(e, op);
      if (mathParts.length <= 1) continue;
      const numbers = mathParts.map((part) => Number(this.resolveExpr(part, locals, scope) ?? 0));
      const value = numbers.slice(1).reduce((total, item) => {
        if (op === "*") return total * item;
        if (op === "/") return item === 0 ? Number.NaN : total / item;
        return item === 0 ? Number.NaN : total % item;
      }, numbers[0]);
      return Number.isFinite(value) ? value : undefined;
    }
    const evalArg = singleArgCall(e, "eval");
    if (evalArg !== undefined) {
      const name = this.resolveExpr(evalArg, locals, scope);
      return name === undefined ? undefined : this.store?.get(String(name)) ?? this.textVars.get(normalizeVarName(String(name))) ?? undefined;
    }
    if ((e.startsWith('"') && e.endsWith('"')) || (e.startsWith("'") && e.endsWith("'"))) return e.slice(1, -1);
    if (e === "true") return true;
    if (e === "false") return false;
    if (e === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
    if (locals && e in locals) return locals[e];
    const scoped = this.resolveObjectPath(scope, e, locals);
    if (scoped !== undefined) return scoped;
    if (looksLikeObjectPath(e)) return undefined;
    // A bare identifier/path is a variable read (e.g. a flag), then a loadVariables()
    // text var (the music control's `_parent.t_musicOn`, which lives in textVars not the store).
    if (/^[A-Za-z_$][\w$.]*$/.test(e)) return this.store?.get(e) ?? this.textVars.get(normalizeVarName(e)) ?? undefined;
    return e; // array literals etc. — kept as their source text
  }

  /** Read a variable in a clip's scope: a clip-local timeline var first, else the shared store. */
  private scopeGet(clip: ClipInstance, name: string): VarValue | undefined {
    if (isLocalVar(name) && name in clip.locals) return clip.locals[name];
    if (name in clip.props) return clip.props[name];
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
  private branchPasses(condition: string | undefined, locals: Locals, scope: ClipInstance = this.root): boolean {
    if (!condition) return true;
    return this.evalRuntimeCondition(condition, locals, scope);
  }

  /**
   * Decide function-body guards against an entry snapshot plus safe prior assigns.
   * Assigns such as `doSndSet = 1` must be visible to a later `if(doSndSet) start()`,
   * but self-blocking guards such as `if(!blnDisableSkip){ blnDisableSkip = 1; ... }`
   * must not cause later statements from the same original block to skip themselves.
   */
  private functionBodyDecisions(body: BodyStatement[], locals: Locals, scope: ClipInstance = this.root): boolean[] {
    const guardLocals = this.functionGuardLocals(body, locals, scope);
    return body.map((statement) => this.branchPasses(statement.branchCondition, guardLocals, scope));
  }

  private runFunctionBody(body: BodyStatement[], locals: Locals, decisions: boolean[] | undefined = undefined, scope: ClipInstance = this.root) {
    decisions ??= this.functionBodyDecisions(body, locals, scope);
    body.forEach((statement, i) => {
      if (decisions[i]) this.runBodyStatement(statement, locals, scope);
    });
  }

  private functionGuardLocals(body: BodyStatement[], locals: Locals, scope: ClipInstance): Locals {
    const guardLocals: Locals = { ...locals };
    for (const statement of body) {
      if (statement.kind !== "assign") continue;
      if (conditionReferencesTarget(statement.branchCondition, statement.target)) continue;
      if (!this.branchPasses(statement.branchCondition, guardLocals, scope)) continue;
      const value = this.resolveGuardExpr(statement.rawValue, guardLocals);
      if (value !== undefined) guardLocals[statement.target] = value;
    }
    return guardLocals;
  }

  private resolveGuardExpr(raw: string | undefined, locals: Locals): VarValue | undefined {
    const e = raw?.trim() ?? "";
    if (!e) return undefined;
    if ((e.startsWith('"') && e.endsWith('"')) || (e.startsWith("'") && e.endsWith("'"))) return e.slice(1, -1);
    if (e === "true") return true;
    if (e === "false") return false;
    if (e === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
    if (e in locals) return locals[e];
    if (/^[A-Za-z_$][\w$.]*$/.test(e)) return this.store?.get(e) ?? undefined;
    return undefined;
  }

  private runBodyStatement(statement: BodyStatement, locals: Locals, scope: ClipInstance) {
    if (statement.kind === "assign") {
      const value = this.resolveExpr(statement.rawValue, locals, scope);
      this.trackSoundObject(statement.target, statement.rawValue);
      if (isLocalVar(statement.target) && value !== undefined) locals[statement.target] = value;
      if (value !== undefined && this.applyPropertyAssignment(scope, statement.target, value, locals)) return;
      if (value !== undefined && this.assignObjectPath(scope, statement.target, value, locals)) return;
      if (this.store && value !== undefined) this.store.set(statement.target, value);
      return;
    }
    this.runBodyCall(statement, locals, scope);
  }

  /** Dispatch a body call: a waiter, a clip command, or a (possibly cross-level) function call. */
  private runBodyCall(call: Extract<BodyStatement, { kind: "call" }>, locals: Locals, scope: ClipInstance) {
    const fn = call.functionName;
    const target = call.target;
    if (fn === "while") {
      this.runWhileBody(call.arguments, locals, scope);
      return;
    }
    if (fn === "Tween" && target === "mx.transitions") {
      this.createTweenObject(call.arguments, locals, scope);
      return;
    }
    if (fn === "addEventListener" && target) {
      const owner = this.resolveValueTarget(scope, target, locals);
      const [eventName, listener] = this.parseArgs(call.arguments, locals, scope);
      if (owner instanceof ClipInstance && typeof eventName === "string" && isDelegate(listener)) {
        this.addEventListener(owner, eventName, listener);
      }
      return;
    }
    if (fn === "removeEventListener" && target) {
      const owner = this.resolveValueTarget(scope, target, locals);
      const [eventName, listener] = this.parseArgs(call.arguments, locals, scope);
      if (owner instanceof ClipInstance && typeof eventName === "string" && isDelegate(listener)) {
        this.removeEventListener(owner, eventName, listener);
      }
      return;
    }
    if (fn === "addListener" && target) {
      const owner = this.resolveValueTarget(scope, target, locals);
      const [listener] = this.parseArgs(call.arguments, locals, scope);
      if (isMovieClipLoader(owner) && isAvm1Object(listener)) {
        const listeners = movieClipLoaderListeners(owner);
        if (!listeners.includes(listener)) listeners.push(listener);
      }
      return;
    }
    if (fn === "loadClip" && target) {
      const owner = this.resolveValueTarget(scope, target, locals);
      const [url, clip] = this.parseArgs(call.arguments, locals, scope);
      if (isMovieClipLoader(owner) && clip instanceof ClipInstance) {
        this.loadClipInto(owner, String(url ?? ""), clip);
      }
      return;
    }
    if (fn === "getURL") {
      const [url, targetWindow] = this.parseArgs(call.arguments, locals, scope);
      if (url !== undefined) this.options.onGetURL?.(String(url), targetWindow === undefined ? undefined : String(targetWindow));
      return;
    }
    if (fn === "dispatchEvent") {
      const owner = target ? this.resolveValueTarget(scope, target, locals) : scope;
      const [event] = this.parseArgs(call.arguments, locals, scope);
      if (owner instanceof ClipInstance && isAvm1Object(event)) {
        this.dispatchEvent(owner, event);
      }
      return;
    }
    if (fn === "setTextFormat" && target) {
      const textTarget = this.resolveTextTarget(scope, target, locals);
      const [format] = this.parseArgs(call.arguments, locals, scope);
      if (textTarget && isAvm1Object(format)) {
        Object.assign(this.textOverrideFor(textTarget), dynamicTextFromTextFormat(format));
      }
      return;
    }
    if (fn === "getNextHighestDepth") return;
    if (fn === "attachMovie") {
      const owner = target ? this.resolveValueTarget(scope, target, locals) : scope;
      if (owner instanceof ClipInstance) {
        this.attachMovie(owner, call.arguments, locals);
      }
      return;
    }
    if (fn === "createEmptyMovieClip") {
      const owner = target ? this.resolveValueTarget(scope, target, locals) : scope;
      if (owner instanceof ClipInstance) {
        this.createEmptyMovieClip(owner, call.arguments, locals);
      }
      return;
    }
    if (fn === "swapDepths" && target) {
      const owner = this.resolveValueTarget(scope, target, locals);
      const [depth] = this.parseArgs(call.arguments, locals, scope);
      if (owner instanceof ClipInstance) this.swapDepths(owner, depth);
      return;
    }
    if (fn === "setMask" && target) {
      const owner = this.resolveValueTarget(scope, target, locals);
      const [mask] = this.parseArgs(call.arguments, locals, scope);
      if (owner instanceof ClipInstance) owner.maskClip = mask instanceof ClipInstance ? mask : undefined;
      return;
    }
    if (fn === "startDrag") {
      const owner = target ? this.resolveValueTarget(scope, target, locals) : scope;
      if (owner instanceof ClipInstance) this.startDrag(owner, call.arguments, locals, scope);
      return;
    }
    if (fn === "stopDrag") {
      const owner = target ? this.resolveValueTarget(scope, target, locals) : this.activeDrag?.clip;
      if (!owner || owner === this.activeDrag?.clip) this.activeDrag = undefined;
      return;
    }
    if (fn === "push") {
      const owner = target ? this.resolveValueTarget(scope, target, locals) : undefined;
      if (Array.isArray(owner)) owner.push(...this.parseArgs(call.arguments, locals, scope));
      return;
    }
    if (fn === "reverse") {
      const owner = target ? this.resolveValueTarget(scope, target, locals) : undefined;
      if (Array.isArray(owner)) owner.reverse();
      return;
    }
    if (fn === "pop") {
      const owner = target ? this.resolveValueTarget(scope, target, locals) : undefined;
      if (Array.isArray(owner)) owner.pop();
      return;
    }
    if (fn === "shift") {
      const owner = target ? this.resolveValueTarget(scope, target, locals) : undefined;
      if (Array.isArray(owner)) owner.shift();
      return;
    }
    if (fn === "unshift") {
      const owner = target ? this.resolveValueTarget(scope, target, locals) : undefined;
      if (Array.isArray(owner)) owner.unshift(...this.parseArgs(call.arguments, locals, scope));
      return;
    }
    if (fn === "splice") {
      const owner = target ? this.resolveValueTarget(scope, target, locals) : undefined;
      const [start, deleteCount, ...items] = this.parseArgs(call.arguments, locals, scope);
      if (Array.isArray(owner)) owner.splice(Number(start ?? 0), deleteCount === undefined ? owner.length : Number(deleteCount), ...items);
      return;
    }
    if (fn === "setInterval") {
      this.createInterval(call.arguments, locals, scope);
      return;
    }
    if (fn === "clearInterval") {
      const [id] = this.parseArgs(call.arguments, locals, scope);
      this.clearRuntimeTimer(id);
      return;
    }
    if (fn === "setTimeout") {
      this.createTimeout(call.arguments, locals, scope);
      return;
    }
    if (fn === "removeMovieClip" && target) {
      const owner = this.resolveValueTarget(scope, target, locals);
      if (owner instanceof ClipInstance) this.removeMovieClip(owner);
      return;
    }
    if (fn === "unloadMovie" && target) {
      const owner = this.resolveValueTarget(scope, target, locals);
      if (owner instanceof ClipInstance) this.unloadMovieClip(owner);
      return;
    }
    if (fn === "load" && target) {
      const owner = this.resolveValueTarget(scope, target, locals);
      const [url] = this.parseArgs(call.arguments, locals, scope);
      if (isAvm1Object(owner)) this.loadXmlObject(owner, String(url ?? ""));
      return;
    }
    if (this.runMovieLoadCall(fn, call.arguments, locals, scope)) return;
    if (this.runMovieUnloadCall(fn, call.arguments, locals, scope)) return;
    if (this.runSoundMethod(target, fn, call.arguments, locals)) return;
    if (WAITER_FUNCTIONS.has(fn)) {
      this.options.onWaiter?.(fn, this.parseArgs(call.arguments, locals, scope));
      return;
    }
    if (SOUND_MARKER_FUNCTIONS.has(fn)) {
      const segment = this.parseArgs(call.arguments, locals, scope)[0];
      if (segment !== undefined) this.runSoundMarker(target, String(segment), call.arguments);
      return;
    }
    if (TIMELINE_COMMANDS.has(fn) && target) {
      const frame = this.parseArgs(call.arguments, locals, scope)[0] ?? 0;
      if (/^_level\d+/i.test(target)) this.options.onClipCommand?.(target, fn, frame);
      else this.runNamedClipCommand(scope, target, fn, frame);
      return;
    }
    if (target && !/^_level\d+/i.test(target)) {
      const objectTarget = this.resolveValueTarget(scope, target, locals);
      if (objectTarget instanceof ClipInstance && objectTarget !== scope) {
        const method = this.methodFunctionForClip(objectTarget, fn);
        if (method) {
          this.callFunctionDef(method.key, method.def, call.arguments, locals, objectTarget, scope);
          return;
        }
      }
    }
    if (!target || target === "self" || target === "this" || target === "_root" || target === "_level0") {
      const method = target === "self" || target === "this" ? this.methodFunctionForClip(scope, fn) : undefined;
      if (method) this.callFunctionDef(method.key, method.def, call.arguments, locals, scope);
      else this.callFunction(fn, call.arguments, locals);
    } else if (/^_level\d+/i.test(target)) {
      this.options.onCallFunction?.(target, fn, this.resolveArgsString(call.arguments, locals));
    } else {
      const clip = this.resolveTarget(scope, target) ?? this.findClipByName(scope, target);
      if (clip === this.root) this.callFunction(fn, call.arguments, locals);
      else if (clip) {
        const method = this.methodFunctionForClip(clip, fn);
        if (method) this.callFunctionDef(method.key, method.def, call.arguments, locals, clip, scope);
        else this.callClipFunction(clip, fn);
      }
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

  private runMovieLoadCall(fn: string, argsRaw: string | undefined, locals?: Locals, scope: ClipInstance = this.root): boolean {
    if (fn !== "loadMovieNum" && fn !== "loadMovie") return false;
    const args = this.parseArgs(argsRaw, locals, scope);
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

  private runMovieUnloadCall(fn: string, argsRaw: string | undefined, locals?: Locals, scope: ClipInstance = this.root): boolean {
    if (fn !== "unloadMovieNum" && fn !== "unloadMovie") return false;
    const args = this.parseArgs(argsRaw, locals, scope);
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
      this.options.onSound?.({ command: "setVolume", target, value: primitiveValue(typeof value === "boolean" ? Number(value) : value), executionContext: "function" });
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

  private runFunctionAction(action: ControlAction, locals?: Locals, scope: ClipInstance = this.root) {
    switch (action.command) {
      case "stop":
        if (isSelfTimelineTarget(action.target)) scope.playing = false;
        break;
      case "play":
        if (isSelfTimelineTarget(action.target)) scope.playing = true;
        break;
      case "gotoAndPlay":
      case "gotoAndStop": {
        const target = this.resolveTarget(scope, action.target);
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
      case "fsCommand":
        this.options.onFsCommand?.(String(action.value ?? ""), action.arguments ?? "");
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
          if (this.applyPropertyAssignment(scope, action.target, value, locals)) break;
          this.scopeSet(scope, action.target, value);
          const norm = normalizeVarName(action.target);
          if (this.boundTextVars.has(norm)) this.textVars.set(norm, String(value));
        }
        break;
      }
      case "callFunctions":
        this.runCallFunctions(action, scope, locals);
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
      if (target !== "_root" && this.runAppClipMethod(clip, fn, this.parseArgs(call.arguments, locals))) return true;
      if (target !== "_root" && this.spriteFunctions.get(clip.characterId)?.has(fn)) return this.callClipFunction(clip, fn);
      const method = target !== "_root" ? this.methodFunctionForClip(clip, fn) : undefined;
      return method ? this.callFunctionDef(method.key, method.def, call.arguments, locals, clip) : this.callFunction(fn, call.arguments);
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
    if (targetClip) {
      if (this.runAppClipMethod(targetClip, fn, this.parseArgs(call.arguments, locals))) return true;
      const method = this.methodFunctionForClip(targetClip, fn);
      if (method) return this.callFunctionDef(method.key, method.def, call.arguments, locals, targetClip, clip);
      return this.callClipFunction(targetClip, fn);
    }
    if (this.functions.has(fn) && shouldFallbackToGlobalFunction(target, fn)) return this.callFunction(fn, call.arguments, locals);
    return false;
  }

  private runAppClipMethod(clip: ClipInstance, name: string, args: Array<VarValue | undefined>): boolean {
    const dispatcher = clip.props.__appMethodDispatcher;
    if (typeof dispatcher !== "function") return false;
    return Boolean(dispatcher(name, args));
  }

  private methodFunctionForClip(clip: ClipInstance, functionName: string): { key: string; def: FunctionDef } | undefined {
    const sourceKey = clip.scriptKey ?? this.clipSourceKey(this.getAsset(clip.characterId), clip.name);
    if (!sourceKey) return undefined;
    const key = methodFunctionKey(sourceKey, functionName);
    const def = this.methodFunctions.get(key);
    return def ? { key, def } : undefined;
  }

  private constructorFunctionForClip(clip: ClipInstance): { key: string; def: FunctionDef } | undefined {
    const sourceKey = clip.scriptKey ?? this.clipSourceKey(this.getAsset(clip.characterId), clip.name);
    if (!sourceKey) return undefined;
    for (const [key, def] of this.methodFunctions) {
      if (!key.startsWith(`${sourceKey}:`)) continue;
      const functionName = key.slice(sourceKey.length + 1);
      if (normalizeMethodKey(functionName) === sourceKey) return { key, def };
    }
    return undefined;
  }

  private runClipConstructor(clip: ClipInstance) {
    if (clip.constructorRun) return;
    const constructor = this.constructorFunctionForClip(clip);
    if (!constructor) return;
    clip.constructorRun = true;
    this.callFunctionDef(constructor.key, constructor.def, undefined, undefined, clip);
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
        if (action.target && value !== undefined && !this.applyPropertyAssignment(clip, action.target, value)) this.scopeSet(clip, action.target, value);
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
    this.root = root;
    this.enterFrame(root, frame, 0);
    return root;
  }

  // --- per-frame advance ------------------------------------------------

  private onTick() {
    this.tickClip(this.root);
    // Drive a data-driven app's timers/tweens/onEnterFrame on the frame clock so
    // its animations stay in lockstep with the SWF frame rate (and Ruffle).
    this.dataApp?.enterFrame(1000 / this.ticker.fps);
    this.render();
    this.options.onFrame?.(this.root.currentFrame, this.ticker.isPlaying);
  }

  private tickClip(clip: ClipInstance) {
    this.tickLoadedTimeline(clip);
    const frameCount = this.frameCountFor(clip);
    if (clip.playing && frameCount > 1) {
      const next = clip.currentFrame + 1 >= frameCount ? 0 : clip.currentFrame + 1;
      this.enterFrame(clip, next, 0);
    } else if (clip.enteredFrame < 0) {
      this.enterFrame(clip, clip.currentFrame, 0);
    }
    this.runAssignedEnterFrame(clip);
    for (const child of clip.childClips.values()) this.tickClip(child);
  }

  private tickLoadedTimeline(clip: ClipInstance) {
    const timeline = clip.loadedTimeline;
    if (!timeline || !clip.loadedPlaying) return;
    const frameCount = Math.max(1, timeline.frameCount ?? timeline.frames?.length ?? timeline.frameSvgs?.length ?? 1);
    if (frameCount <= 1) return;
    clip.loadedFrame = clip.loadedFrame + 1 >= frameCount ? 0 : clip.loadedFrame + 1;
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
    const instances = this.instancesForFrame(clip, frames[clip.currentFrame]);

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
        child.scriptKey = this.clipSourceKey(asset, instanceName);
        child.placedX = instance.matrix.tx;
        child.placedY = instance.matrix.ty;
        clip.childClips.set(instance.depth, child);
        this.enterFrame(child, 0, 0);
        this.runClipConstructor(child);
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
        existing.scriptKey = existing.scriptKey ?? this.clipSourceKey(asset, instanceName);
      }
      const child = clip.childClips.get(instance.depth);
      if (child) {
        child.placedX = instance.matrix.tx;
        child.placedY = instance.matrix.ty;
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
            if (this.applyPropertyAssignment(clip, action.target, value)) break;
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
      if (i === 0 && (name === "this" || name === "self")) {
        continue;
      }
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

  private applyPropertyAssignment(scope: ClipInstance, target: string | undefined, value: VarValue, locals?: Locals): boolean {
    const parsed = splitPropertyTarget(target);
    if (!parsed) return false;
    if (parsed.property === "text" || parsed.property === "htmlText") {
      const textTarget = this.resolveTextTarget(scope, parsed.owner, locals);
      if (!textTarget) return false;
      const override = this.textOverrideFor(textTarget);
      override.text = String(value);
      override.html = parsed.property === "htmlText";
      if (textTarget.owner && textTarget.name) textTarget.owner.mutatedLeaves.add(textTarget.name);
      return true;
    }
    const owner = this.resolveValueTarget(scope, parsed.owner, locals);
    if (owner instanceof ClipInstance) return setClipProperty(owner, parsed.property, value);
    const leaf = this.resolveLeafTarget(scope, parsed.owner, locals);
    if (leaf) {
      this.setLeafDisplayProp(leaf.owner, leaf.name, parsed.property, value);
      return true;
    }
    return false;
  }

  private resolveTextTarget(scope: ClipInstance, target: string, locals?: Locals): { id: number; owner?: ClipInstance; name?: string } | undefined {
    const parts = target.split(".").filter(Boolean);
    let node: ClipInstance | null = scope;
    for (let i = 0; i < parts.length; i += 1) {
      const name = parts[i];
      if (i === 0 && (name === "this" || name === "self")) continue;
      if (i === 0 && locals && name in locals) {
        const local = locals[name];
        node = local instanceof ClipInstance ? local : null;
        continue;
      }
      if (i === 0 && (name === "_root" || name === "_level0" || name === "root")) {
        node = this.root;
        continue;
      }
      if (name === "_parent") {
        node = node?.parent ?? node;
        continue;
      }
      if (!node) return undefined;
      const isLast = i === parts.length - 1;
      if (isLast) {
        const textId = this.findTextChildByName(node, name);
        if (textId !== undefined) return { id: textId, owner: node, name };
      }
      node = findChildByName(node, name) ?? this.findClipByName(node, name);
    }
    return undefined;
  }

  private textOverrideFor(target: { id: number; owner?: ClipInstance; name?: string }): TextOverride {
    if (target.owner && target.name) {
      let scoped = this.clipTextOverrides.get(target.owner);
      if (!scoped) {
        scoped = new Map();
        this.clipTextOverrides.set(target.owner, scoped);
      }
      let override = scoped.get(target.name);
      if (!override) {
        override = {};
        scoped.set(target.name, override);
      }
      return override;
    }
    let override = this.textOverrides.get(target.id);
    if (!override) {
      override = {};
      this.textOverrides.set(target.id, override);
    }
    return override;
  }

  private findTextChildByName(clip: ClipInstance, name: string): number | undefined {
    const frame = this.framesFor(clip)?.[clip.currentFrame];
    for (const instance of frame?.instances ?? []) {
      if (instance.name !== name) continue;
      const asset = this.getAsset(instance.characterId);
      if (asset?.kind === "text") return asset.id;
    }
    return undefined;
  }

  private resolveLeafTarget(scope: ClipInstance, target: string, locals?: Locals): { owner: ClipInstance; name: string; props: Record<string, VarValue | undefined> } | undefined {
    const parts = target.split(".").filter(Boolean);
    if (!parts.length) return undefined;
    const leafName = parts[parts.length - 1];
    const ownerPath = parts.slice(0, -1).join(".") || "this";
    const owner = this.resolveValueTarget(scope, ownerPath, locals);
    if (!(owner instanceof ClipInstance)) return undefined;
    if (!this.findLeafChild(owner, leafName)) return undefined;
    return { owner, name: leafName, props: this.leafDisplayProps(owner, leafName) };
  }

  private attachMovie(owner: ClipInstance, argsRaw: string | undefined, locals?: Locals): ClipInstance | undefined {
    const [linkageValue, nameValue, depthValue] = this.parseArgs(argsRaw, locals, owner);
    const linkage = String(linkageValue ?? "").trim();
    const characterId = this.linkageAssetIds.get(normalizeLinkageName(linkage));
    if (!characterId || !this.getAsset(characterId)) return undefined;
    const depth = Number(depthValue ?? this.nextHighestDepth(owner));
    if (!Number.isFinite(depth)) return undefined;
    const name = String(nameValue ?? `instance${depth}`);
    const instance = {
      depth,
      characterId,
      placedFrame: owner.currentFrame,
      matrix: { ...IDENTITY },
      opacity: 1,
      name,
    };
    owner.dynamicInstances.set(depth, instance);
    this.hasAnyDynamicInstances = true;
    owner.displayListMutated = true;
    owner.depthNames.set(depth, name);
    const child = new ClipInstance(characterId, name, owner);
    child.scriptKey = this.clipSourceKey(this.getAsset(characterId), name);
    child.placedX = instance.matrix.tx;
    child.placedY = instance.matrix.ty;
    owner.childClips.set(depth, child);
    this.enterFrame(child, 0, 0);
    this.runClipConstructor(child);
    return child;
  }

  private createEmptyMovieClip(owner: ClipInstance, argsRaw: string | undefined, locals?: Locals): ClipInstance | undefined {
    const [nameValue, depthValue] = this.parseArgs(argsRaw, locals, owner);
    const depth = Number(depthValue ?? this.nextHighestDepth(owner));
    if (!Number.isFinite(depth)) return undefined;
    const name = String(nameValue ?? `instance${depth}`);
    owner.dynamicInstances.set(depth, {
      depth,
      characterId: 0,
      placedFrame: owner.currentFrame,
      matrix: { ...IDENTITY },
      opacity: 1,
      name,
    });
    this.hasAnyDynamicInstances = true;
    owner.displayListMutated = true;
    owner.depthNames.set(depth, name);
    const child = new ClipInstance(0, name, owner);
    child.placedX = 0;
    child.placedY = 0;
    owner.childClips.set(depth, child);
    return child;
  }

  private clipSourceKey(asset: TimelineAsset | undefined, name: string): string | undefined {
    for (const linkageName of asset?.linkageNames ?? []) {
      const registered = this.linkageClassKeys.get(normalizeLinkageName(linkageName));
      if (registered) return registered;
    }
    return clipSourceKey(asset, name);
  }

  private constructObject(raw: string, locals: Locals | undefined, scope: ClipInstance): VarValue | undefined {
    const match = raw.match(/^new\s+([\w$.]+)\s*\((.*)\)$/s);
    if (!match) return undefined;
    const classPath = match[1];
    const constructorName = classPath.split(".").pop() ?? classPath;
    const scriptKey = normalizeMethodKey(constructorName);
    if (!scriptKey) return undefined;
    const def = this.methodFunctions.get(methodFunctionKey(scriptKey, constructorName)) ?? this.functions.get(constructorName);
    if (!def) return { __avm1Class: classPath };
    const instance = new ClipInstance(ROOT_ID, constructorName, null);
    instance.scriptKey = scriptKey;
    this.callFunctionDef(methodFunctionKey(scriptKey, constructorName), def, match[2], locals, instance, scope);
    return instance;
  }

  private loadXmlObject(xml: Record<string, VarValue | undefined>, url: string) {
    if (!url || typeof fetch === "undefined" || typeof DOMParser === "undefined") return;
    const src = url.startsWith("/") ? url : `/${url}`;
    fetch(src)
      .then((response) => response.ok ? response.text() : "")
      .then((text) => {
        if (!text) return;
        const doc = new DOMParser().parseFromString(text, "application/xml");
        xml.document = doc;
        xml.documentElement = doc.documentElement;
        const onLoad = xml.onLoad;
        if (isDelegate(onLoad) && onLoad.target instanceof ClipInstance) {
          if (!isCurrentOwnedObject(xml, onLoad.target)) return;
          const method = this.methodFunctionForClip(onLoad.target, onLoad.method);
          if (method) this.callFunctionDef(method.key, method.def, "true", undefined, onLoad.target);
        }
        this.render();
      })
      .catch(() => {});
  }

  private loadClipInto(loader: Record<string, VarValue | undefined>, url: string, clip: ClipInstance) {
    const src = normalizeRuntimeAssetUrl(url);
    if (!src) return;
    this.dispatchMovieClipLoader(loader, "onLoadStart", clip);
    if (isSwfUrl(src) && this.options.loadTimeline) {
      this.options.loadTimeline(src)
        .then((timeline) => {
          if (!timeline) {
            this.fetchLoadedClip(loader, src, clip);
            return;
          }
          clip.loadedTimeline = timeline;
          clip.loadedFrame = clamp(timeline.entryFrame ?? 0, 0, Math.max(0, (timeline.frameCount ?? 1) - 1));
          clip.loadedPlaying = true;
          clip.props.__loadedSrc = src;
          clip.props.__loadedWidth = timeline.dimensions.width;
          clip.props.__loadedHeight = timeline.dimensions.height;
          this.dispatchMovieClipLoader(loader, "onLoadComplete", clip);
          this.dispatchMovieClipLoader(loader, "onLoadInit", clip);
          this.render();
        })
        .catch(() => this.fetchLoadedClip(loader, src, clip));
      return;
    }
    this.fetchLoadedClip(loader, src, clip);
  }

  private fetchLoadedClip(loader: Record<string, VarValue | undefined>, src: string, clip: ClipInstance) {
    if (isImageUrl(src) && typeof Image !== "undefined") {
      const image = new Image();
      image.onload = () => {
        clip.props.__loadedSrc = src;
        clip.props.__loadedWidth = image.naturalWidth || image.width || 0;
        clip.props.__loadedHeight = image.naturalHeight || image.height || 0;
        this.dispatchMovieClipLoader(loader, "onLoadComplete", clip);
        this.dispatchMovieClipLoader(loader, "onLoadInit", clip);
        this.render();
      };
      image.onerror = () => {
        this.dispatchMovieClipLoader(loader, "onLoadError", clip);
      };
      image.src = assetUrl(src);
      return;
    }
    if (typeof fetch === "undefined") {
      this.dispatchMovieClipLoader(loader, "onLoadError", clip);
      return;
    }
    fetch(assetUrl(src), { method: "GET" })
      .then((response) => {
        if (!response.ok) {
          this.dispatchMovieClipLoader(loader, "onLoadError", clip);
          return;
        }
        clip.props.__loadedSrc = src;
        clip.props.__loadedWidth = 0;
        clip.props.__loadedHeight = 0;
        this.dispatchMovieClipLoader(loader, "onLoadComplete", clip);
        this.dispatchMovieClipLoader(loader, "onLoadInit", clip);
        this.render();
      })
      .catch(() => {
      this.dispatchMovieClipLoader(loader, "onLoadError", clip);
    });
  }

  private dispatchMovieClipLoader(loader: Record<string, VarValue | undefined>, eventName: string, clip: ClipInstance) {
    for (const listener of movieClipLoaderListeners(loader)) {
      const handler = listener[eventName];
      if (isDelegate(handler) && handler.target instanceof ClipInstance) {
        const method = this.methodFunctionForClip(handler.target, handler.method);
        if (method) this.callFunctionDef(method.key, method.def, "__loadedClip", { __loadedClip: clip }, handler.target);
      }
    }
  }

  private createTweenObject(argsRaw: string | undefined, locals: Locals | undefined, scope: ClipInstance): Record<string, VarValue | undefined> {
    const [target, propertyValue, , begin, finish, durationValue, useSecondsValue] = this.parseArgs(argsRaw, locals, scope);
    const property = typeof propertyValue === "string" ? normalizeAvm1PropertyName(propertyValue) : "";
    const tween: Record<string, VarValue | undefined> = {
      __avm1Type: "Tween",
      target: target as VarValue,
      property,
      begin: begin as VarValue,
      finish: finish as VarValue,
      duration: durationValue as VarValue,
    };
    const ms = tweenDurationMs(durationValue, useSecondsValue, this.timeline.fps || 30);
    const finishTween = () => {
      if (target instanceof ClipInstance && property) setClipProperty(target, property, finish as VarValue);
      // onMotionFinished is assigned right after construction, so read it lazily at the end.
      const callback = tween.onMotionFinished;
      if (isDelegate(callback) && callback.target instanceof ClipInstance) {
        const method = this.methodFunctionForClip(callback.target, callback.method);
        if (method) this.callFunctionDef(method.key, method.def, "__tween", { __tween: tween as VarValue }, callback.target);
      }
      this.render();
    };

    const beginNumber = Number(begin);
    const finishNumber = Number(finish);
    // Non-numeric target/prop or instant duration → jump to the end value (legacy behaviour).
    if (!(target instanceof ClipInstance) || !property || !Number.isFinite(beginNumber) || !Number.isFinite(finishNumber) || ms <= 16) {
      const timer = setTimeout(() => { this.runtimeTimers.delete(timer); finishTween(); }, ms);
      this.runtimeTimers.add(timer);
      return tween;
    }

    // Smooth linear interpolation begin→finish (the mx.transitions easing curve is ignored,
    // matching the avm1App VM). Without this, tweened motion teleports to its end state —
    // e.g. bnl's news ticker items jump from off-right to off-left, never scrolling across.
    setClipProperty(target, property, beginNumber);
    const start = Date.now();
    const handle = setInterval(() => {
      const progress = Math.min(1, (Date.now() - start) / ms);
      setClipProperty(target, property, beginNumber + (finishNumber - beginNumber) * progress);
      if (progress >= 1) {
        this.runtimeTimers.delete(handle);
        clearInterval(handle);
        finishTween();
      } else {
        this.render();
      }
    }, 33);
    this.runtimeTimers.add(handle);
    return tween;
  }

  private createInterval(argsRaw: string | undefined, locals: Locals | undefined, scope: ClipInstance): VarValue | undefined {
    const [target, methodValue, delayValue] = this.parseArgs(argsRaw, locals, scope);
    if (!(target instanceof ClipInstance)) return undefined;
    const method = typeof methodValue === "string" ? methodValue : "";
    if (!method) return undefined;
    const delay = Number(delayValue);
    const ms = Number.isFinite(delay) && delay > 0 ? delay : 1;
    const timer = setInterval(() => {
      const def = this.methodFunctionForClip(target, method);
      if (def) this.callFunctionDef(def.key, def.def, undefined, undefined, target);
    }, ms);
    this.runtimeTimers.add(timer);
    return Number(timer);
  }

  private createTimeout(argsRaw: string | undefined, locals: Locals | undefined, scope: ClipInstance): VarValue | undefined {
    const [target, methodValue, delayValue] = this.parseArgs(argsRaw, locals, scope);
    if (!(target instanceof ClipInstance)) return undefined;
    const method = typeof methodValue === "string" ? methodValue : "";
    if (!method) return undefined;
    const delay = Number(delayValue);
    const ms = Number.isFinite(delay) && delay >= 0 ? delay : 1;
    const timer = setTimeout(() => {
      this.runtimeTimers.delete(timer);
      const def = this.methodFunctionForClip(target, method);
      if (def) this.callFunctionDef(def.key, def.def, undefined, undefined, target);
    }, ms);
    this.runtimeTimers.add(timer);
    return Number(timer);
  }

  private clearRuntimeTimer(value: VarValue | undefined) {
    const id = Number(value);
    if (!Number.isFinite(id)) return;
    for (const timer of this.runtimeTimers) {
      if (Number(timer) !== id) continue;
      clearTimeout(timer);
      clearInterval(timer);
      this.runtimeTimers.delete(timer);
      return;
    }
  }

  private clearRuntimeTimers() {
    for (const timer of this.runtimeTimers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.runtimeTimers.clear();
  }

  private removeMovieClip(clip: ClipInstance) {
    const parent = clip.parent;
    if (!parent) return;
    for (const [depth, child] of parent.childClips) {
      if (child !== clip) continue;
      parent.childClips.delete(depth);
      parent.dynamicInstances.delete(depth);
      parent.depthNames.delete(depth);
      parent.displayListMutated = true;
      return;
    }
    clip.visible = false;
  }

  private swapDepths(clip: ClipInstance, depthOrClip: VarValue | undefined) {
    const parent = clip.parent;
    if (!parent) return;
    const currentDepth = this.depthOfChild(parent, clip);
    if (currentDepth === undefined) return;
    if (depthOrClip instanceof ClipInstance) {
      const otherDepth = this.depthOfChild(parent, depthOrClip);
      if (otherDepth === undefined) return;
      clip.depthOverride = effectiveDepthForChild(parent, otherDepth);
      depthOrClip.depthOverride = effectiveDepthForChild(parent, currentDepth);
      return;
    }
    const targetDepth = Number(depthOrClip);
    if (!Number.isFinite(targetDepth)) return;
    const dynamic = parent.dynamicInstances.get(currentDepth);
    if (dynamic && parent.childClips.get(currentDepth) === clip) {
      parent.dynamicInstances.delete(currentDepth);
      parent.childClips.delete(currentDepth);
      dynamic.depth = targetDepth;
      parent.dynamicInstances.set(targetDepth, dynamic);
      parent.childClips.set(targetDepth, clip);
      parent.displayListMutated = true;
      clip.depthOverride = undefined;
      return;
    }
    clip.depthOverride = targetDepth;
  }

  private startDrag(clip: ClipInstance, argsRaw: string | undefined, locals: Locals | undefined, scope: ClipInstance) {
    const [, left, top, right, bottom] = this.parseArgs(argsRaw, locals, scope);
    const bounds = [left, top, right, bottom].map((value) => Number(value));
    clip.x = clip.x ?? clip.placedX;
    clip.y = clip.y ?? clip.placedY;
    this.activeDrag = {
      clip,
      left: Number.isFinite(bounds[0]) ? bounds[0] : undefined,
      top: Number.isFinite(bounds[1]) ? bounds[1] : undefined,
      right: Number.isFinite(bounds[2]) ? bounds[2] : undefined,
      bottom: Number.isFinite(bounds[3]) ? bounds[3] : undefined,
    };
  }

  private depthOfChild(parent: ClipInstance, child: ClipInstance): number | undefined {
    for (const [depth, candidate] of parent.childClips) {
      if (candidate === child) return depth;
    }
    return undefined;
  }

  private unloadMovieClip(clip: ClipInstance) {
    clip.childClips.clear();
    clip.dynamicInstances.clear();
    clip.depthNames.clear();
    clip.displayListMutated = true;
    clip.loadedTimeline = undefined;
    clip.loadedFrame = 0;
    clip.loadedPlaying = false;
    clip.visible = false;
  }

  private nextHighestDepth(owner: ClipInstance): number {
    let max = -1;
    const frames = this.framesFor(owner);
    for (const instance of frames?.[owner.currentFrame]?.instances ?? []) max = Math.max(max, instance.depth);
    for (const depth of owner.dynamicInstances.keys()) max = Math.max(max, depth);
    return max + 1;
  }

  private resolveValueTarget(scope: ClipInstance, target: string, locals?: Locals): unknown {
    const text = target.trim();
    if (!text || text === "this" || text === "self") return scope;
    if (locals && text in locals) return locals[text];
    const clip = this.resolveTarget(scope, text);
    if (clip) return clip;
    return this.resolveObjectPath(scope, text, locals);
  }

  private resolveObjectPath(scope: ClipInstance, path: string, locals?: Locals): VarValue | undefined {
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*$/.test(path)) return undefined;
    const tokens = objectPathTokens(path);
    if (!tokens.length) return undefined;
    let current: unknown;
    const [first] = tokens;
    if (first === "this" || first === "self") current = scope;
    else if (first === "_root" || first === "_level0" || first === "root") current = this.root;
    else if (locals && first in locals) current = locals[first];
    else if (first in scope.props) current = scope.props[first];
    else current = this.store?.get(first);
    for (const token of tokens.slice(1)) {
      if (current instanceof ClipInstance) current = this.resolveClipMember(current, token);
      else if (Array.isArray(current)) current = token === "length" ? current.length : current[Number(this.resolveExpr(token, locals, scope) ?? token)];
      else if (isXmlNode(current)) current = readXmlNodeProperty(current, token);
      else if (isAvm1Object(current)) current = current[token];
      else return undefined;
    }
    return isVarValue(current) ? current : undefined;
  }

  private assignObjectPath(scope: ClipInstance, path: string | undefined, value: VarValue, locals?: Locals): boolean {
    const tokens = objectPathTokens(path ?? "");
    if (tokens.length < 2) return false;
    const property = tokens[tokens.length - 1];
    const ownerPath = tokens.slice(0, -1).join(".");
    const owner = this.resolveValueTarget(scope, ownerPath, locals);
    if (owner instanceof ClipInstance) {
      const setter = this.methodFunctionForClip(owner, `set ${property}`);
      if (setter) {
        this.callFunctionDef(setter.key, setter.def, "__setterValue", { __setterValue: value }, owner, scope);
      }
      owner.props[property] = value;
      markOwnedObject(value, owner, property);
      return true;
    }
    if (isAvm1Object(owner)) {
      owner[property] = value;
      return true;
    }
    return false;
  }

  private resolveClipMember(clip: ClipInstance, member: string): unknown {
    const displayProperty = readClipProperty(clip, member, this.getAsset(clip.characterId));
    if (displayProperty !== undefined) return displayProperty;
    if (member in clip.props) return clip.props[member];
    const child = this.findClipByName(clip, member);
    if (child) return child;
    return this.namedLeafObject(clip, member);
  }

  private namedLeafObject(clip: ClipInstance, name: string): VarValue | undefined {
    const frame = this.framesFor(clip)?.[clip.currentFrame];
    for (const instance of this.instancesForFrame(clip, frame)) {
      if (instance.name !== name) continue;
      const asset = this.getAsset(instance.characterId);
      if (!asset) continue;
      const text = asset.kind === "text" ? this.resolveTextField(asset.id, asset, clip, name) : undefined;
      const props = this.leafDisplayProps(clip, name);
      if (props._width === undefined) props._width = text ? measuredTextWidth(text.text ?? "", text.fontHeight, asset.text?.width ?? asset.origin.width ?? 0) : (asset.text?.width ?? asset.origin.width ?? 0);
      if (props._height === undefined) props._height = text ? Math.max(text.height ?? 0, text.lineHeight ?? text.fontHeight + (text.leading ?? 0)) : (asset.text?.height ?? asset.origin.height ?? 0);
      if (props._x === undefined) props._x = instance.matrix.tx;
      if (props._y === undefined) props._y = instance.matrix.ty;
      return props;
    }
    return undefined;
  }

  private findLeafChild(clip: ClipInstance, name: string): TimelineFrame["instances"][number] | undefined {
    const frame = this.framesFor(clip)?.[clip.currentFrame];
    for (const instance of this.instancesForFrame(clip, frame)) {
      if (instance.name !== name) continue;
      const asset = this.getAsset(instance.characterId);
      if (asset && asset.kind !== "sprite" && asset.kind !== "button") return instance;
    }
    return undefined;
  }

  private leafDisplayProps(clip: ClipInstance, name: string): Record<string, VarValue | undefined> {
    let props = clip.leafProps.get(name);
    if (!props) {
      props = {};
      clip.leafProps.set(name, props);
    }
    return props;
  }

  private resolveObjectLiteral(raw: string, locals: Locals | undefined, scope: ClipInstance): Record<string, VarValue | undefined> {
    const object: Record<string, VarValue | undefined> = {};
    for (const part of splitTopLevelArgs(raw.slice(1, -1))) {
      const at = part.indexOf(":");
      if (at < 0) continue;
      const key = part.slice(0, at).trim().replace(/^["']|["']$/g, "");
      if (!key) continue;
      object[key] = this.resolveExpr(part.slice(at + 1), locals, scope);
    }
    return object;
  }

  private addEventListener(owner: ClipInstance, eventName: string, listener: { target: unknown; method: string }) {
    const listeners = eventListeners(owner);
    const list = listeners[eventName] ?? (listeners[eventName] = []);
    if (list.some((item) => item.target === listener.target && item.method === listener.method)) return;
    list.push(listener);
  }

  private removeEventListener(owner: ClipInstance, eventName: string, listener: { target: unknown; method: string }) {
    const listeners = eventListeners(owner);
    const list = listeners[eventName];
    if (!list?.length) return;
    listeners[eventName] = list.filter((item) => item.target !== listener.target || item.method !== listener.method);
  }

  private dispatchEvent(owner: ClipInstance, event: Record<string, unknown>) {
    const type = String(event.type ?? "");
    if (!type) return;
    for (const listener of eventListeners(owner)[type] ?? []) {
      if (!(listener.target instanceof ClipInstance)) continue;
      const method = this.methodFunctionForClip(listener.target, listener.method);
      if (!method) continue;
      this.callFunctionDef(method.key, method.def, "__event", { __event: event as VarValue }, listener.target);
    }
  }

  private dispatchMovieClipPointerEvent(owner: ClipInstance, event: ButtonEvent) {
    const type = movieClipEventName(event);
    const direct = directMovieClipHandlerName(event);
    const eventObject = { target: owner, type };
    const appDispatcher = owner.props.__appPointerDispatcher;
    if (typeof appDispatcher === "function") appDispatcher(type);
    if (direct) {
      const handler = owner.props[direct];
      if (isDelegate(handler) && handler.target instanceof ClipInstance) {
        const method = this.methodFunctionForClip(handler.target, handler.method);
        if (method) this.callFunctionDef(method.key, method.def, "__event", { __event: eventObject as VarValue }, handler.target);
      }
    }
    this.dispatchEvent(owner, eventObject);
  }

  private runAssignedEnterFrame(owner: ClipInstance) {
    const handler = owner.props.onEnterFrame;
    if (isDelegate(handler) && handler.target instanceof ClipInstance) {
      const method = this.methodFunctionForClip(handler.target, handler.method);
      if (method) this.callFunctionDef(method.key, method.def, "__event", { __event: { target: owner, type: "enterFrame" } as VarValue }, handler.target);
      return;
    }
    if (typeof handler === "string") {
      const method = this.methodFunctionForClip(owner, handler);
      if (method) this.callFunctionDef(method.key, method.def, undefined, undefined, owner);
    }
  }

  private runWhileBody(raw: string | undefined, locals: Locals, scope: ClipInstance) {
    const parsed = parseWhileBlob(raw);
    if (!parsed) return;
    for (let i = 0; i < 100 && this.evalSimpleCondition(parsed.condition, locals, scope); i += 1) {
      const control = this.runRuntimeStatements(parsed.body, locals, scope);
      if (control === "break") return;
      if (control === "continue") continue;
    }
  }

  private evalSimpleCondition(condition: string, locals: Locals, scope: ClipInstance): boolean {
    for (const op of ["<=", ">=", "==", "!=", "<", ">"]) {
      const parts = splitTopLevelOperator(condition, op);
      if (parts.length !== 2) continue;
      const left = this.resolveExpr(parts[0], locals, scope);
      const right = this.resolveExpr(parts[1], locals, scope);
      const ln = Number(left);
      const rn = Number(right);
      switch (op) {
        case "<=": return ln <= rn;
        case ">=": return ln >= rn;
        case "==": return String(left ?? "") === String(right ?? "");
        case "!=": return String(left ?? "") !== String(right ?? "");
        case "<": return ln < rn;
        case ">": return ln > rn;
      }
    }
    return avm1Boolean(this.resolveExpr(condition, locals, scope) ?? false);
  }

  private evalRuntimeCondition(condition: string, locals: Locals, scope: ClipInstance): boolean {
    let e = condition.trim();
    if (!e || e === "else" || e === "true") return true;
    if (e === "false") return false;
    while (e.startsWith("(") && matchingParenRuntime(e) === e.length - 1) e = e.slice(1, -1).trim();
    const orParts = splitTopLevelOperator(e, "||");
    if (orParts.length > 1) return orParts.some((part) => this.evalRuntimeCondition(part, locals, scope));
    const andParts = splitTopLevelOperator(e, "&&");
    if (andParts.length > 1) return andParts.every((part) => this.evalRuntimeCondition(part, locals, scope));
    if (e.startsWith("!")) return !this.evalRuntimeCondition(e.slice(1), locals, scope);
    const instanceofParts = splitTopLevelWordOperator(e, "instanceof");
    if (instanceofParts.length === 2) {
      return avm1InstanceOf(this.resolveExpr(instanceofParts[0], locals, scope), instanceofParts[1]);
    }
    for (const op of ["<=", ">=", "==", "!=", "<", ">"]) {
      const parts = splitTopLevelOperator(e, op);
      if (parts.length !== 2) continue;
      return compareRuntimeValues(this.resolveExpr(parts[0], locals, scope), this.resolveExpr(parts[1], locals, scope), op);
    }
    return avm1Boolean(this.resolveExpr(e, locals, scope) ?? false);
  }

  private runRuntimeStatements(body: string, locals: Locals, scope: ClipInstance): RuntimeControl {
    for (const statement of splitRuntimeStatements(body)) {
      const control = this.runRuntimeStatement(statement, locals, scope);
      if (control) return control;
    }
    return undefined;
  }

  private runRuntimeStatement(statement: string, locals: Locals, scope: ClipInstance): RuntimeControl {
    const s = statement.trim();
    if (!s || s.startsWith("trace(")) return undefined;
    if (s === "break" || s === "break;") return "break";
    if (s === "continue" || s === "continue;") return "continue";
    if (s.startsWith("var ")) return this.runRuntimeStatement(s.slice(4).trim(), locals, scope);
    const incDec = s.match(/^(.+?)(\+\+|--)$/s);
    if (incDec) {
      const target = incDec[1].trim();
      const current = Number(this.resolveExpr(target, locals, scope) ?? 0);
      this.assignRuntimeValue(target, current + (incDec[2] === "++" ? 1 : -1), locals, scope);
      return undefined;
    }
    const conditional = parseRuntimeIfBlock(s);
    if (conditional) {
      const body = this.evalRuntimeCondition(conditional.condition, locals, scope) ? conditional.thenBody : conditional.elseBody;
      const control = body === undefined ? undefined : this.runRuntimeStatements(body, locals, scope);
      if (control) return control;
      return conditional.tail === undefined ? undefined : this.runRuntimeStatements(conditional.tail, locals, scope);
    }
    const nestedWhile = parseWhileBlob(s);
    if (nestedWhile) {
      for (let i = 0; i < 100 && this.evalSimpleCondition(nestedWhile.condition, locals, scope); i += 1) {
        const control = this.runRuntimeStatements(nestedWhile.body, locals, scope);
        if (control === "break") return undefined;
        if (control === "continue") continue;
      }
      return undefined;
    }
    const plusAssign = s.match(/^(.+?)\s*\+=\s*(.+)$/s);
    if (plusAssign) {
      const current = this.resolveExpr(plusAssign[1].trim(), locals, scope);
      const delta = this.resolveExpr(plusAssign[2].trim(), locals, scope);
      const value = typeof current === "string" || typeof delta === "string"
        ? `${current ?? ""}${delta ?? ""}`
        : Number(current ?? 0) + Number(delta ?? 0);
      this.assignRuntimeValue(plusAssign[1].trim(), value, locals, scope);
      return undefined;
    }
    const assign = s.match(/^(.+?)\s*=\s*(.+)$/s);
    if (assign && !/[!<>]=?$/.test(assign[1].trim())) {
      this.assignRuntimeValue(assign[1].trim(), this.resolveExpr(assign[2].trim(), locals, scope), locals, scope);
      return undefined;
    }
    if (parseNewTween(s)) {
      this.resolveExpr(s, locals, scope);
      return undefined;
    }
    const call = parseRuntimeCall(s);
    if (call) this.runBodyCall({ kind: "call", target: call.target, functionName: call.name, arguments: call.arguments }, locals, scope);
    return undefined;
  }

  private assignRuntimeValue(target: string, value: VarValue | undefined, locals: Locals, scope: ClipInstance) {
    if (value === undefined) return;
    if (isLocalVar(target)) locals[target] = value;
    if (this.applyPropertyAssignment(scope, target, value, locals)) return;
    if (this.assignObjectPath(scope, target, value, locals)) return;
    this.scopeSet(scope, target, value);
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

  private instancesForFrame(clip: ClipInstance, frame: TimelineFrame | undefined): TimelineFrame["instances"] {
    const dynamic = [...clip.dynamicInstances.values()];
    if (!frame) return dynamic.sort((a, b) => effectiveDepthForInstance(clip, a) - effectiveDepthForInstance(clip, b));
    const hasDepthOverrides = [...clip.childClips.values()].some((child) => child.depthOverride !== undefined);
    if (!dynamic.length && !hasDepthOverrides) return frame.instances;
    const dynamicDepths = new Set(dynamic.map((instance) => instance.depth));
    return [
      ...frame.instances.filter((instance) => !dynamicDepths.has(instance.depth)),
      ...dynamic,
    ].sort((a, b) => effectiveDepthForInstance(clip, a) - effectiveDepthForInstance(clip, b));
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

  /** Whether `clip` or any descendant holds a runtime-attached instance (attachMovie /
   *  createEmptyMovieClip). Used to pull a baked sprite onto the tree render path so its
   *  attached children render. Only called when `hasAnyDynamicInstances` is set, so
   *  attachMovie-free scenes never walk here. */
  private subtreeHasDynamicInstances(clip: ClipInstance): boolean {
    if (clip.dynamicInstances.size > 0) return true;
    for (const child of clip.childClips.values()) {
      if (this.subtreeHasDynamicInstances(child)) return true;
    }
    return false;
  }

  /** Alpha contribution of a placed instance. A clip's design alpha (the placement's
   *  color-transform alpha) and a runtime `_alpha` are the SAME Flash property, so a
   *  runtime `_alpha` REPLACES the design alpha rather than multiplying with it. The
   *  legacy multiply is kept for the tour (where nothing sets `_alpha` over a faded
   *  placement); the override is applied in data-driven app mode, where a section's
   *  content panel is authored hidden (cxform alpha 0) and revealed at runtime — the
   *  multiply would otherwise keep it at 0 even after the app sets `_alpha = 100`. */
  private placedAlpha(instanceOpacity: number, child: ClipInstance | undefined): number {
    if (this.dataApp && child?.alpha !== undefined) return clipAlpha(child);
    return instanceOpacity * clipAlpha(child);
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
    const frame = frames?.[clip.currentFrame];
    const instances = this.instancesForFrame(clip, frame);
    const loadedSrc = primitiveValue(clip.props.__loadedSrc);
    if (typeof loadedSrc === "string" && isImageUrl(loadedSrc)) {
      out.push({
        key: `${path}#loaded`,
        order: order.n++,
        characterId: 0,
        kind: "image",
        name: clip.name,
        src: loadedSrc,
        origin: {
          x: 0,
          y: 0,
          width: Number(clip.props.__loadedWidth ?? 0),
          height: Number(clip.props.__loadedHeight ?? 0),
        },
        matrix: world,
        opacity: worldOpacity * clipAlpha(clip),
        colorTransform: worldColorTransform,
      });
    }
    if (clip.loadedTimeline) {
      const frameIndex = clamp(clip.loadedFrame, 0, Math.max(0, (clip.loadedTimeline.frameCount ?? 1) - 1));
      const src = clip.loadedTimeline.frameSvgs?.[frameIndex]
        ?? (clip.loadedTimeline.frameSvgsOmitted ? "" : `generated/${clip.loadedTimeline.scene}/frames/${frameIndex + 1}.svg`);
      if (src) {
        out.push({
          key: `${path}#loaded-swf`,
          order: order.n++,
          characterId: 0,
          kind: "sprite",
          name: clip.name,
          src,
          origin: {
            x: 0,
            y: 0,
            width: clip.loadedTimeline.dimensions.width,
            height: clip.loadedTimeline.dimensions.height,
          },
          matrix: world,
          opacity: worldOpacity * clipAlpha(clip),
          colorTransform: worldColorTransform,
          spriteFrame: frameIndex,
        });
      }
    }
    if (!instances.length) return;
    const occupiedDepths = new Set(instances.map((instance) => instance.depth));
    const runtimeMaskClips = new Set<ClipInstance>();
    for (const candidate of clip.childClips.values()) {
      if (candidate.maskClip) runtimeMaskClips.add(candidate.maskClip);
    }

    // Active masks (SWF clipDepth): a mask collects the instances at depths it
    // clips, and is emitted as one alpha-masked SVG group once its range ends.
    const maskStack: Array<{ key: string; order: number; clipDepth: number; group: NonNullable<RenderNode["maskGroup"]> }> = [];
    const flushMasks = (depth: number) => {
      while (maskStack.length && depth > maskStack[maskStack.length - 1].clipDepth) {
        const mask = maskStack.pop()!;
        out.push({ key: mask.key, order: mask.order, characterId: 0, kind: "shape", name: "", src: "", origin: ZERO_ORIGIN, matrix: world, opacity: 1, maskGroup: mask.group });
      }
    };

    for (const instance of instances) {
      flushMasks(instance.depth);
      const asset = this.getAsset(instance.characterId);
      const child = clip.childClips.get(instance.depth);
      if (child && runtimeMaskClips.has(child)) continue;
      if (child?.visible === false) continue;
      const matrix = multiplyMatrix(world, applyClipMatrixOverrides(instance.matrix, child));
      const opacity = worldOpacity * this.placedAlpha(instance.opacity, child);
      const colorTransform = composeRenderColorTransform(worldColorTransform, instance.colorTransform);
      const key = `${path}/${instance.depth}`;
      if (!asset) {
        if (child) this.flatten(child, matrix, opacity, colorTransform, key, order, out);
        continue;
      }

      if (child?.maskClip) {
        const group = this.runtimeMaskGroup(clip, child, world, matrix, opacity, colorTransform, key, order);
        if (group) {
          out.push(group);
          continue;
        }
      }

      // A mask: capture its shape, then clip the instances below it (up to clipDepth).
      if (instance.clipDepth) {
        const src = visualSrc(asset, child);
        if (src) {
          maskStack.push({
            key: `${key}#mask`,
            order: order.n++,
            clipDepth: instance.clipDepth,
            group: { mask: { characterId: asset.id, src, origin: asset.origin, matrix, opacity: 1, colorTransform, ...renderMetadataFromInstance(instance) }, items: [] },
          });
        }
        continue;
      }

      // Inside an active mask → collect the instance as a masked item, not a normal node.
      const activeMask = maskStack[maskStack.length - 1];
      if (activeMask && instance.depth <= activeMask.clipDepth) {
        const timelineSprite = asset.kind === "sprite" && child && child.characterId === asset.id
          && (asset.timeline?.length || (this.hasAnyDynamicInstances && this.subtreeHasDynamicInstances(child)));
        if (timelineSprite) {
          const temp: RenderNode[] = [];
          this.flatten(child, matrix, opacity, colorTransform, key, order, temp);
          activeMask.group.items.push(...this.maskVisualsFromNodes(temp));
        } else {
          const src = visualSrc(asset, child);
          if (src) activeMask.group.items.push({ characterId: asset.id, src, origin: asset.origin, matrix, opacity, colorTransform, ...renderMetadataFromInstance(instance) });
        }
        continue;
      }

      // Sprite with baked frames → render the composited frame for visual fidelity
      // (FFDec bakes masks/group-alpha the nested leaves would lose), and overlay
      // transparent button hit areas from its nested timeline so it stays
      // interactive and its frame scripts still run (logic lives in the tree).
      if (asset.kind === "sprite" && asset.frames?.length && !asset.overflowsBounds
          && !(this.hasAnyDynamicInstances && child && this.subtreeHasDynamicInstances(child))) {
        const frameIndex = child ? clamp(child.currentFrame, 0, asset.frames.length - 1) : 0;
        out.push(spriteNode(key, order.n++, asset, asset.frames[frameIndex], matrix, opacity, instance, child?.currentFrame, colorTransform));
        if (child && asset.timeline?.length) this.collectButtons(child, matrix, colorTransform, key, order, out, opacity);
        if (child && this.clipHasPointerEvents(child)) out.push(this.movieClipHitNode(`${key}#hit`, order.n++, asset, matrix, instance, key, colorTransform));
        continue;
      }

      // Sprite whose animated content slides outside its baked-frame bounds (e.g. the nav
      // cascade buttons), a sprite with only a nested timeline (no baked frames), or one
      // that gained runtime-attached children (attachMovie — e.g. bnl's tickerHolder, which
      // has no timeline of its own) → render from the display-list tree so the moving /
      // attached content isn't clipped or dropped.
      if (asset.kind === "sprite" && child && child.characterId === asset.id
          && (asset.timeline?.length || (this.hasAnyDynamicInstances && child.dynamicInstances.size))) {
        this.clipByPath.set(key, child);
        if (this.clipHasPointerEvents(child)) out.push(this.movieClipHitNode(`${key}#hit`, order.n++, asset, matrix, instance, key, colorTransform));
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

      const leafProps = instance.name ? clip.leafProps.get(instance.name) : undefined;
      if (leafProps?._visible === false || leafProps?._visible === 0) continue;
      out.push(this.leafNode(key, order.n++, asset, asset.src ?? "", applyLeafMatrixOverrides(world, instance.matrix, asset, leafProps), opacity * leafAlpha(leafProps), instance, colorTransform, clip, leafProps));
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
    opacity = 1,
  ) {
    this.clipByPath.set(path, clip);
    const frames = this.framesFor(clip);
    if (!frames) return;
    const frame = frames[clip.currentFrame];
    if (!frame) return;
    const instances = this.instancesForFrame(clip, frame);
    const occupiedDepths = new Set(instances.map((instance) => instance.depth));

    for (const instance of instances) {
      if (instance.clipDepth) continue; // a mask shape — not an overlay leaf
      const asset = this.getAsset(instance.characterId);
      if (!asset) continue;
      const child = clip.childClips.get(instance.depth);
      if (child?.visible === false) continue;
      const matrix = multiplyMatrix(world, applyClipMatrixOverrides(instance.matrix, child));
      const instanceOpacity = opacity * this.placedAlpha(instance.opacity, child);
      const colorTransform = composeRenderColorTransform(worldColorTransform, instance.colorTransform);
      const key = `${path}/${instance.depth}`;
      if (asset.kind === "button") {
        // Baked path: the button's visual is in the composited frame — just a hit area.
        out.push(buttonNode(key, order.n++, asset, matrix, instance, path, false, instanceOpacity, this.buttonVisualStates.get(key), colorTransform));
        this.collectButtonText(asset, matrix, colorTransform, key, order, out, instance, instanceOpacity);
      } else if (asset.kind === "text") {
        // editText is stripped from the baked sprite frame (FFDec bakes it mispositioned),
        // so re-draw it here at its own bounds: a loadVariables()-bound field once its value
        // loads, or a static field (e.g. the "Best for Business" nav title) from its own text.
        const field = this.resolveTextField(asset.id, asset, clip, instance.name);
        const show = field?.normalizedVariableName
          ? this.textVars.has(field.normalizedVariableName)
          : Boolean(field?.text && String(field.text).trim());
        if (show) {
          const leafProps = instance.name ? clip.leafProps.get(instance.name) : undefined;
          if (leafProps?._visible === false || leafProps?._visible === 0) continue;
          out.push(this.leafNode(key, order.n++, asset, asset.src ?? "", applyLeafMatrixOverrides(world, instance.matrix, asset, leafProps), instanceOpacity * leafAlpha(leafProps), instance, colorTransform, clip, leafProps));
        }
      } else if (asset.kind === "sprite") {
        if (child) {
          if (clip.dynamicInstances.has(instance.depth) && asset.frames?.length) {
            const frameIndex = clamp(child.currentFrame, 0, asset.frames.length - 1);
            out.push(spriteNode(key, order.n++, asset, asset.frames[frameIndex], matrix, instanceOpacity, instance, child.currentFrame, colorTransform));
          }
          if (this.clipHasPointerEvents(child)) out.push(this.movieClipHitNode(`${key}#hit`, order.n++, asset, matrix, instance, key, colorTransform));
          this.collectButtons(child, matrix, colorTransform, key, order, out, instanceOpacity);
        }
      }
    }
    this.collectLatentButtons(clip, world, worldColorTransform, path, order, out, occupiedDepths, opacity);
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
      const colorTransform = composeRenderColorTransform(worldColorTransform, instance.colorTransform);
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

  private runtimeMaskGroup(
    parent: ClipInstance,
    target: ClipInstance,
    parentWorld: RenderNode["matrix"],
    targetWorld: RenderNode["matrix"],
    opacity: number,
    colorTransform: RenderNode["colorTransform"],
    key: string,
    order: { n: number },
  ): RenderNode | undefined {
    const maskClip = target.maskClip;
    if (!maskClip) return undefined;
    const maskPlacement = this.placementForChild(parent, maskClip);
    if (!maskPlacement) return undefined;
    const maskAsset = this.getAsset(maskPlacement.characterId);
    if (!maskAsset) return undefined;
    const src = visualSrc(maskAsset, maskClip);
    if (!src) return undefined;
    const maskMatrix = multiplyMatrix(parentWorld, applyClipMatrixOverrides(maskPlacement.matrix, maskClip));
    const temp: RenderNode[] = [];
    this.flatten(target, targetWorld, opacity, colorTransform, key, order, temp);
    const items = this.maskVisualsFromNodes(temp);
    if (!items.length) return undefined;
    return {
      key: `${key}#runtime-mask`,
      order: order.n++,
      characterId: 0,
      kind: "shape",
      name: "",
      src: "",
      origin: ZERO_ORIGIN,
      matrix: parentWorld,
      opacity: 1,
      maskGroup: {
        mask: {
          characterId: maskAsset.id,
          src,
          origin: maskAsset.origin,
          matrix: maskMatrix,
          opacity: 1,
          ...renderMetadataFromInstance(maskPlacement),
        },
        items,
      },
    };
  }

  private maskVisualsFromNodes(nodes: RenderNode[]): NonNullable<RenderNode["maskGroup"]>["items"] {
    return nodes
      .filter((node) =>
        node.kind !== "button"
        && (Boolean(node.maskGroup) || Boolean(node.src) || (node.kind === "text" && Boolean(node.text)))
      )
      .map((node) => ({
        key: node.key,
        characterId: node.characterId,
        kind: node.kind,
        src: node.src,
        origin: node.origin,
        matrix: node.matrix,
        opacity: node.opacity,
        colorTransform: node.colorTransform,
        text: node.text,
        maskGroup: node.maskGroup,
        ...renderMetadataSubset(node),
      }));
  }

  private placementForChild(parent: ClipInstance, child: ClipInstance): TimelineFrame["instances"][number] | undefined {
    const frame = this.framesFor(parent)?.[parent.currentFrame];
    for (const instance of this.instancesForFrame(parent, frame)) {
      if (parent.childClips.get(instance.depth) === child) return instance;
    }
    return undefined;
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
    opacity = instance.opacity,
  ) {
    for (const field of asset.textFields ?? []) {
      const fieldAsset = this.getAsset(field.id);
      if (!fieldAsset) continue;
      const resolved = this.resolveTextField(field.id, fieldAsset);
      // Only overlay once a loadVariables() value exists (else the baked frame is authoritative).
      if (!resolved?.normalizedVariableName || !this.textVars.has(resolved.normalizedVariableName)) continue;
      const matrix = multiplyMatrix(buttonMatrix, field.matrix);
      out.push(this.leafNode(`${key}/txt:${field.id}`, order.n++, fieldAsset, fieldAsset.src ?? "", matrix, opacity, instance, buttonColorTransform));
    }
  }

  private clipHasPointerEvents(clip: ClipInstance): boolean {
    const listeners = clip.props.__eventListeners;
    if (isAvm1Object(listeners)) {
      for (const name of ["release", "releaseoutside", "rollover", "rollout", "press"]) {
        if (Array.isArray(listeners[name]) && listeners[name].length) return true;
      }
    }
    if (clip.props.__appPointerEvents || typeof clip.props.__appPointerDispatcher === "function") return true;
    return isDelegate(clip.props.onRelease) || isDelegate(clip.props.onReleaseOutside) || isDelegate(clip.props.onRollOver) || isDelegate(clip.props.onRollOut) || isDelegate(clip.props.onPress);
  }

  private movieClipHitNode(
    key: string,
    order: number,
    asset: TimelineAsset,
    matrix: RenderNode["matrix"],
    instance: TimelineFrame["instances"][number],
    ownerPath: string,
    colorTransform: RenderNode["colorTransform"],
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
      colorTransform,
      ...renderMetadataFromInstance(instance),
      buttonOwnerPath: ownerPath,
    };
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
    parentClip?: ClipInstance,
    leafProps?: Record<string, VarValue | undefined>,
  ): RenderNode {
    return {
      key,
      order,
      characterId: asset.id,
      kind: asset.kind,
      name: instance.name,
      src,
      origin: applyLeafOriginOverrides(asset, leafProps),
      matrix,
      opacity,
      colorTransform,
      ...renderMetadataFromInstance(instance),
      clipDepth: instance.clipDepth,
      text: asset.kind === "text" ? this.resolveTextField(asset.id, asset, parentClip, instance.name) : undefined,
    };
  }

  /** Merge loadVariables() text into the player and re-render bound fields. */
  setTextVars(vars: Record<string, string>) {
    for (const [key, value] of Object.entries(vars)) this.textVars.set(key, value);
    this.render();
  }

  private resolveTextField(characterId: number, asset: TimelineAsset, owner?: ClipInstance, name?: string) {
    const base = asset.text;
    const dynamic = this.timeline.control?.dynamicTexts?.[String(characterId)];
    const merged = base && dynamic ? { ...base, ...dynamic } : (base ?? dynamic);
    const scopedOverride = owner && name ? this.clipTextOverrides.get(owner)?.get(name) : undefined;
    if (scopedOverride && merged) return { ...merged, ...scopedOverride, html: scopedOverride.html ?? merged.html };
    const override = this.textOverrides.get(characterId);
    if (override && merged) return { ...merged, ...override, html: override.html ?? merged.html };
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

function splitPropertyTarget(target: string | undefined): { owner: string; property: string } | null {
  const text = target?.trim();
  if (!text) return null;
  const parts = text.split(".");
  if (parts.length < 2) return null;
  const property = normalizeAvm1PropertyName(parts[parts.length - 1]);
  if (!property) return null;
  return { owner: parts.slice(0, -1).join(".") || "this", property };
}

function renderMetadataSubset(node: RenderNode): RenderPlacementMetadata {
  return {
    visible: node.visible,
    blendMode: node.blendMode,
    filters: node.filters,
    cacheAsBitmap: node.cacheAsBitmap,
    className: node.className,
    clipActions: node.clipActions,
  };
}

function dynamicTextFromTextFormat(format: Record<string, VarValue | undefined>): Partial<DynamicText> {
  const out: Partial<DynamicText> = {};
  const color = flashColor(format.color);
  if (color) out.color = color;
  const leading = Number(format.leading);
  if (Number.isFinite(leading)) out.leading = leading;
  const size = Number(format.size);
  if (Number.isFinite(size) && size > 0) out.fontHeight = size;
  const align = typeof format.align === "string" ? format.align.toLowerCase() : "";
  if (align === "left" || align === "right" || align === "center" || align === "justify") out.align = align;
  return out;
}

function flashColor(value: VarValue | undefined): string | undefined {
  if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return `#${(Math.max(0, Math.min(0xffffff, Math.round(n))).toString(16).padStart(6, "0"))}`;
}

function setClipProperty(clip: ClipInstance, property: string, value: VarValue): boolean {
  switch (property) {
    case "_name":
      clip.name = String(value ?? "");
      return true;
    case "_visible":
      clip.visible = avm1Boolean(value);
      return true;
    case "_alpha": {
      const alpha = Number(value);
      if (!Number.isFinite(alpha)) return false;
      clip.alpha = alpha;
      return true;
    }
    case "_x": {
      const x = Number(value);
      if (!Number.isFinite(x)) return false;
      clip.x = x;
      return true;
    }
    case "_y": {
      const y = Number(value);
      if (!Number.isFinite(y)) return false;
      clip.y = y;
      return true;
    }
    case "_rotation": {
      const rotation = Number(value);
      if (!Number.isFinite(rotation)) return false;
      clip.rotation = rotation;
      return true;
    }
    case "_width": {
      const width = Number(value);
      if (!Number.isFinite(width)) return false;
      clip.width = width;
      return true;
    }
    case "_height": {
      const height = Number(value);
      if (!Number.isFinite(height)) return false;
      clip.height = height;
      return true;
    }
    case "_xscale": {
      const xscale = Number(value);
      if (!Number.isFinite(xscale)) return false;
      clip.xscale = xscale;
      return true;
    }
    case "_yscale": {
      const yscale = Number(value);
      if (!Number.isFinite(yscale)) return false;
      clip.yscale = yscale;
      return true;
    }
    default:
      return false;
  }
}

function avm1Boolean(value: VarValue): boolean {
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value !== "" && value !== "0" && value.toLowerCase() !== "false";
  return true;
}

function compareRuntimeValues(left: VarValue | undefined, right: VarValue | undefined, op: string): boolean {
  if ((left === null || left === undefined) && (right === null || right === undefined)) {
    if (op === "==") return true;
    if (op === "!=") return false;
  }
  const ln = typeof left === "number" || typeof left === "boolean" || (typeof left === "string" && /^-?\d+(\.\d+)?$/.test(left.trim()))
    ? Number(left)
    : undefined;
  const rn = typeof right === "number" || typeof right === "boolean" || (typeof right === "string" && /^-?\d+(\.\d+)?$/.test(right.trim()))
    ? Number(right)
    : undefined;
  if (ln !== undefined && rn !== undefined && Number.isFinite(ln) && Number.isFinite(rn)) {
    switch (op) {
      case "==": return ln === rn;
      case "!=": return ln !== rn;
      case "<": return ln < rn;
      case ">": return ln > rn;
      case "<=": return ln <= rn;
      case ">=": return ln >= rn;
    }
  }
  const ls = left === undefined ? "" : String(left);
  const rs = right === undefined ? "" : String(right);
  switch (op) {
    case "==": return ls === rs;
    case "!=": return ls !== rs;
    case "<": return ls < rs;
    case ">": return ls > rs;
    case "<=": return ls <= rs;
    case ">=": return ls >= rs;
    default: return false;
  }
}

function tweenDurationMs(durationValue: VarValue | undefined, useSecondsValue: VarValue | undefined, fps: number): number {
  const duration = Number(durationValue);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return avm1Boolean(useSecondsValue ?? false)
    ? duration * 1000
    : duration * (1000 / Math.max(1, fps));
}

function clipAlpha(clip: ClipInstance | undefined): number {
  return clip?.alpha === undefined ? 1 : clamp(clip.alpha / 100, 0, 1);
}

function leafAlpha(props: Record<string, VarValue | undefined> | undefined): number {
  const alpha = Number(props?._alpha);
  return Number.isFinite(alpha) ? clamp(alpha / 100, 0, 1) : 1;
}

function applyClipMatrixOverrides<T extends { a: number; b: number; c: number; d: number; tx: number; ty: number }>(matrix: T, clip: ClipInstance | undefined): T {
  if (!clip || (clip.x === undefined && clip.y === undefined && clip.rotation === undefined && clip.xscale === undefined && clip.yscale === undefined)) return matrix;
  const next = { ...matrix };
  const sx = clip.xscale !== undefined ? clip.xscale / 100 : 1;
  const sy = clip.yscale !== undefined ? clip.yscale / 100 : 1;
  if (sx !== 1) {
    next.a *= sx;
    next.b *= sx;
  }
  if (sy !== 1) {
    next.c *= sy;
    next.d *= sy;
  }
  if (clip.x !== undefined) next.tx = clip.x;
  if (clip.y !== undefined) next.ty = clip.y;
  if (clip.rotation !== undefined) {
    const radians = clip.rotation * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const sx = Math.hypot(matrix.a, matrix.b) || 1;
    const sy = Math.hypot(matrix.c, matrix.d) || 1;
    next.a = cos * sx;
    next.b = sin * sx;
    next.c = -sin * sy;
    next.d = cos * sy;
  }
  return next;
}

function applyLeafMatrixOverrides<T extends { a: number; b: number; c: number; d: number; tx: number; ty: number }>(
  world: T,
  local: T,
  asset: TimelineAsset,
  props: Record<string, VarValue | undefined> | undefined,
): T {
  if (!props) return multiplyMatrix(world, local) as T;
  const next = { ...local };
  const sx = Number(props._xscale) / 100;
  const sy = Number(props._yscale) / 100;
  const width = Number(props._width);
  const height = Number(props._height);
  const baseWidth = Math.max(1, asset.text?.width ?? asset.origin.width ?? Math.hypot(local.a, local.b));
  const baseHeight = Math.max(1, asset.text?.height ?? asset.origin.height ?? Math.hypot(local.c, local.d));
  const scaleX = Number.isFinite(sx) ? sx : Number.isFinite(width) ? width / baseWidth : 1;
  const scaleY = Number.isFinite(sy) ? sy : Number.isFinite(height) ? height / baseHeight : 1;
  if (scaleX !== 1) {
    next.a *= scaleX;
    next.b *= scaleX;
  }
  if (scaleY !== 1) {
    next.c *= scaleY;
    next.d *= scaleY;
  }
  const x = Number(props._x);
  const y = Number(props._y);
  if (Number.isFinite(x)) next.tx = x;
  if (Number.isFinite(y)) next.ty = y;
  return multiplyMatrix(world, next) as T;
}

function applyLeafOriginOverrides(asset: TimelineAsset, props: Record<string, VarValue | undefined> | undefined) {
  const width = Number(props?._width);
  const height = Number(props?._height);
  if (!Number.isFinite(width) && !Number.isFinite(height)) return asset.origin;
  return {
    ...asset.origin,
    width: Number.isFinite(width) ? width : asset.origin.width,
    height: Number.isFinite(height) ? height : asset.origin.height,
  };
}

function transformedBounds(origin: TimelineAsset["origin"], matrix: Matrix) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of [
    [origin.x, origin.y],
    [origin.x + origin.width, origin.y],
    [origin.x, origin.y + origin.height],
    [origin.x + origin.width, origin.y + origin.height],
  ]) {
    const px = matrix.a * x + matrix.c * y + matrix.tx;
    const py = matrix.b * x + matrix.d * y + matrix.ty;
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function effectiveDepthForInstance(parent: ClipInstance, instance: TimelineFrame["instances"][number]): number {
  return effectiveDepthForChild(parent, instance.depth);
}

function effectiveDepthForChild(parent: ClipInstance, depth: number): number {
  return parent.childClips.get(depth)?.depthOverride ?? depth;
}

function shouldFallbackToGlobalFunction(target: string, functionName: string): boolean {
  if (!target.includes(".")) return false;
  return functionName === "main" || functionName === "init" || /^[A-Z]/.test(functionName);
}

function methodFunctionKey(sourceKey: string, functionName: string): string {
  return `${sourceKey}:${functionName}`;
}

function methodSourceKey(source: string | undefined): string | undefined {
  const file = source?.split("/").pop()?.replace(/\.as$/i, "");
  return normalizeMethodKey(file);
}

function clipSourceKey(asset: TimelineAsset | undefined, name: string): string | undefined {
  const frame = asset?.frames?.[0];
  const spriteName = frame?.match(/\/DefineSprite_\d+_([^/]+)\//)?.[1];
  return normalizeMethodKey(spriteName) ?? normalizeMethodKey(name);
}

function normalizeMethodKey(value: string | undefined): string | undefined {
  const normalized = value?.replace(/%20/g, " ").replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
  return normalized || undefined;
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

function constructorCallName(raw: string | undefined): string | undefined {
  const match = raw?.trim().match(/^new\s+([\w$.]+)\s*\(/);
  return match?.[1]?.split(".").pop();
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

function normalizeLinkageName(name: string): string {
  return name.trim().toLowerCase();
}

function isAvm1Object(value: unknown): value is Record<string, VarValue | undefined> {
  return typeof value === "object" && value !== null && !(value instanceof ClipInstance);
}

function isVarValue(value: unknown): value is VarValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || (typeof value === "object" && value !== null);
}

function primitiveValue(value: VarValue | undefined): string | number | boolean | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function objectPathTokens(path: string): string[] {
  const out: string[] = [];
  let token = "";
  let bracket = "";
  let quote = "";
  for (let i = 0; i < path.length; i += 1) {
    const c = path[i];
    if (quote) {
      if (c === quote && path[i - 1] !== "\\") quote = "";
      else token += c;
      continue;
    }
    if (bracket) {
      if (c === '"' || c === "'") quote = c;
      else if (c === "]") {
        out.push(token.trim().replace(/^["']|["']$/g, ""));
        token = "";
        bracket = "";
      } else token += c;
      continue;
    }
    if (c === ".") {
      if (token) out.push(token);
      token = "";
    } else if (c === "[") {
      if (token) out.push(token);
      token = "";
      bracket = c;
    } else token += c;
  }
  if (token) out.push(token);
  return out.filter(Boolean);
}

function looksLikeObjectPath(expr: string): boolean {
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])+$/.test(expr.trim());
}

function splitTopLevelTernary(expr: string): { condition: string; whenTrue: string; whenFalse: string } | undefined {
  let depth = 0;
  let quote = "";
  let q = -1;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (quote) {
      if (c === quote && expr[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "?" && depth === 0) {
      q = i;
      break;
    }
  }
  if (q < 0) return undefined;
  depth = 0;
  quote = "";
  for (let i = q + 1; i < expr.length; i += 1) {
    const c = expr[i];
    if (quote) {
      if (c === quote && expr[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === ":" && depth === 0) {
      return {
        condition: expr.slice(0, q).trim(),
        whenTrue: expr.slice(q + 1, i).trim(),
        whenFalse: expr.slice(i + 1).trim(),
      };
    }
  }
  return undefined;
}

function parseMethodCall(expr: string, method: string): { target?: string; arguments: string } | undefined {
  const bare = singleArgCall(expr, method);
  if (bare !== undefined) return { arguments: bare };
  const suffix = `.${method}(`;
  const at = expr.indexOf(suffix);
  if (at < 0 || !expr.endsWith(")")) return undefined;
  const wrapped = expr.slice(at + suffix.length - 1);
  if (matchingParenRuntime(wrapped) !== wrapped.length - 1) return undefined;
  return { target: expr.slice(0, at), arguments: wrapped.slice(1, -1) };
}

function parseXPathCall(expr: string): { name: "selectSingleNode" | "selectNodes"; arguments: string } | undefined {
  const match = expr.match(/^com\.xfactorstudio\.xml\.xpath\.XPath\.(selectSingleNode|selectNodes)\((.*)\)$/s);
  return match ? { name: match[1] as "selectSingleNode" | "selectNodes", arguments: match[2] } : undefined;
}

function parseXPathMemberCall(expr: string): { name: "selectSingleNode" | "selectNodes"; arguments: string; memberPath: string } | undefined {
  const prefix = "com.xfactorstudio.xml.xpath.XPath.";
  if (!expr.startsWith(prefix)) return undefined;
  const nameMatch = expr.slice(prefix.length).match(/^(selectSingleNode|selectNodes)\(/);
  if (!nameMatch) return undefined;
  const name = nameMatch[1] as "selectSingleNode" | "selectNodes";
  const callStart = prefix.length + name.length;
  const callText = expr.slice(callStart);
  const close = matchingParenRuntime(callText);
  if (close < 0 || callText[close + 1] !== ".") return undefined;
  return {
    name,
    arguments: callText.slice(1, close),
    memberPath: callText.slice(close + 2),
  };
}

function parseNewTween(expr: string): { arguments: string } | undefined {
  const match = expr.match(/^new\s+mx\.transitions\.Tween\s*\((.*)\)$/s);
  return match ? { arguments: match[1] } : undefined;
}

function parseWhileBlob(raw: string | undefined): { condition: string; body: string } | undefined {
  if (!raw) return undefined;
  const open = raw.indexOf("{");
  if (open < 0) return undefined;
  const condition = raw.slice(0, open).replace(/\)\s*$/, "").trim();
  let depth = 0;
  let quote = "";
  for (let i = open; i < raw.length; i += 1) {
    const c = raw[i];
    if (quote) {
      if (c === quote && raw[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return { condition, body: raw.slice(open + 1, i) };
    }
  }
  return undefined;
}

function parseRuntimeIfBlock(raw: string): { condition: string; thenBody: string; elseBody?: string; tail?: string } | undefined {
  const text = raw.trim();
  if (!/^if\s*\(/.test(text)) return undefined;
  const conditionStart = text.indexOf("(");
  const conditionEnd = matchingParenRuntime(text.slice(conditionStart));
  if (conditionEnd < 0) return undefined;
  const absoluteConditionEnd = conditionStart + conditionEnd;
  const condition = text.slice(conditionStart + 1, absoluteConditionEnd).trim();
  const thenStart = text.indexOf("{", absoluteConditionEnd + 1);
  if (thenStart < 0) return undefined;
  const thenEnd = matchingBrace(text, thenStart);
  if (thenEnd < 0) return undefined;
  const thenBody = text.slice(thenStart + 1, thenEnd);
  const tail = text.slice(thenEnd + 1).trim();
  if (!tail) return { condition, thenBody };
  if (!tail.startsWith("else")) return { condition, thenBody, tail };
  const elseTail = tail.slice(4).trim();
  if (elseTail.startsWith("if")) {
    return { condition, thenBody, elseBody: elseTail };
  }
  if (!elseTail.startsWith("{")) return undefined;
  const elseEnd = matchingBrace(elseTail, 0);
  if (elseEnd < 0) return undefined;
  return { condition, thenBody, elseBody: elseTail.slice(1, elseEnd) };
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitRuntimeStatements(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let last = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      if (c === quote && body[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (c === ";" && depth === 0) {
      out.push(body.slice(last, i).trim());
      last = i + 1;
    }
  }
  out.push(body.slice(last).trim());
  return out.filter(Boolean);
}

function parseRuntimeCall(statement: string): { target?: string; name: string; arguments: string } | undefined {
  const match = statement.match(/^(.+?)\s*\((.*)\)$/s);
  if (!match) return undefined;
  const callee = match[1].trim();
  const dot = callee.lastIndexOf(".");
  return dot >= 0
    ? { target: callee.slice(0, dot), name: callee.slice(dot + 1), arguments: match[2] }
    : { name: callee, arguments: match[2] };
}

function readClipProperty(clip: ClipInstance, property: string, asset: TimelineAsset | undefined): VarValue | undefined {
  switch (property) {
    case "_name":
      return clip.name;
    case "_currentframe":
      return clip.currentFrame + 1;
    case "_totalframes":
      return Math.max(1, asset?.timeline?.length ?? asset?.frames?.length ?? 1);
    case "_width":
      return clip.width ?? asset?.origin.width ?? 0;
    case "_height":
      return clip.height ?? asset?.origin.height ?? 0;
    case "_xscale":
      return clip.xscale ?? 100;
    case "_yscale":
      return clip.yscale ?? 100;
    case "_x":
      return clip.x ?? clip.placedX;
    case "_y":
      return clip.y ?? clip.placedY;
    case "_alpha":
      return clip.alpha ?? 100;
    case "_visible":
      return clip.visible ?? true;
    default:
      return undefined;
  }
}

function measuredTextWidth(text: string, fontHeight: number | undefined, fallback: number, allowShrink = false): number {
  const normalized = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  if (!normalized) return allowShrink ? 0 : fallback;
  const height = Number(fontHeight);
  if (!Number.isFinite(height) || height <= 0) return fallback;
  const measured = Math.max(1, normalized.length * height * 0.62);
  return allowShrink ? measured : Math.max(fallback || 1, measured);
}

function parseDelegateCreate(expr: string): { target: string; method: string } | undefined {
  const args = singleArgCall(expr, "mx.utils.Delegate.create");
  if (args === undefined) return undefined;
  const [target, method] = splitTopLevelArgs(args);
  if (!target || !method) return undefined;
  return { target: target.trim(), method: method.trim() };
}

function isDelegate(value: unknown): value is { __avm1Delegate: true; target: unknown; method: string } {
  return isAvm1Object(value) && value.__avm1Delegate === true && typeof value.method === "string";
}

function isMovieClipLoader(value: unknown): value is Record<string, VarValue | undefined> {
  return isAvm1Object(value) && value.__avm1Type === "MovieClipLoader";
}

function movieClipLoaderListeners(loader: Record<string, VarValue | undefined>): Record<string, VarValue | undefined>[] {
  if (!Array.isArray(loader.listeners)) loader.listeners = [];
  return Array.isArray(loader.listeners) ? loader.listeners.filter(isAvm1Object) : [];
}

function normalizeRuntimeAssetUrl(url: string): string {
  return url.trim().replace(/^\/+/, "");
}

function isImageUrl(url: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/i.test(url.split(/[?#]/, 1)[0] ?? "");
}

function isSwfUrl(url: string): boolean {
  return /\.swf$/i.test(url.split(/[?#]/, 1)[0] ?? "");
}

function isXmlNode(value: unknown): value is Element | Document | Node {
  return typeof Node !== "undefined" && value instanceof Node;
}

function xmlElementFromContext(context: unknown): ParentNode | undefined {
  if (isXmlNode(context)) {
    if (context.nodeType === Node.DOCUMENT_NODE) return context as Document;
    if (context.nodeType === Node.ELEMENT_NODE) return context as Element;
  }
  if (isAvm1Object(context)) {
    const doc = context.document;
    if (isXmlNode(doc) && doc.nodeType === Node.DOCUMENT_NODE) return doc as Document;
    const root = context.documentElement;
    if (isXmlNode(root) && root.nodeType === Node.ELEMENT_NODE) return root as Element;
  }
  return undefined;
}

function selectXmlNodes(context: unknown, path: string): Element[] {
  const parent = xmlElementFromContext(context);
  if (!parent) return [];
  const name = path.trim().replace(/^\/\//, "").replace(/^\.\//, "").split("/").filter(Boolean).pop();
  if (!name || !/^[A-Za-z_][\w.-]*$/.test(name)) return [];
  return Array.from(parent.querySelectorAll(name));
}

function readXmlNodeProperty(node: Node, property: string): VarValue | undefined {
  if (property === "firstChild") {
    const first = node.firstChild;
    return first ? ({ nodeValue: first.nodeValue ?? "" } as Record<string, unknown>) : undefined;
  }
  if (property === "nodeValue") return node.nodeValue ?? "";
  if (property === "attributes" && node instanceof Element) {
    return Object.fromEntries(Array.from(node.attributes).map((attr) => [attr.name, attr.value]));
  }
  if (property === "length" && "length" in node) return Number((node as unknown as { length?: number }).length);
  return undefined;
}

function markOwnedObject(value: VarValue, owner: ClipInstance, property: string) {
  if (!isAvm1Object(value)) return;
  try {
    Object.defineProperty(value, AVM1_OWNER_CLIP, { value: owner, configurable: true });
    Object.defineProperty(value, AVM1_OWNER_PROPERTY, { value: property, configurable: true });
  } catch {
    // Host objects may be non-extensible; ownership is only an async-staleness hint.
  }
}

function isCurrentOwnedObject(value: Record<string, VarValue | undefined>, fallbackOwner: ClipInstance): boolean {
  const owner = (value as Record<string, unknown>)[AVM1_OWNER_CLIP];
  const property = (value as Record<string, unknown>)[AVM1_OWNER_PROPERTY];
  if (!(owner instanceof ClipInstance) || typeof property !== "string") return true;
  if (owner !== fallbackOwner) return true;
  return owner.props[property] === value;
}

function eventListeners(owner: ClipInstance): Record<string, Array<{ target: unknown; method: string }>> {
  const key = "__eventListeners";
  const existing = owner.props[key];
  if (isAvm1Object(existing)) return existing as Record<string, Array<{ target: unknown; method: string }>>;
  const listeners: Record<string, Array<{ target: unknown; method: string }>> = {};
  owner.props[key] = listeners;
  return listeners;
}

function movieClipEventName(event: ButtonEvent): string {
  switch (event) {
    case "rollOver": return "rollover";
    case "rollOut": return "rollout";
    case "press": return "press";
    case "release": return "release";
    case "releaseOutside": return "releaseoutside";
  }
}

function directMovieClipHandlerName(event: ButtonEvent): string | undefined {
  switch (event) {
    case "rollOver": return "onRollOver";
    case "rollOut": return "onRollOut";
    case "press": return "onPress";
    case "release": return "onRelease";
    case "releaseOutside": return "onReleaseOutside";
  }
}

function splitTopLevelOperator(expr: string, op: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let last = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (quote) {
      if (c === quote && expr[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && expr.startsWith(op, i)) {
      out.push(expr.slice(last, i).trim());
      last = i + op.length;
      i += op.length - 1;
    }
  }
  out.push(expr.slice(last).trim());
  return out.filter(Boolean);
}

function splitTopLevelWordOperator(expr: string, op: string): string[] {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (quote) {
      if (c === quote && expr[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && expr.slice(i, i + op.length) === op) {
      const before = expr[i - 1] ?? " ";
      const after = expr[i + op.length] ?? " ";
      if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) return [expr.slice(0, i).trim(), expr.slice(i + op.length).trim()];
    }
  }
  return [expr];
}

function avm1Typeof(value: VarValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null) return "object";
  if (Array.isArray(value)) return "object";
  if (value instanceof ClipInstance) return "movieclip";
  return typeof value;
}

function avm1InstanceOf(value: VarValue | undefined, classNameRaw: string): boolean {
  const className = classNameRaw.trim().replace(/^_global\./, "");
  if (className === "Array") return Array.isArray(value);
  if (className === "MovieClip") return value instanceof ClipInstance;
  if (className === "Object") return typeof value === "object" && value !== null;
  if (!isAvm1Object(value)) return false;
  return String(value.__avm1Class ?? "").split(".").pop() === className;
}

function matchingParenRuntime(text: string): number {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
