import type { AssetTimeline, ControlAction, DynamicText, TimelineAsset } from "../data/timelineTypes";
import type { DomRenderer } from "../render/DomRenderer";
import { MovieClip } from "./MovieClip";
import { Ticker } from "./Ticker";
import { clamp, type RenderNode } from "./types";

export type PlayerOptions = {
  /** Called after each rendered frame with the root playhead state. */
  onFrame?: (rootFrame: number, playing: boolean) => void;
  /** Called when the root timeline requests loading another SWF/level (deferred handling). */
  onNavigate?: (action: ControlAction) => void;
  /** Called for sound frame actions as a frame is entered during playback. */
  onSound?: (action: ControlAction) => void;
};

const SOUND_COMMANDS = new Set(["attachSound", "playVO", "stopSound"]);

type ClipEntry = { clip: MovieClip };

/**
 * Drives the decompiled timeline like a Flash player: one root playhead plus an
 * independent playhead per on-stage sprite. The Ticker keeps time moving so
 * nested clips keep looping even while the root is pinned on a stop() frame.
 */
export class Player {
  private readonly timeline: AssetTimeline;
  private readonly renderer: DomRenderer;
  private readonly options: PlayerOptions;
  private readonly ticker: Ticker;

  private readonly assets: Record<string, TimelineAsset>;
  private readonly stopFrames: Set<number>;
  private readonly frameCountValue: number;
  /** 0-based root frame index → timeline-scoped actions that run on entry. */
  private readonly rootActions = new Map<number, ControlAction[]>();

  private rootFrame = 0;
  private rootPlaying = true;
  private clips = new Map<number, ClipEntry>();
  private lastNodes: RenderNode[] = [];

  constructor(timeline: AssetTimeline, renderer: DomRenderer, options: PlayerOptions = {}) {
    this.timeline = timeline;
    this.renderer = renderer;
    this.options = options;
    this.assets = timeline.assets ?? {};
    this.frameCountValue = Math.max(1, timeline.frameCount || timeline.frames.length);
    this.stopFrames = new Set(timeline.control?.stopFrames ?? []);

    // frameActions is an array of {frame, actions[]} records (frame is 0-based).
    // Only "timeline"-scoped actions run on frame entry; function/branch-scoped
    // ones are conditional and must not fire unconditionally.
    for (const record of timeline.control?.frameActions ?? []) {
      const actions = (record.actions ?? []).filter(
        (action) => !action.executionContext || action.executionContext === "timeline",
      );
      if (!actions.length) continue;
      const existing = this.rootActions.get(record.frame);
      if (existing) existing.push(...actions);
      else this.rootActions.set(record.frame, actions);
    }

    this.ticker = new Ticker(timeline.fps || 20, () => this.onTick());

    // Start at the very beginning so intro animation, music and voiceover play
    // through to the scene's own stop() — entryFrame is a legacy nav resume point.
    this.enterRootFrame(0);
    this.render();
  }

  get frameCount(): number {
    return this.frameCountValue;
  }

  get currentFrame(): number {
    return this.rootFrame;
  }

  get isPlaying(): boolean {
    return this.ticker.isPlaying;
  }

  currentLabel(): string {
    const frame = this.timeline.frames[this.rootFrame];
    if (frame?.label) return frame.label;
    const labels = this.timeline.labels ?? {};
    return Object.entries(labels).find(([, index]) => index === this.rootFrame)?.[0] ?? "";
  }

  debugNodes(): RenderNode[] {
    return this.lastNodes;
  }

  play() {
    // If the root was pinned on a stop() frame, nudge it forward so Play resumes.
    if (!this.rootPlaying && this.stopFrames.has(this.rootFrame)) {
      this.rootPlaying = true;
    }
    this.ticker.play();
  }

  pause() {
    this.ticker.pause();
  }

  toggle() {
    if (this.ticker.isPlaying) this.pause();
    else this.play();
  }

  /** Scrub the root playhead. Clips re-seed from this root frame. */
  seekRootFrame(frame: number) {
    this.ticker.pause();
    this.clips.clear();
    this.rootPlaying = true;
    this.enterRootFrame(frame);
    this.render();
    this.options.onFrame?.(this.rootFrame, false);
  }

  restart() {
    this.seekRootFrame(0);
  }

  /**
   * Run a button's release action. `self`/`_parent` targets drive the clip that
   * hosts the button (the owner sprite at ownerDepth); `_root`/`_level0` drive
   * the root timeline. This matches how the tour's menu buttons play their own
   * sprite ("show screenshots") rather than jumping the root.
   */
  dispatchButtonAction(action: ControlAction, ownerDepth: number) {
    if (action.command !== "gotoAndPlay" && action.command !== "gotoAndStop") return;
    const target = this.resolveFrame(action);
    if (target < 0) return;
    const play = action.command === "gotoAndPlay";
    const scope = action.target ?? "self";

    if (scope === "_root" || scope === "_level0" || scope === "root") {
      this.rootPlaying = play;
      this.enterRootFrame(target);
      this.render();
      return;
    }

    const entry = this.clips.get(ownerDepth);
    if (entry) {
      if (play) entry.clip.gotoAndPlay(target);
      else entry.clip.gotoAndStop(target);
      this.render();
      return;
    }

    // No tracked owner clip — fall back to the root timeline.
    this.rootPlaying = play;
    this.enterRootFrame(target);
    this.render();
  }

