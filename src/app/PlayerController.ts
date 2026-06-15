import type { AssetTimeline, ControlAction } from "../data/timelineTypes";
import { loadTimeline } from "../data/TimelineLoader";
import { DomRenderer } from "../render/DomRenderer";
import { FontRegistry } from "../render/TextRenderer";
import { Player } from "../player/Player";
import { SoundController } from "../audio/SoundController";

export type PlayerControllerOptions = {
  onFrame?: (rootFrame: number, playing: boolean, label: string) => void;
};

type Level = { player: Player; layer: HTMLElement; swf: string };

/**
 * Drives the decompiled player and its Flash levels. The selected scene is
 * _level0; `loadMovieNum`/`loadMovie` actions load other scenes' timelines into
 * higher levels (e.g. the Tour Shell loads intro→_level4 and nav→_level6), each
 * on its own stacked layer so the composite matches the real multi-SWF tour.
 */
export class PlayerController {
  private readonly container: HTMLElement;
  private readonly options: PlayerControllerOptions;
  private readonly fonts = new FontRegistry();
  private readonly sound = new SoundController();
  private readonly levels = new Map<number, Level>();
  private mainSwf = "";
  private playing = false;

  constructor(container: HTMLElement, options: PlayerControllerOptions = {}) {
    this.container = container;
    this.options = options;
  }

  private get main(): Player | null {
    return this.levels.get(0)?.player ?? null;
  }

  get active(): boolean {
    return this.levels.size > 0;
  }

  get frameCount(): number {
    return this.main?.frameCount ?? 0;
  }

  get currentFrame(): number {
    return this.main?.currentFrame ?? 0;
  }

  get isPlaying(): boolean {
    return this.main?.isPlaying ?? false;
  }

  activate(timeline: AssetTimeline, swf: string, entryFrame?: number) {
    this.deactivate();
    this.container.hidden = false;
    this.mainSwf = swf;
    this.createLevel(0, swf, timeline);
    if (typeof entryFrame === "number") this.main?.seekRootFrame(entryFrame);
    this.emitFrame();
  }

  deactivate() {
    for (const level of this.levels.values()) {
      level.player.destroy();
      level.layer.remove();
    }
    this.levels.clear();
    this.sound.destroy();
    this.container.hidden = true;
    this.container.replaceChildren();
  }

  play() {
    this.playing = true;
    for (const level of this.levels.values()) level.player.play();
    this.sound.resume();
  }

  pause() {
    this.playing = false;
    for (const level of this.levels.values()) level.player.pause();
    this.sound.suspend();
    this.emitFrame();
  }

  toggle() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  seekRootFrame(frame: number) {
    this.main?.seekRootFrame(frame);
    this.emitFrame();
  }

  restart() {
    for (const level of this.levels.values()) level.player.restart();
    this.emitFrame();
  }

  // --- level management -------------------------------------------------

  private createLevel(level: number, swf: string, timeline: AssetTimeline) {
    const existing = this.levels.get(level);
    if (existing) {
      existing.player.destroy();
      existing.layer.remove();
      this.levels.delete(level);
    }

    this.fonts.register(timeline);
    const layer = document.createElement("div");
    layer.className = "player-level";
    layer.style.zIndex = String(level);
    this.container.append(layer);

    const renderer = new DomRenderer(layer, {
      resolveFontFamily: (fontId) => this.fonts.resolveFamily(fontId),
      onButtonEvent: (ownerPath, characterId, event) => this.levels.get(level)?.player.handleButtonEvent(ownerPath, characterId, event),
    });
    const player = new Player(timeline, renderer, {
      onFrame: level === 0 ? (frame, playing) => this.options.onFrame?.(frame, playing, this.main?.currentLabel() ?? "") : undefined,
      onSound: (action) => this.sound.handle(action),
      onNavigate: (action) => this.handleNavigate(action),
    });
    this.levels.set(level, { player, layer, swf });
    // Levels loaded after playback has started must catch up (e.g. the shell's
    // intro/_level4 loads async, after the main Play already fired).
    if (this.playing) player.play();
  }

  private handleNavigate(action: ControlAction) {
    if ((action.command === "loadMovieNum" || action.command === "loadMovie") && action.swf) {
      void this.loadLevel(Number(action.level ?? 0), action.swf);
    }
  }

  private async loadLevel(level: number, swf: string) {
    if (level <= 0) return; // _level0 is the selected scene; don't replace it
    const existing = this.levels.get(level);
    if (existing && existing.swf.toLowerCase() === swf.toLowerCase()) return; // already loaded
    if (swf.toLowerCase() === this.mainSwf.toLowerCase()) return; // avoid loading self into a level

    const timeline = await loadTimeline(swf);
    if (!timeline || this.container.hidden) return; // deactivated while loading
    this.createLevel(level, swf, timeline as unknown as AssetTimeline);
  }

  private emitFrame() {
    const player = this.main;
    if (!player) return;
    this.options.onFrame?.(player.currentFrame, player.isPlaying, player.currentLabel());
  }
}
