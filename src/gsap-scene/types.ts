/** Shared types for the GSAP scene format produced by build-gsap-scene.mjs. */

export type SceneAssetKind = "shape" | "sprite" | "image" | "text" | "button" | "font" | "sound";

export interface SceneColorTransform {
  rm?: number;
  gm?: number;
  bm?: number;
  am?: number;
  ra?: number;
  ga?: number;
  ba?: number;
  aa?: number;
}

export interface GsapSceneKeyframe {
  frame: number;
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
  opacity: number;
  clipDepth?: number;
  colorTransform?: SceneColorTransform;
}

export interface GsapSceneCell {
  frame: number;
  src: string;
}

export type SceneGotoCommand = "gotoAndPlay" | "gotoAndStop";

export interface SceneRelease {
  command: SceneGotoCommand;
  target: number;
  label?: string;
}

export interface GsapSceneTrack {
  id: string;
  depth: number;
  characterId: number;
  name: string;
  kind: SceneAssetKind;
  origin: { x: number; y: number; width: number; height: number };
  birthFrame: number;
  deathFrame: number;
  birthTime: number;
  deathTime: number;
  src?: string;
  textSrc?: string;
  cells?: GsapSceneCell[];
  release?: SceneRelease;
  keys: GsapSceneKeyframe[];
}

export interface SceneNavAction {
  frame: number;
  command: SceneGotoCommand;
  target: number;
}

export interface GsapSceneControl {
  stopFrames: number[];
  nav: SceneNavAction[];
}

export interface GsapScene {
  scene: string;
  source?: string;
  format: string;
  fps: number;
  frameCount: number;
  duration: number;
  entryFrame: number;
  stage: { width: number; height: number; background: string };
  labels: Record<string, number>;
  control: GsapSceneControl;
  tracks: GsapSceneTrack[];
}

/** 2D affine matrix as used throughout the scene format. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

/** Live runtime state for a single track instance. */
export interface RuntimeTrack {
  track: GsapSceneTrack;
  element: HTMLDivElement;
  media: HTMLElement;
  state: Affine & { opacity: number };
  lastCellSrc: string | null;
  visible: boolean | null;
  activeColorKey: GsapSceneKeyframe | null;
  lastColorSignature: string | null;
  lastClipSignature: string | null;
}
