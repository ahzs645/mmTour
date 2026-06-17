// Internal types for the Direct SWF renderer (GsapSwfRenderer). Split out to keep the
// renderer file focused on behavior.

import type {
  SwfMatrix, SwfColorTransform,
} from "./SwfParser";

export interface DisplayEntry {
  depth: number;
  characterId: number;
  element: HTMLElement;
  matrix: SwfMatrix;
  colorTransform?: SwfColorTransform;
  clipDepth?: number;
  ratio?: number;
  placedAtFrame: number;
  instanceName?: string;
  spritePlayback?: SpritePlaybackState;
}

export interface GsapSwfRendererOptions {
  hiddenCharacterIds?: number[];
}

export interface SpritePlaybackState {
  startFrame: number;
  startedAtTick: number;
  isPlaying: boolean;
}

export interface TimelineState {
  currentFrame: number;
  isPlaying: boolean;
}

export interface DisplayBinding {
  depth: number;
  characterId: number;
  instanceName?: string;
  ratio?: number;
}

export interface Avm1Object {
  [key: string]: Avm1Value;
}

export interface MovieTimelineState extends TimelineState {
  globals: Map<string, Avm1Value>;
  playbackOverridesByName: Map<string, SpritePlaybackState>;
  timeMarkTick: number | null;
}

export interface Avm1FunctionDef {
  name: string;
  params: string[];
  body: Uint8Array;
  constantPool: string[];
}

export type Avm1Primitive = string | number | boolean | null;
export type Avm1Value = Avm1Primitive | DisplayEntry | DisplayBinding | Avm1Object | Avm1FunctionDef | undefined;
