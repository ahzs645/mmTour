// Shared mutable state + singletons for the frame/direct comparison render modes.
// main.ts and the per-mode modules read/write the same `state` object and the
// shared collections/singletons exported here (the Decompiled Player owns its own
// state inside PlayerController; this is only the legacy comparison orchestration).

import { gsap } from "gsap";
import { scenes, type TourScene } from "../data/scenes";
import { GsapDisplayListRenderer } from "../gsap-display-list-renderer";
import { GsapSwfRenderer } from "../engine/GsapSwfRenderer";
import { PlayerController } from "./PlayerController";
import { frameScrubber, gsapDisplayLayer, playBtn, playerLayer, renderModeSelect, status } from "./dom";
import type {
  AssetTimeline,
  ControlAction,
  RenderedInstance,
  RuffleElement,
  RuntimeGlobalValue,
} from "./frameModeTypes";

export interface AppState {
  activeScene: TourScene;
  rufflePlayer: RuffleElement | null;
  timeline: gsap.core.Timeline | null;
  activeAssetTimeline: AssetTimeline | null;
  directSwfRenderer: GsapSwfRenderer | null;
  directSwfScene: string;
  directSwfLoad: Promise<GsapSwfRenderer | null> | null;
  renderedInstances: Map<number, RenderedInstance>;
  activeDebugTab: "stage" | "labels" | "actions";
  highlightedDepth: number | null;
  isGsapPlaying: boolean;
  isAwaitingSelection: boolean;
  isNestedSectionActive: boolean;
  frameSvgRequest: number;
  assetTimelineVersion: number;
  awaitingLoopTimer: number;
  awaitingLoopTick: number;
  hoverSpriteTimer: number;
  hoverSpriteElement: HTMLDivElement | null;
  buttonStateElement: SVGImageElement | null;
  currentVoiceover: HTMLAudioElement | null;
  currentMusic: HTMLAudioElement | null;
  lastSoundFrameKey: string;
  lastFrameFunctionCallKey: string;
  isRunningExtractedAction: boolean;
}

export const state: AppState = {
  activeScene: scenes.find((scene) => scene.swf === "segment4.swf") ?? scenes[0],
  rufflePlayer: null,
  timeline: null,
  activeAssetTimeline: null,
  directSwfRenderer: null,
  directSwfScene: "",
  directSwfLoad: null,
  renderedInstances: new Map<number, RenderedInstance>(),
  activeDebugTab: "stage",
  highlightedDepth: null,
  isGsapPlaying: false,
  isAwaitingSelection: false,
  isNestedSectionActive: false,
  frameSvgRequest: 0,
  assetTimelineVersion: 0,
  awaitingLoopTimer: 0,
  awaitingLoopTick: 0,
  hoverSpriteTimer: 0,
  hoverSpriteElement: null,
  buttonStateElement: null,
  currentVoiceover: null,
  currentMusic: null,
  lastSoundFrameKey: "",
  lastFrameFunctionCallKey: "",
  isRunningExtractedAction: false,
};

export const playedSpriteSoundKeys = new Set<string>();
export const runtimeGlobals: Record<string, RuntimeGlobalValue> = {};
export const loadedLevelSwfs: Record<number, string> = { 4: state.activeScene.swf };
export const hiddenHoverSources: SVGGraphicsElement[] = [];
export const hiddenAwaitingSources: SVGGraphicsElement[] = [];
export const frameSvgCache = new Map<string, string>();
export const assetTimelineCache = new Map<string, AssetTimeline>();
export const loadedFontFaceKeys = new Set<string>();
export const externalLevels = new Map<number, {
  swf: string;
  frame: number;
  element: HTMLDivElement;
  image: HTMLImageElement;
  timeline?: AssetTimeline;
}>();
export const pendingExternalLevelCalls = new Map<number, NonNullable<ControlAction["functionCalls"]>>();
export const gsapDisplayRenderer = new GsapDisplayListRenderer(gsapDisplayLayer);
export const playerController = new PlayerController(playerLayer, {
  onFrame: (frame, playing, label) => {
    if (renderModeSelect.value !== "player") return;
    frameScrubber.value = String(frame);
    playBtn.textContent = playing ? "Pause" : "Play GSAP";
    status.textContent = `${playing ? "Playing" : "Paused"} decompiled frame ${frame + 1}${label ? ` (${label})` : ""}`;
  },
});
