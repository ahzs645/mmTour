import type { AssetTimeline } from "../data/timelineTypes";
import { DomRenderer } from "../render/DomRenderer";
import { FontRegistry } from "../render/TextRenderer";
import { Player } from "../player/Player";
import { SoundController } from "../audio/SoundController";

export type PlayerControllerOptions = {
  onFrame?: (rootFrame: number, playing: boolean, label: string) => void;
};

/**
 * Owns a Player instance and mounts it into a dedicated stage layer. Bridges the
 * decompiled-player subsystem to the app's existing play/scrub/restart controls
 * without disturbing the other render modes.
 */
export class PlayerController {
  private readonly layer: HTMLElement;
  private readonly options: PlayerControllerOptions;
  private readonly fonts = new FontRegistry();
  private readonly sound = new SoundController();
  private player: Player | null = null;
  private timeline: AssetTimeline | null = null;

  constructor(layer: HTMLElement, options: PlayerControllerOptions = {}) {
    this.layer = layer;
    this.options = options;
  }

  get active(): boolean {
    return this.player !== null;
  }

  get frameCount(): number {
    return this.player?.frameCount ?? 0;
  }

  get currentFrame(): number {
    return this.player?.currentFrame ?? 0;
  }

  get isPlaying(): boolean {
    return this.player?.isPlaying ?? false;
  }

  activate(timeline: AssetTimeline, entryFrame?: number) {
    this.deactivate();
    this.timeline = timeline;
    this.layer.hidden = false;
    this.fonts.register(timeline);
    const renderer = new DomRenderer(this.layer, {
      resolveFontFamily: (fontId) => this.fonts.resolveFamily(fontId),
      onButtonEvent: (ownerPath, characterId, event) => this.player?.handleButtonEvent(ownerPath, characterId, event),
    });
    this.player = new Player(timeline, renderer, {
      onFrame: (frame, playing) => this.options.onFrame?.(frame, playing, this.player?.currentLabel() ?? ""),
      onSound: (action) => this.sound.handle(action),
    });
    if (typeof entryFrame === "number") this.player.seekRootFrame(entryFrame);
    this.emitFrame();
  }

  deactivate() {
    this.player?.destroy();
    this.player = null;
    this.sound.destroy();
    this.layer.hidden = true;
    this.layer.replaceChildren();
  }

  play() {
    this.player?.play();
    this.sound.resume();
  }

  pause() {
    this.player?.pause();
    this.sound.suspend();
    this.emitFrame();
  }

  toggle() {
    this.player?.toggle();
    if (this.player?.isPlaying) this.sound.resume();
    else this.sound.suspend();
  }

  seekRootFrame(frame: number) {
    this.player?.seekRootFrame(frame);
    this.emitFrame();
  }

  restart() {
    this.player?.restart();
    this.emitFrame();
  }

  private emitFrame() {
    if (!this.player) return;
    this.options.onFrame?.(this.player.currentFrame, this.player.isPlaying, this.player.currentLabel());
  }
}
