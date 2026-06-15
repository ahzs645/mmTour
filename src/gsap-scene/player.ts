/**
 * GsapScenePlayer
 *
 * Runtime for the converted `gsap-scene.json` format. Symbol motion is driven
 * by real GSAP tweens (see tweens.ts); discrete state (visibility, sprite
 * cells, color transforms, masks) is resolved per tick so scrubbing stays
 * correct; and timeline control flow (stops, gotos, button releases) retimes
 * the GSAP timeline.
 *
 * Composed from focused modules: media, tweens, color-transform, masking,
 * control-flow.
 */

import { gsap } from "gsap";
import type { GsapScene, GsapSceneKeyframe, GsapSceneTrack, RuntimeTrack, SceneGotoCommand } from "./types";
import { createTrackElement } from "./media";
import { applyState, buildTrackTweens, stateOf } from "./tweens";
import { ColorTransformManager } from "./color-transform";
import { MaskManager } from "./masking";
import { ControlFlow } from "./control-flow";

export class GsapScenePlayer {
  private layer: HTMLDivElement;
  private scene: GsapScene | null = null;
  private timeline: gsap.core.Timeline | null = null;
  private runtimeTracks: RuntimeTrack[] = [];
  private control: ControlFlow | null = null;
  private colorManager: ColorTransformManager | null = null;
  private maskManager = new MaskManager();
  private lastFrame = -1;
  private lastControlFrame: number | null = null;

  onFrameChange?: (frame: number) => void;
  onPlaybackChange?: (isPlaying: boolean) => void;
  /** Invoked when a goto targets a frame outside this scene (reserved for shell wiring). */
  onExternalNavigation?: (target: number) => void;

  constructor(layer: HTMLDivElement) {
    this.layer = layer;
  }

  get loadedScene(): GsapScene | null { return this.scene; }
  get totalFrames(): number { return this.scene?.frameCount ?? 0; }
  get fps(): number { return this.scene?.fps ?? 15; }
  get currentFrame(): number { return Math.max(0, this.lastFrame); }
  get isPlaying(): boolean { return Boolean(this.timeline?.isActive()); }

  async load(sceneUrl: string): Promise<GsapScene | null> {
    const response = await fetch(sceneUrl);
    if (!response.ok) return null;
    let scene: GsapScene;
    try {
      // A dev-server SPA fallback can return index.html for a missing scene;
      // parsing fails (or the format marker is absent), so treat it as missing.
      scene = (await response.json()) as GsapScene;
    } catch {
      return null;
    }
    if (!scene || scene.format !== "gsap-scene@1") return null;
    this.build(scene);
    return scene;
  }

  build(scene: GsapScene) {
    this.destroy();
    this.scene = scene;
    this.control = new ControlFlow(scene.control, scene.labels);
    this.layer.replaceChildren();
    this.layer.style.position = "absolute";
    this.layer.style.inset = "0";
    this.layer.style.background = scene.stage.background;
    this.colorManager = new ColorTransformManager(this.layer);

    const master = gsap.timeline({
      paused: true,
      onUpdate: () => this.handleTick(),
      onComplete: () => this.onPlaybackChange?.(false),
    });
    // Reserve total duration so scrubbing past the last tween still works.
    master.to({}, { duration: scene.frameCount / scene.fps });

    for (const track of scene.tracks) {
      this.runtimeTracks.push(this.buildTrack(track, master));
    }

    this.timeline = master;
    this.seekToFrame(scene.entryFrame ?? 0);
  }

