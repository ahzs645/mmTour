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
  rm?: number;
  gm?: number;
  bm?: number;
  am?: number;
  ra?: number;
  ga?: number;
  ba?: number;
  aa?: number;
};

export type AssetKind = "shape" | "sprite" | "image" | "text" | "button" | "font" | "sound";

export type ButtonState = { src: string; origin: Origin };

export type TimelineAsset = {
  id: number;
  kind: AssetKind;
  src?: string;
  /** Baked per-frame SVGs for a sprite symbol, one entry per internal sprite frame. */
  frames?: string[];
  /**
   * Nested display-list timeline for a sprite symbol: the placed child instances
   * per internal frame. Preserves the MovieClip nesting (vs the baked `frames`),
   * enabling true nested playheads and _parent/_root navigation in the runtime.
   */
  timeline?: TimelineFrame[];
  /** Button up/over/down/hit state artwork. */
  states?: Partial<Record<"up" | "over" | "down" | "hit", ButtonState>>;
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
};

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
  | "loadVariables"
  | "playVO"
  | "markSndSegment"
  | "attachSound"
  | "stopSound"
  | "callFunctions"
  | "setVariable";

export type FunctionCall = {
  target: string;
  functionName: string;
  arguments: string;
};

/** One statement of a parsed AVM1 function body, guarded by its if/else chain. */
export type BodyStatement =
  | { kind: "assign"; target: string; value?: string | number | boolean; rawValue: string; branchCondition?: string }
  | { kind: "call"; target?: string; functionName: string; arguments?: string; branchCondition?: string };

/** A user-defined AVM1 function as extracted (definedFunctions entry). */
export type DefinedFunction = {
  functionName: string;
  parameters?: string[];
  scope?: "root" | "sprite" | string;
  spriteId?: number;
  assignments?: { target: string; value?: unknown; rawValue?: string }[];
  body?: BodyStatement[];
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
  soundSrc?: string;
  soundRole?: "music" | "vo" | string;
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
  spriteActions?: Record<string, Record<string, ControlAction[]>>;
  definedFunctions?: Record<string, unknown>;
  soundLibrary?: Record<string, unknown>;
  globalDefaults?: Record<string, unknown>;
  nestedSectionTargets?: Record<string, unknown>;
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
  assets: Record<string, TimelineAsset>;
  frames: TimelineFrame[];
};
