/**
 * GsapScenePlayer
 *
 * Runs a converted `gsap-scene.json` (produced by scripts/build-gsap-scene.mjs)
 * as a real GSAP timeline. Each symbol instance becomes a track whose
 * continuous motion (matrix + opacity) is driven by component-wise
 * `gsap.to()` tweens, while discrete state (visibility window and sprite cell
 * source) is resolved per tick so scrubbing stays correct.
 *
 * This is the runtime half of the "convert to a non-SWF format, then run it"
 * pipeline and is meant to replace static SVG frame playback.
 */

import { gsap } from "gsap";

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
  colorTransform?: Record<string, number>;
}

export interface GsapSceneCell {
  frame: number;
  src: string;
}

export interface GsapSceneTrack {
  id: string;
  depth: number;
  characterId: number;
  name: string;
  kind: "shape" | "sprite" | "image" | "text" | "button" | "font" | "sound";
  origin: { x: number; y: number; width: number; height: number };
  birthFrame: number;
  deathFrame: number;
  birthTime: number;
  deathTime: number;
  src?: string;
  textSrc?: string;
  cells?: GsapSceneCell[];
  keys: GsapSceneKeyframe[];
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
  control: { stopFrames: number[] };
  tracks: GsapSceneTrack[];
}

interface RuntimeTrack {
  track: GsapSceneTrack;
  element: HTMLDivElement;
  media: HTMLElement;
  state: { a: number; b: number; c: number; d: number; tx: number; ty: number; opacity: number };
  lastCellSrc: string | null;
  visible: boolean | null;
}

export class GsapScenePlayer {
  private layer: HTMLDivElement;
  private scene: GsapScene | null = null;
  private timeline: gsap.core.Timeline | null = null;
  private runtimeTracks: RuntimeTrack[] = [];
  private stopFrames = new Set<number>();
  private lastFrame = -1;

  /** Fires whenever the visible frame changes. */
  onFrameChange?: (frame: number) => void;
  onPlaybackChange?: (isPlaying: boolean) => void;

  constructor(layer: HTMLDivElement) {
    this.layer = layer;
  }

  get loadedScene(): GsapScene | null {
    return this.scene;
  }

  get totalFrames(): number {
    return this.scene?.frameCount ?? 0;
  }

  get fps(): number {
    return this.scene?.fps ?? 15;
  }

  get currentFrame(): number {
    return Math.max(0, this.lastFrame);
  }

  get isPlaying(): boolean {
    return Boolean(this.timeline?.isActive());
  }

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
    this.stopFrames = new Set(scene.control?.stopFrames ?? []);
    this.layer.replaceChildren();
    this.layer.style.position = "absolute";
    this.layer.style.inset = "0";
    this.layer.style.background = scene.stage.background;

    const master = gsap.timeline({
      paused: true,
      onUpdate: () => this.handleTick(),
      onComplete: () => this.onPlaybackChange?.(false),
    });

    // Reserve total duration so scrubbing past the last tween still works.
    master.to({}, { duration: scene.frameCount / scene.fps });

    for (const track of scene.tracks) {
      this.runtimeTracks.push(this.buildTrack(track, master, scene.fps));
    }

    // Pause the master timeline when playback reaches a scripted stop frame.
    for (const stopFrame of this.stopFrames) {
      master.call(() => this.pause(), undefined, stopFrame / scene.fps);
    }