  private buildTrack(track: GsapSceneTrack, master: gsap.core.Timeline): RuntimeTrack {
    const { element, media } = createTrackElement(track);
    this.layer.append(element);

    const first = track.keys[0];
    const runtime: RuntimeTrack = {
      track,
      element,
      media,
      state: { ...stateOf(first) },
      lastCellSrc: null,
      visible: null,
      activeColorKey: null,
      lastColorSignature: null,
      lastClipSignature: null,
    };

    buildTrackTweens(master, runtime, this.fps);

    if (track.release) {
      element.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.executeGoto(track.release!.command, track.release!.target);
      });
    }

    return runtime;
  }

  // ===== Per-tick state =====

  private handleTick() {
    if (!this.scene || !this.timeline) return;
    const frame = Math.max(
      0,
      Math.min(this.scene.frameCount - 1, Math.round(this.timeline.time() * this.scene.fps)),
    );

    for (const runtime of this.runtimeTracks) {
      this.updateDiscreteState(runtime, frame);
    }
    this.maskManager.update(this.runtimeTracks, (rt) => this.activeKey(rt.track, frame)?.clipDepth);

    if (this.timeline.isActive() && frame !== this.lastControlFrame) {
      this.lastControlFrame = frame;
      this.processControl(frame);
    }

    if (frame !== this.lastFrame) {
      this.lastFrame = frame;
      this.onFrameChange?.(frame);
    }
  }

  private updateDiscreteState(runtime: RuntimeTrack, frame: number) {
    const { track } = runtime;
    const visible = frame >= track.birthFrame && frame < track.deathFrame;
    if (visible !== runtime.visible) {
      runtime.visible = visible;
      runtime.element.style.display = visible ? "block" : "none";
    }
    if (!visible) return;

    const key = this.activeKey(track, frame);
    this.colorManager?.apply(runtime, key?.colorTransform);

    if (track.cells && runtime.media instanceof HTMLImageElement) {
      let src = track.cells[0].src;
      for (const cell of track.cells) {
        if (cell.frame <= frame) src = cell.src;
        else break;
      }
      if (src !== runtime.lastCellSrc) {
        runtime.lastCellSrc = src;
        runtime.media.src = `/${src}`;
        runtime.media.dataset.src = src;
      }
    }
  }

  private activeKey(track: GsapSceneTrack, frame: number): GsapSceneKeyframe | null {
    let active: GsapSceneKeyframe | null = null;
    for (const key of track.keys) {
      if (key.frame <= frame) active = key;
      else break;
    }
    return active ?? track.keys[0] ?? null;
  }

  private processControl(frame: number) {
    if (!this.control) return;
    const nav = this.control.navAt(frame);
    if (nav) {
      queueMicrotask(() => this.executeGoto(nav.command, nav.target));
      return;
    }
    if (this.control.isStop(frame)) {
      this.pause();
    }
  }

  // ===== Navigation =====

  private executeGoto(command: SceneGotoCommand, target: number) {
    if (!this.scene) return;
    if (target < 0 || target >= this.scene.frameCount) {
      this.onExternalNavigation?.(target);
      return;
    }
    this.seekToFrame(target);
    // gotoAndStop always parks; gotoAndPlay parks too if the destination has a
    // stop() so menu frames behave like Flash without overshooting.
    if (command === "gotoAndStop" || this.control?.isStop(target)) {
      this.pause();
    } else {
      this.timeline?.play();
      this.onPlaybackChange?.(true);
    }
  }

  // ===== Playback controls =====

  play() {
    if (!this.timeline) return;
    if (this.lastFrame >= this.totalFrames - 1) this.seekToFrame(0);
    // Step off a stop so the user's Play resumes instead of re-pausing.
    if (this.control?.isStop(this.lastFrame)) {
      this.lastControlFrame = this.lastFrame + 1;
      this.timeline.time((this.lastFrame + 1) / this.fps, false);
    }
    this.timeline.play();
    this.onPlaybackChange?.(true);
  }

  pause() {
    this.timeline?.pause();
    this.onPlaybackChange?.(false);
  }

  togglePlay() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  seekToFrame(frame: number) {
    if (!this.timeline || !this.scene) return;
    const clamped = Math.max(0, Math.min(this.scene.frameCount - 1, frame));
    this.lastControlFrame = null;
    this.timeline.time(clamped / this.fps, false);
    this.handleTick();
  }

  restart() {
    this.seekToFrame(0);
    this.pause();
  }

  destroy() {
    this.timeline?.kill();
    this.timeline = null;
    this.colorManager?.clear();
    this.colorManager = null;
    this.maskManager.reset(this.runtimeTracks);
    this.runtimeTracks = [];
    this.control = null;
    this.scene = null;
    this.lastFrame = -1;
    this.lastControlFrame = null;
    this.layer.replaceChildren();
  }
}
