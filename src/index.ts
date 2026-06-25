/**
 * Public library entry for the Windows XP Tour player.
 *
 * Embeds the decompiled GSAP tour player into a host-provided container.
 * The host serves the converted scene assets (the `generated/` tree produced by
 * the conversion scripts) at `assetsBaseUrl` and gets back a small handle to
 * drive playback. GSAP is a peer dependency.
 *
 *   import { createTourPlayer } from "windows-xp-tour-gsap";
 *
 *   const tour = await createTourPlayer(containerEl, {
 *     assetsBaseUrl: "/apps/xp-tour/gsap",
 *     autoplay: true,
 *   });
 *   // …later
 *   tour.destroy();
 */
import "./player.css";
import { PlayerController } from "./app/PlayerController";
import type {
  PlayerLoadErrorEvent,
  PlayerLoadEvent,
  PlayerLoadLifecycleCallbacks,
  TourButtonEvent,
  TourNavigation,
} from "./app/PlayerController";
import { clearTimelineCache, loadTimeline } from "./data/TimelineLoader";
import { sceneNameFromSwf } from "./data/scenes";
import type { AssetTimeline } from "./data/timelineTypes";
import { setArchiveUrl, setAssetsBaseUrl, setAssetSource, type AssetSource } from "./data/packedAssets.ts";

export interface DecompiledPlayerAssetOptions {
  /** Where the converted `generated/` (and `generated-packed/`) assets are served. Default "" (origin root). */
  assetsBaseUrl?: string;
  /**
   * How assets are loaded:
   * - "files" (default): loose files under `${assetsBaseUrl}/generated/`.
   * - "bundle": one gzipped JSON of timeline+shapes per scene (media still loose).
   * - "archive": ONE file for the whole tour, scenes read on demand via HTTP Range.
   * - "scene-pack": one self-contained file per scene under `generated-packs/`.
   */
  assetSource?: AssetSource;
  /** For assetSource "archive": URL of the single archive. Default `${assetsBaseUrl}/xp-tour.pack`. */
  archiveUrl?: string;
}

export interface PlayerRuntimeOptions {
  /** Begin playing immediately. Default true. */
  autoplay?: boolean;
  /** Enable verbose segment-flash tracing in the console. Default false. */
  debug?: boolean;
  /** Per-frame callback for the root level (frame index, playing, current frame label). */
  onFrame?: (frame: number, playing: boolean, label: string) => void;
  /** Notified on every button interaction, including buttons the conversion left
   *  unbound. Return `true` to suppress the player's own handling so the host fully
   *  owns the response (e.g. wire "Skip Intro" or an end-of-tour button to exit). */
  onButton?: (event: TourButtonEvent) => boolean | void;
  /** Notified when the tour navigates between scenes/levels (loadMovie/unloadMovie),
   *  so the host can follow progress (e.g. detect the final segment / tour end). */
  onNavigate?: (nav: TourNavigation) => void;
  /** Notified when the movie issues an AVM1 `fscommand(command, args)`. The original
   *  tour's quit button is `fscommand("quit")`; map it to your own response (e.g. close
   *  the tour). Any embedder gets a working quit button with no per-button wiring. */
  onFsCommand?: (command: string, args: string) => void;
  /** Notified when AVM1 asks to open or navigate to a URL. */
  onGetURL?: (url: string, target?: string) => void;
}

export type DecompiledPlayerLoadEvent = PlayerLoadEvent;
export type DecompiledPlayerLoadErrorEvent = PlayerLoadErrorEvent;
export type DecompiledPlayerLoadLifecycleCallbacks = PlayerLoadLifecycleCallbacks;

export type DecompiledPlayerRuntimeOptions = PlayerRuntimeOptions & DecompiledPlayerLoadLifecycleCallbacks;

