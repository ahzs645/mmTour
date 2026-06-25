// Shape of the decompiled timeline data emitted by scripts/build-asset-timeline.mjs.
// The runtime plays purely from these artifacts (SVG/PNG/TTF/MP3 + JSON) under
// public/generated/<scene>/ — no .swf is parsed at runtime.

export type Matrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
};

export type Origin = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ColorTransform = {
  /** Red/green/blue/alpha multipliers, normalized from SWF terms where 1 is identity. */
  rm?: number;
  gm?: number;
  bm?: number;
  am?: number;
  /** Red/green/blue/alpha additive terms, normalized to channel units where 0 is identity. */
  ra?: number;
  ga?: number;
  ba?: number;
  aa?: number;
};

export type BlendMode =
  | "normal"
  | "layer"
  | "multiply"
  | "screen"
  | "lighten"
  | "darken"
  | "difference"
  | "add"
  | "subtract"
  | "invert"
  | "alpha"
  | "erase"
  | "overlay"
  | "hardlight"
  | number
  | (string & {});

export type FilterKind =
  | "dropShadow"
  | "blur"
  | "glow"
  | "bevel"
  | "gradientGlow"
  | "convolution"
  | "colorMatrix"
  | "gradientBevel"
  | (string & {});

export type BaseFilterMetadata = {
  kind: FilterKind;
  /** Original SWF/FFDec filter class name, when available. */
  className?: string;
  enabled?: boolean;
  raw?: unknown;
};

export type BlurFilterMetadata = BaseFilterMetadata & {
  kind: "blur";
  blurX?: number;
  blurY?: number;
  passes?: number;
};

export type ColorMatrixFilterMetadata = BaseFilterMetadata & {
  kind: "colorMatrix";
  matrix?: number[];
};

export type DropShadowFilterMetadata = BaseFilterMetadata & {
  kind: "dropShadow" | "glow" | "bevel" | "gradientGlow" | "gradientBevel";
  color?: string;
  alpha?: number;
  blurX?: number;
  blurY?: number;
  angle?: number;
  distance?: number;
  strength?: number;
  inner?: boolean;
  knockout?: boolean;
  compositeSource?: boolean;
  passes?: number;
};

export type FilterMetadata =
  | BlurFilterMetadata
  | ColorMatrixFilterMetadata
  | DropShadowFilterMetadata
  | (BaseFilterMetadata & Record<string, unknown>);

export type ClipActionEvent =
  | "load"
  | "enterFrame"
  | "unload"
  | "mouseMove"
  | "mouseDown"
  | "mouseUp"
  | "keyDown"
  | "keyUp"
  | "data"
  | "initialize"
  | "press"
  | "release"
  | "releaseOutside"
  | "rollOver"
  | "rollOut"
  | "dragOver"
  | "dragOut"
  | "construct"
  | (string & {});

export type ClipActionMetadata = {
  events?: ClipActionEvent[];
  eventFlags?: number;
  keyCode?: number;
  source?: string;
  actions?: unknown[];
  raw?: unknown;
};

export type PlaceObjectRenderMetadata = {
  visible?: boolean;
  blendMode?: BlendMode;
  filters?: FilterMetadata[];
  cacheAsBitmap?: boolean;
  className?: string;
  clipActions?: ClipActionMetadata[];
};

export type AssetKind = "shape" | "sprite" | "image" | "text" | "button" | "font" | "sound";

export type ButtonState = { src: string; origin: Origin };

export type TimelineAsset = {
  id: number;
  kind: AssetKind;
  /** ExportAssets linkage names, used by AVM1 attachMovie(linkageName, ...). */
  linkageNames?: string[];
  src?: string;
  /** Embedded font metadata, when this asset is a font. */
  fontName?: string;
  fontLoadable?: boolean;
  byteLength?: number;
  /** Baked per-frame SVGs for a sprite symbol, one entry per internal sprite frame. */
  frames?: string[];
  /**
   * Nested display-list timeline for a sprite symbol: the placed child instances
   * per internal frame. Preserves the MovieClip nesting (vs the baked `frames`),
   * enabling true nested playheads and _parent/_root navigation in the runtime.
   */
  timeline?: TimelineFrame[];
  /** Button up/over/down/hit state artwork. */
  states?: Partial<Record<"up" | "over" | "down" | "hit" | "hittest", ButtonState>>;
  /** This sprite's animated content slides outside its own bounds, so its baked frames clip
   *  the moving content — render it from the nested timeline (tree) instead of the baked frame. */
  overflowsBounds?: boolean;
  /** Styling for a text/edit-text field (font, size, color, box, initial content). */
  text?: DynamicText;
  /**
   * Dynamic editText fields embedded in a button's up state, each with the field's
   * button-record placement matrix (relative to the button registration). FFDec bakes
   * these at the field registration (ignoring the bounds offset) and leaves the
   * composited sprite frame's button empty, so the runtime overlays the live
   * loadVariables() value here using the field's own bounds (e.g. the nav "Skip Intro").
   */
  textFields?: { id: number; matrix: Matrix }[];
  origin: Origin;
};