    this.timeline = master;
    this.seekToFrame(scene.entryFrame ?? 0);
  }

  private buildTrack(track: GsapSceneTrack, master: gsap.core.Timeline, fps: number): RuntimeTrack {
    const element = document.createElement("div");
    element.className = "gsap-scene-track";
    element.dataset.depth = String(track.depth);
    element.dataset.characterId = String(track.characterId);
    element.style.position = "absolute";
    element.style.left = "0";
    element.style.top = "0";
    element.style.transformOrigin = "0 0";
    element.style.zIndex = String(track.depth);
    element.style.display = "none";
    element.style.pointerEvents = "none";

    const media = this.createMedia(track);
    element.append(media);
    this.layer.append(element);

    const first = track.keys[0];
    const state = {
      a: first?.a ?? 1,
      b: first?.b ?? 0,
      c: first?.c ?? 0,
      d: first?.d ?? 1,
      tx: first?.tx ?? 0,
      ty: first?.ty ?? 0,
      opacity: first?.opacity ?? 1,
    };

    const runtime: RuntimeTrack = { track, element, media, state, lastCellSrc: null, visible: null };
    const writeState = () => this.applyState(runtime);

    // Initialise the state at the track's birth time, then chain a real tween
    // for every keyframe segment. Linear ease reproduces Flash frame data.
    master.set(state, { ...stateOf(first), onUpdate: writeState }, track.birthTime);
    for (let i = 0; i < track.keys.length - 1; i += 1) {
      const from = track.keys[i];
      const to = track.keys[i + 1];
      const duration = (to.frame - from.frame) / fps;
      if (duration <= 0) {
        master.set(state, { ...stateOf(to), onUpdate: writeState }, to.frame / fps);
        continue;
      }
      master.to(state, {
        ...stateOf(to),
        duration,
        ease: "none",
        onUpdate: writeState,
      }, from.frame / fps);
    }

    return runtime;
  }

  private createMedia(track: GsapSceneTrack): HTMLElement {
    const origin = track.origin;
    if (track.kind === "text") {
      const text = document.createElement("div");
      text.className = "gsap-scene-media gsap-scene-text";
      text.style.position = "absolute";
      text.style.left = `${-origin.x}px`;
      text.style.top = `${-origin.y}px`;
      if (origin.width) text.style.width = `${origin.width}px`;
      if (track.textSrc) {
        void fetch(`/${track.textSrc}`)
          .then((response) => (response.ok ? response.text() : ""))
          .then((content) => { text.textContent = content.trim(); });
      }
      return text;
    }

    const image = document.createElement("img");
    image.className = "gsap-scene-media";
    image.decoding = "async";
    image.draggable = false;
    image.style.position = "absolute";
    image.style.left = `${-origin.x}px`;
    image.style.top = `${-origin.y}px`;
    if (origin.width) image.style.width = `${origin.width}px`;
    if (origin.height) image.style.height = `${origin.height}px`;
    const initialSrc = track.src ?? track.cells?.[0]?.src ?? "";
    if (initialSrc) {
      image.src = `/${initialSrc}`;
      image.dataset.src = initialSrc;
    }
    return image;
  }

  private applyState(runtime: RuntimeTrack) {
    const { a, b, c, d, tx, ty, opacity } = runtime.state;
    runtime.element.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`;
    runtime.element.style.opacity = String(opacity);
  }

  private handleTick() {
    if (!this.scene) return;
    const frame = Math.max(
      0,
      Math.min(this.scene.frameCount - 1, Math.round((this.timeline?.time() ?? 0) * this.scene.fps)),
    );

    for (const runtime of this.runtimeTracks) {
      this.updateDiscreteState(runtime, frame);
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
    if (!visible || !track.cells || !(runtime.media instanceof HTMLImageElement)) return;

    // Pick the latest sprite cell at or before this frame.
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

  // ===== Playback controls =====

  play() {
    if (!this.timeline) return;
    if (this.lastFrame >= this.totalFrames - 1) this.seekToFrame(0);
    // Step off a stop frame so playback can resume.
    if (this.stopFrames.has(this.lastFrame)) {
      this.timeline.time((this.lastFrame + 1) / this.fps, true);
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
    this.runtimeTracks = [];
    this.scene = null;
    this.lastFrame = -1;
    this.layer.replaceChildren();
  }
}

function stateOf(key: GsapSceneKeyframe | undefined) {
  return {
    a: key?.a ?? 1,
    b: key?.b ?? 0,
    c: key?.c ?? 0,
    d: key?.d ?? 1,
    tx: key?.tx ?? 0,
    ty: key?.ty ?? 0,
    opacity: key?.opacity ?? 1,
  };
}
