// Timeline + control-flow types for the legacy comparison render modes (the frame/direct
// orchestration in main.ts). These mirror the FFDec-extracted JSON as the comparison modes
// consume it; the data-driven Player uses its own shapes in src/data/timelineTypes.ts.

export type Matrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
};

export type TimelineAsset = {
  id: number;
  kind: "shape" | "sprite" | "image" | "text" | "button" | "font" | "sound";
  src?: string;
  frames?: string[];
  states?: Record<string, { src: string; origin: TimelineAsset["origin"] }>;
  origin: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type TimelineFrame = {
  index: number;
  label: string;
  instances: Array<{
    depth: number;
    characterId: number;
    placedFrame: number;
    matrix: Matrix;
    opacity: number;
    name: string;
    clipDepth?: number;
    colorTransform?: {
      rm?: number;
      gm?: number;
      bm?: number;
      am?: number;
      ra?: number;
      ga?: number;
      ba?: number;
      aa?: number;
    };
  }>;
};

export type ControlAction = {
  target?: string;
  command?: "stop" | "play" | "gotoAndPlay" | "gotoAndStop" | "doRelease" | "loadMovieNum" | "loadVariables" | "playVO" | "markSndSegment" | "attachSound" | "stopSound" | "callFunctions";
  label?: string;
  frame?: number;
  frameExpression?: string;
  level?: string | number;
  swf?: string;
  sound?: string;
  soundSrc?: string;
  soundRole?: "voiceover" | "music";
  segment?: string;
  ramp?: string;
  exitNavigation?: {
    variable: string;
    value: string;
    swf: string;
    exitLabel?: string;
    exitFrame: number;
  };
  functionCalls?: Array<{
    target: string;
    functionName: string;
    arguments?: string;
  }>;
  nestedSection?: {
    label: string;
    frame: number;
  };
  rootFunctionSound?: {
    sound: string;
    soundSrc: string;
    functionName: string;
    arguments?: string;
    sourceFunction: string;
  };
  targetPlacement?: {
    characterId: number;
    matrix: Matrix;
    width?: number;
    height?: number;
  };
  source: string;
  supported?: boolean;
  reason?: string;
  functionName?: string;
  functionBranchCondition?: string;
  branchCondition?: string;
  executionContext?: "timeline" | "function" | "branch";
};

export type RenderedLoopItem = {
  element: HTMLDivElement;
  image: HTMLImageElement;
  asset: TimelineAsset & { frames: string[] };
  instance: TimelineFrame["instances"][number];
  spriteFrame: number;
  stopped: boolean;
};

export type ButtonControl = {
  ownerSpriteIds?: number[];
  release?: ControlAction;
  rollOver?: ControlAction;
  rollOut?: ControlAction;
};

export type ButtonDefinition = {
  id: number;
  states?: {
    up?: ButtonStateRecord[];
    over?: ButtonStateRecord[];
    down?: ButtonStateRecord[];
    hitTest?: ButtonStateRecord[];
  };
  hitAreas?: ButtonStateRecord[];
};

export type ButtonStateRecord = {
  characterId: number;
  depth: number;
  matrix: Matrix;
};

export type DynamicTextControl = {
  characterId: number;
  variableName: string;
  normalizedVariableName: string;
  text: string;
  fontHeight?: number;
  leading?: number;
  color?: string;
  align?: "left" | "center" | "right" | "justify";
  multiline?: boolean;
  wordWrap?: boolean;
  html?: boolean;
};

export type RuntimeGlobalValue = string | number | boolean;
export type SceneEntryTarget = {
  label?: string;
  frame?: number;
  frameExpression?: string;
};

export type AssetTimeline = {
  scene: string;
  source: string;
  dimensions: { width: number; height: number };
  backgroundColor: string;
  fps: number;
  frameCount: number;
  duration: number;
  entryFrame?: number;
  labels?: Record<string, number>;
  control?: {
    stopFrames?: number[];
    spriteStopFrames?: Record<string, number[]>;
    spriteLocalDefaults?: Record<string, Record<string, RuntimeGlobalValue>>;
    frameActions?: Array<{
      frame: number;
      source: string;
      actions: ControlAction[];
    }>;
    spriteActions?: Array<{
      spriteId: number;
      frame: number;
      source: string;
      actions: ControlAction[];
    }>;
    dynamicTexts?: Record<string, DynamicTextControl>;
    buttonActions?: Record<string, ButtonControl>;
    buttonDefinitions?: ButtonDefinition[];
    soundLibrary?: Record<string, { name: string; src: string }>;
    globalDefaults?: Record<string, RuntimeGlobalValue>;
    nestedSectionTargets?: Record<string, { label: string; frame: number }>;
    nestedMovieClips?: Array<{
      spriteId: number;
      labels?: Record<string, number>;
    }>;
    segmentNavigation?: Array<{ swf: string }>;
  };
  frameSvgs?: string[];
  frameSvgsOmitted?: boolean;
  bakedSpriteFramesOmitted?: boolean;
  assets: Record<string, TimelineAsset>;
  frames: TimelineFrame[];
};

export type RenderedInstance = {
  characterId: number;
  element: HTMLDivElement;
  content: HTMLElement;
};

export type RuffleElement = HTMLElement & {
  load?: (config: { url: string }) => Promise<void>;
  ruffle?: () => {
    load: (config: { url: string } | string) => Promise<void>;
  };
};