export type PlacedInstance = {
  depth: number;
  characterId: number;
  /** Root frame on which this instance was first placed. */
  placedFrame: number;
  matrix: Matrix;
  opacity: number;
  name: string;
  clipDepth?: number;
  colorTransform?: ColorTransform;
} & PlaceObjectRenderMetadata;

export type TimelineFrame = {
  index: number;
  label?: string;
  instances: PlacedInstance[];
};

// --- control-flow data (already exported under timeline.control) ---------

export type ActionCommand =
  | "stop"
  | "play"
  | "gotoAndPlay"
  | "gotoAndStop"
  | "doRelease"
  | "loadMovieNum"
  | "loadMovie"
  | "unloadMovieNum"
  | "unloadMovie"
  | "loadVariables"
  | "playVO"
  | "markSndSegment"
  | "attachSound"
  | "stopSound"
  | "setVolume"
  | "fsCommand"
  | "callFunctions"
  | "setVariable";

export type FunctionCall = {
  target: string;
  functionName: string;
  arguments: string;
};

export type ExitNavigation = {
  variable: string;
  value: string;
  swf: string;
  exitLabel?: string;
  exitFrame: number;
  level?: number;
};

/** One statement of a parsed AVM1 function body, guarded by its if/else chain. */
export type BodyStatement =
  | { kind: "assign"; target: string; value?: string | number | boolean; rawValue: string; branchCondition?: string }
  | { kind: "call"; target?: string; functionName: string; arguments?: string; branchCondition?: string };

/** A user-defined AVM1 function as extracted (definedFunctions entry). */
export type DefinedFunction = {
  functionName: string;
  parameters?: string[];
  parameterRegisters?: { name: string; register?: number }[];
  registerCount?: number;
  flags?: number;
  bytecodeName?: string;
  assignmentTarget?: string;
  scope?: "root" | "sprite" | string;
  spriteId?: number;
  assignments?: { target: string; value?: unknown; rawValue?: string }[];
  body?: BodyStatement[];
  /** Raw AVM1 bytecode of the function body (DefineFunction(2) actions), for the
   *  runtime VM that interprets data-driven AS2 apps. Emitted by the in-browser
   *  compile only; the lossy `body`/`assignments` above remain for the legacy path. */
  bytecode?: import("./avm1Bytecode.ts").Avm1Op[];
  /** Browser bytecode extraction can recover executable command actions directly from the function body. */
  actions?: ControlAction[];
  /** Inner clip/function calls (e.g. a sprite's over()/out() → self gotoAndPlay frames). */
  calls?: FunctionCall[];
  source?: string;
};