export type DecompiledPlayerOptions = DecompiledPlayerAssetOptions & DecompiledPlayerRuntimeOptions & (
  | {
      /** Entry SWF to load from the configured generated assets, e.g. "intro.swf". */
      scene: string;
      timeline?: never;
      swf?: never;
    }
  | {
      /** Already-loaded timeline data to play without fetching the entry timeline. */
      timeline: AssetTimeline;
      /** Optional SWF name used for level identity and self-load guards. Defaults to `${timeline.scene}.swf`. */
      swf?: string;
      scene?: never;
    }
);

export interface TourPlayerOptions extends DecompiledPlayerAssetOptions, PlayerRuntimeOptions, DecompiledPlayerLoadLifecycleCallbacks {
  /** Entry SWF. Default "A-tour.swf" — the Tour Shell that drives the full guided tour. */
  scene?: string;
}

/** Handle returned by {@link createDecompiledPlayer} for driving playback. */
export interface DecompiledPlayer {
  play(): void;
  pause(): void;
  toggle(): void;
  restart(): void;
  seek(frame: number): void;
  readonly frameCount: number;
  readonly currentFrame: number;
  readonly isPlaying: boolean;
  /** Tear down the player, its levels, audio, and DOM. */
  destroy(): void;
}

/** Handle returned by {@link createTourPlayer} for driving playback. */
export interface TourPlayer extends DecompiledPlayer {}

/**
 * Create and (optionally) start a tour player inside `container`.
 * Resolves once the entry scene's timeline has loaded.
 */
export async function createTourPlayer(
  container: HTMLElement,
  options: TourPlayerOptions = {},
): Promise<TourPlayer> {
  const {
    assetsBaseUrl = "",
    assetSource = "files",
    archiveUrl,
    scene = "A-tour.swf",
    autoplay = true,
    debug = false,
    onFrame,
    onButton,
    onNavigate,
    onFsCommand,
    onGetURL,
    onLoadStart,
    onLoadComplete,
    onLoadError,
  } = options;

  configureAssets({ assetsBaseUrl, assetSource, archiveUrl });

  const swf = swfForScene(scene);
  const initialScene = sceneNameFromSwf(scene);
  onLoadStart?.({ source: "initial", level: 0, swf, scene: initialScene });

  let timeline: AssetTimeline;
  try {
    const loaded = await loadTimeline(scene);
    if (!loaded) throw new Error(`mmtour: failed to load tour scene "${scene}" from "${assetsBaseUrl || "/"}"`);
    timeline = loaded;
  } catch (error) {
    onLoadError?.({ source: "initial", level: 0, swf, scene: initialScene, error });
    throw error;
  }

  const controller = new PlayerController(container, { debug, onFrame, onButton, onNavigate, onFsCommand, onGetURL, onLoadStart, onLoadComplete, onLoadError });
  controller.activate(timeline, swf);
  onLoadComplete?.({ source: "initial", level: 0, swf, scene: timeline.scene, timeline });
  if (autoplay) controller.play();

  return playerHandle(controller);
}

/**
 * Create and (optionally) start the data-driven Decompiled Player inside `container`.
 *
 * Unlike {@link createTourPlayer}, this generic API has no tour-shell default:
 * pass either a `scene` SWF to load from generated assets or an already-loaded
 * `timeline`.
 */