  destroy() {
    this.ticker.destroy();
    this.renderer.clear();
    this.clips.clear();
  }

  // --- internals --------------------------------------------------------

  private onTick() {
    // 1. Independent clip playheads advance every tick, regardless of the root.
    for (const { clip } of this.clips.values()) clip.advance();

    // 2. The root playhead only advances when it isn't pinned by a stop().
    if (this.rootPlaying) {
      const previous = this.rootFrame;
      const next = this.rootFrame + 1 >= this.frameCountValue ? 0 : this.rootFrame + 1;
      this.enterRootFrame(next);
      // Fire sound effects only for frames genuinely entered during playback,
      // not on scrub/seek — so dragging the scrubber stays silent.
      if (this.rootFrame !== previous) this.fireFrameSounds(this.rootFrame);
    }

    this.render();
    // Report the clock state (time is running, clips loop) rather than the root
    // playhead state, which may be pinned on a stop() while the scene plays on.
    this.options.onFrame?.(this.rootFrame, this.ticker.isPlaying);
  }

  /** Set the root playhead to a frame and run that frame's actions (stop/goto). */
  private enterRootFrame(frame: number, depth = 0) {
    this.rootFrame = clamp(frame, 0, this.frameCountValue - 1);
    if (depth > 32) return;

    for (const action of this.rootActionsAt(this.rootFrame)) {
      switch (action.command) {
        case "stop":
          this.rootPlaying = false;
          break;
        case "play":
          this.rootPlaying = true;
          break;
        case "gotoAndPlay": {
          const target = this.resolveFrame(action);
          if (target >= 0 && target !== this.rootFrame) {
            this.rootPlaying = true;
            this.enterRootFrame(target, depth + 1);
            return;
          }
          break;
        }
        case "gotoAndStop": {
          const target = this.resolveFrame(action);
          this.rootPlaying = false;
          if (target >= 0 && target !== this.rootFrame) {
            this.enterRootFrame(target, depth + 1);
            return;
          }
          break;
        }
        case "loadMovieNum":
        case "loadVariables":
        case "doRelease":
          this.options.onNavigate?.(action);
          break;
        default:
          break;
      }
    }

    if (this.stopFrames.has(this.rootFrame)) this.rootPlaying = false;
  }

  private rootActionsAt(frame: number): ControlAction[] {
    return this.rootActions.get(frame) ?? [];
  }

  private fireFrameSounds(frame: number) {
    if (!this.options.onSound) return;
    for (const action of this.rootActionsAt(frame)) {
      if (action.command && SOUND_COMMANDS.has(action.command)) this.options.onSound(action);
    }
  }

  private resolveFrame(action: ControlAction): number {
    if (typeof action.frame === "number") return action.frame;
    if (action.label) {
      const labels = this.timeline.labels ?? {};
      if (action.label in labels) return labels[action.label];
    }
    return -1;
  }

  private render() {
    const frame = this.timeline.frames[this.rootFrame];
    if (!frame) return;

    const nodes: RenderNode[] = [];
    const liveDepths = new Set<number>();

    for (const instance of frame.instances) {
      const asset = this.assets[String(instance.characterId)];
      if (!asset) continue;
      liveDepths.add(instance.depth);

      let src = asset.src ?? "";
      let spriteFrame: number | undefined;
      if (asset.kind === "sprite" && asset.frames?.length) {
        const clip = this.ensureClip(instance.depth, asset);
        spriteFrame = clip.currentFrame;
        src = asset.frames[clip.currentFrame] ?? asset.frames[0] ?? "";
      } else if (asset.kind === "button") {
        src = asset.states?.up?.src ?? asset.src ?? "";
      }

      nodes.push({
        depth: instance.depth,
        characterId: instance.characterId,
        kind: asset.kind,
        name: instance.name,
        src,
        origin: asset.origin,
        matrix: instance.matrix,
        opacity: instance.opacity,
        colorTransform: instance.colorTransform,
        clipDepth: instance.clipDepth,
        spriteFrame,
        text: asset.kind === "text" ? this.resolveTextField(instance.characterId, asset) : undefined,
      });
    }

    // Drop clips whose depth left the stage so a re-placed instance restarts.
    for (const depth of [...this.clips.keys()]) {
      if (!liveDepths.has(depth)) this.clips.delete(depth);
    }

    this.renderer.apply(nodes);
    this.lastNodes = nodes;
  }

  private ensureClip(depth: number, asset: TimelineAsset): MovieClip {
    const existing = this.clips.get(depth);
    if (existing && existing.clip.characterId === asset.id) return existing.clip;

    const stopFrames = this.timeline.control?.spriteStopFrames?.[String(asset.id)] ?? [];
    const clip = new MovieClip(asset.id, asset.frames?.length ?? 1, stopFrames, 0);
    this.clips.set(depth, { clip });
    return clip;
  }

  /**
   * Merge a text field's own styling (asset.text, present for every edit-text)
   * with any loaded-variable override (control.dynamicTexts). The dynamic entry
   * wins for content; the asset styling provides font/size/color/box.
   */
  private resolveTextField(characterId: number, asset: TimelineAsset): DynamicText | undefined {
    const base = asset.text;
    const dynamic = this.timeline.control?.dynamicTexts?.[String(characterId)];
    if (base && dynamic) return { ...base, ...dynamic };
    return base ?? dynamic;
  }
}
