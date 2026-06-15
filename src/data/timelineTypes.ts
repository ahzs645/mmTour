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
  /** Button up/over/down/hit state artwork. */
  states?: Partial<Record<"up" | "over" | "down" | "hit", ButtonState>>;
  /** Styling for a text/edit-text field (font, size, color, box, initial content). */
  text?: DynamicText;
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
  | "loadVariables"
  | "playVO"
  | "markSndSegment"
  | "attachSound"
  | "stopSound"
  | "callFunctions";

export type FunctionCall = {
  target: string;
  functionName: string;
  arguments: string;
};

export type ControlAction = {
  target?: string;
  command?: ActionCommand;
  frame?: number;
  frameExpression?: string;
  label?: string;
  swf?: string;
  level?: number;
  functionCalls?: FunctionCall[];
  /** "timeline" actions run on frame entry; "function"/"branch" are conditional. */
  executionContext?: "timeline" | "function" | "branch" | string;
  supported?: boolean;
  source?: string;
  functionBranchCondition?: string;
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
  assets: Record<string, TimelineAsset>;
  frames: TimelineFrame[];
};
