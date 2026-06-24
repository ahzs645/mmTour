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
import type { TourButtonEvent, TourNavigation } from "./app/PlayerController";
import { clearTimelineCache, loadTimeline } from "./data/TimelineLoader";
import { setArchiveUrl, setAssetsBaseUrl, setAssetSource, type AssetSource } from "./data/packedAssets.ts";

export interface TourPlayerOptions {
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
  /** Entry SWF. Default "A-tour.swf" — the Tour Shell that drives the full guided tour. */
  scene?: string;
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
}

/** Handle returned by {@link createTourPlayer} for driving playback. */
export interface TourPlayer {
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
  } = options;

  setAssetsBaseUrl(assetsBaseUrl);
  setAssetSource(assetSource);
  if (assetSource === "archive") {
    setArchiveUrl(archiveUrl ?? `${assetsBaseUrl.replace(/\/+$/, "")}/xp-tour.pack`);
  }
  clearTimelineCache();

  const timeline = await loadTimeline(scene);
  if (!timeline) {
    throw new Error(`mmtour: failed to load tour scene "${scene}" from "${assetsBaseUrl || "/"}"`);
  }

  const controller = new PlayerController(container, { debug, onFrame, onButton, onNavigate });
  controller.activate(timeline, scene);
  if (autoplay) controller.play();

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
export type { PlayerControllerOptions, TourButtonEvent, TourButtonAction, TourNavigation } from "./app/PlayerController";
export { setAssetsBaseUrl, getAssetsBaseUrl, setAssetSource, getAssetSource, setArchiveUrl } from "./data/packedAssets.ts";
export type { AssetSource } from "./data/packedAssets.ts";
export { loadTimeline } from "./data/TimelineLoader";
export { scenes, sceneNameFromSwf } from "./data/scenes";
export type { TourScene } from "./data/scenes";