export type ControlAction = {
  target?: string;
  command?: ActionCommand;
  frame?: number;
  frameExpression?: string;
  label?: string;
  swf?: string;
  /** Source text file for loadVariables() actions; target remains the destination clip/scope. */
  variableSource?: string;
  level?: number;
  /** Every movie a button handler loads, in source order, when it loads more than one — e.g. a
   *  "restart the whole tour" button that loads segment1 into the content level AND an MS-logo
   *  overlay into a higher level. Single-load handlers omit this and use `swf`/`level` above. */
  loads?: { swf: string; level?: number }[];
  /** Force a fresh (re)load of the target level even if that SWF is already loaded — a nav
   *  section click mirrors the SWF's `doRelease` (unload + load), so re-clicking replays it. */
  reload?: boolean;
  functionCalls?: FunctionCall[];
  /** Simple `flag = value;` assignments in a button handler (e.g. a section icon's `isActive = 1;`),
   *  applied to the owning clip's scope when the event fires. */
  assignments?: { target: string; value?: unknown; rawValue?: string }[];
  /** Label/frame metadata for button targets that jump to a nested timeline section. */
  nestedSection?: { label: string; frame: number };
  /** Summary of a deferred button navigation path: set a variable, play an exit animation, then load a SWF. */
  exitNavigation?: ExitNavigation;
  /** Name of the AVM1 function this action belongs to (when context is "function"). */
  functionName?: string;
  /** "timeline" actions run on frame entry; "function"/"branch" are conditional. */
  executionContext?: "timeline" | "function" | "branch" | string;
  supported?: boolean;
  source?: string;
  functionBranchCondition?: string;
  /** if/else guard for a "branch"-context inline frame action; "else" pairs with the preceding arm. */
  branchCondition?: string;
  /** setVariable fields: a frame-script `target = value` assignment. */
  value?: string | number | boolean;
  rawValue?: string;
  /** Sound action fields (attachSound/playVO/stopSound). */
  sound?: string;
  /** Marker id for voice-over sub-segments such as TOUR74b. */
  segment?: string;
  soundSrc?: string;
  soundDurationMs?: number;
  soundRole?: "music" | "vo" | string;
  /** Resolved base sound when a marker aliases a segment id to its parent sound. */
  resolvedSound?: string;
  /** Raw argument string for metadata-only function calls. */
  arguments?: string;
  /** Non-executable metadata inferred from a function/sound-object call such as playVO("TOUR21"). */
  soundAction?: {
    command: "playVO" | "markSndSegment" | "attachSound" | "stopSound";
    target?: string;
    sound?: string;
    soundSrc?: string;
    soundDurationMs?: number;
    soundRole?: "music" | "vo" | string;
    ramp?: string;
    segment?: string;
    resolvedSound?: string;
    arguments?: string;
  };
};

/** One frame's extracted actions. `frame` is a 0-based root frame index. */
export type FrameActionRecord = {
  frame: number;
  source?: string;
  actions: ControlAction[];
};

export type DynamicText = {
  characterId?: number;
  variableName?: string;
  normalizedVariableName?: string;
  text?: string;
  fontHeight: number;
  leading?: number;
  color?: string;
  align?: "left" | "center" | "right" | string;
  multiline?: boolean;
  wordWrap?: boolean;
  html?: boolean;
  fontId?: number;
  /** Text-field box in stage pixels (from the DefineEditText bounds). */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

export type ButtonActionRecord = {
  ownerSpriteIds?: number[];
  release?: ControlAction & { functionCalls?: FunctionCall[] };
  rollOver?: ControlAction;
  rollOut?: ControlAction;
  press?: ControlAction;
};

export type TimelineControl = {
  stopFrames?: number[];
  spriteStopFrames?: Record<string, number[]>;
  spriteLocalDefaults?: Record<string, Record<string, unknown>>;
  frameActions?: FrameActionRecord[];
  spriteActions?: Array<{ spriteId: number; frame: number; source?: string; actions: ControlAction[] }>;
  definedFunctions?: Record<string, DefinedFunction>;
  /** AVM1 Object.registerClass(linkageName, classPath) mappings for class-backed symbols. */
  registeredClasses?: Record<string, string>;
  soundLibrary?: Record<string, unknown>;
  /** Explicit sound/voice timing table recovered from AVM1 arrays such as sndTimeLib.push(["id", ms]). */
  soundTimings?: Record<string, { durationMs: number }>;
  globalDefaults?: Record<string, unknown>;
  nestedSectionTargets?: Record<string, { label: string; frame: number }>;
  dynamicTexts?: Record<string, DynamicText>;
  buttonActions?: Record<string, ButtonActionRecord>;
};

export type AssetTimeline = {
  scene: string;
  source?: string;
  generatedFrom?: string;
  dimensions: { width: number; height: number };
  backgroundColor?: string;
  fps: number;
  frameCount: number;
  duration: number;
  labels?: Record<string, number>;
  entryFrame?: number;
  control?: TimelineControl;
  frameSvgs?: string[];
  /** Root full-frame SVG composites were intentionally omitted for a player-only bundle. */
  frameSvgsOmitted?: boolean;
  /** Baked sprite-frame SVGs were intentionally omitted when nested timelines can render them. */
  bakedSpriteFramesOmitted?: boolean;
  /**
   * Shape/button SVG srcs whose bitmap fills reference external images instead of
   * embedding base64 (Phase 1, docs/generated-size-and-packing.md). For asset sources
   * whose media isn't in memory (files/bundle), the runtime pre-inlines these at load.
   */
  bitmapFillShapeSrcs?: string[];
  assets: Record<string, TimelineAsset>;
  frames: TimelineFrame[];
};