export async function createDecompiledPlayer(
  container: HTMLElement,
  options: DecompiledPlayerOptions,
): Promise<DecompiledPlayer> {
  const {
    assetsBaseUrl = "",
    assetSource = "files",
    archiveUrl,
    autoplay = true,
    debug = false,
    onFrame,
    onButton,
    onNavigate,
    onFsCommand,
    onGetURL,
    onLoadStart,
    onLoadComplete,
    onLoadError,
  } = options;

  configureAssets({ assetsBaseUrl, assetSource, archiveUrl });

  const timelineInput = "timeline" in options ? options.timeline : undefined;
  const sceneInput = "scene" in options ? options.scene : undefined;
  let sceneToLoad: string | undefined;
  let swf: string;
  let initialScene: string;
  if (timelineInput) {
    swf = swfForTimeline(timelineInput, options.swf);
    initialScene = timelineInput.scene;
  } else {
    if (!sceneInput) throw new Error("mmtour: createDecompiledPlayer requires either a scene or a timeline");
    sceneToLoad = sceneInput;
    swf = swfForScene(sceneInput);
    initialScene = sceneNameFromSwf(sceneInput);
  }
  onLoadStart?.({ source: "initial", level: 0, swf, scene: initialScene });

  let timeline: AssetTimeline;
  try {
    if (timelineInput) {
      timeline = timelineInput;
    } else {
      if (!sceneToLoad) throw new Error("mmtour: createDecompiledPlayer requires either a scene or a timeline");
      const loaded = await loadTimeline(sceneToLoad);
      if (!loaded) throw new Error(`mmtour: failed to load scene "${sceneToLoad}" from "${assetsBaseUrl || "/"}"`);
      timeline = loaded;
    }
  } catch (error) {
    onLoadError?.({ source: "initial", level: 0, swf, scene: initialScene, error });
    throw error;
  }

  const controller = new PlayerController(container, {
    debug,
    onFrame,
    onButton,
    onNavigate,
    onFsCommand,
    onGetURL,
    onLoadStart,
    onLoadComplete,
    onLoadError,
  });
  controller.activate(timeline, swf);
  onLoadComplete?.({ source: "initial", level: 0, swf, scene: timeline.scene, timeline });
  if (autoplay) controller.play();

  return playerHandle(controller);
}

function configureAssets(options: Required<Pick<DecompiledPlayerAssetOptions, "assetsBaseUrl" | "assetSource">> & Pick<DecompiledPlayerAssetOptions, "archiveUrl">) {
  const { assetsBaseUrl, assetSource, archiveUrl } = options;
  setAssetsBaseUrl(assetsBaseUrl);
  setAssetSource(assetSource);
  if (assetSource === "archive") {
    setArchiveUrl(archiveUrl ?? `${assetsBaseUrl.replace(/\/+$/, "")}/xp-tour.pack`);
  }
  clearTimelineCache();
}

function swfForTimeline(timeline: AssetTimeline, swf?: string): string {
  if (swf) return swf;
  return swfForScene(timeline.scene);
}

function swfForScene(scene: string): string {
  return /\.swf$/i.test(scene) ? scene : `${scene}.swf`;
}

function playerHandle(controller: PlayerController): DecompiledPlayer {
  return {
    play: () => controller.play(),
    pause: () => controller.pause(),
    toggle: () => controller.toggle(),
    restart: () => controller.restart(),
    seek: (frame: number) => controller.seekRootFrame(frame),
    get frameCount() {
      return controller.frameCount;
    },
    get currentFrame() {
      return controller.currentFrame;
    },
    get isPlaying() {
      return controller.isPlaying;
    },
    destroy: () => controller.deactivate(),
  };
}

// Lower-level building blocks, for hosts that need more control than
// createTourPlayer offers (custom level handling, asset source switching, etc.).
export { PlayerController } from "./app/PlayerController";
export type {
  PlayerControllerOptions,
  PlayerLoadEvent,
  PlayerLoadErrorEvent,
  PlayerLoadLifecycleCallbacks,
  PlayerLoadSource,
  TourButtonEvent,
  TourButtonAction,
  TourNavigation,
} from "./app/PlayerController";
export { setAssetsBaseUrl, getAssetsBaseUrl, setAssetSource, getAssetSource, setArchiveUrl } from "./data/packedAssets.ts";
export type { AssetSource } from "./data/packedAssets.ts";
export { loadTimeline } from "./data/TimelineLoader";
export type { AssetTimeline } from "./data/timelineTypes";
export { scenes, sceneNameFromSwf } from "./data/scenes";
export type { TourScene } from "./data/scenes";
