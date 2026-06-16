import type { AssetTimeline, ControlAction } from "../data/timelineTypes";
import { loadTimeline } from "../data/TimelineLoader";
import { DomRenderer } from "../render/DomRenderer";
import { FontRegistry } from "../render/TextRenderer";
import { Player } from "../player/Player";
import { VariableStore } from "../player/VariableStore";
import { SoundController } from "../audio/SoundController";

export type PlayerControllerOptions = {
  onFrame?: (rootFrame: number, playing: boolean, label: string) => void;
};

type Level = { player: Player; layer: HTMLElement; swf: string };

/** The level a movie auto-loaded by the host timeline lands on (e.g. intro→4). */
const PARSE_LEVEL = /^_level(\d+)/;

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
  /** Shared AVM1 variable scope (tour globals live on _level0, read cross-level). */
  private readonly store = new VariableStore();
  /** Levels already (re)loaded in the current sync burst — first load per level wins. */
  private loadBurst = new Set<number>();
  /** Cross-level function calls whose target level hasn't loaded yet. */
  private pendingCalls: { level: number; name: string }[] = [];
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
    this.store.reset();
    this.pendingCalls = [];
    this.loadBurst.clear();
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

    // Seed the shared variable scope from this timeline's own globalDefaults
    // (e.g. _level0's bkgd.OSVersion). Existing values win so _level0 stays
    // authoritative for tour globals other levels read.
    this.store.seed((timeline.control as { globalDefaults?: Record<string, unknown> } | undefined)?.globalDefaults);

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
      store: this.store,
      onCallFunction: (target, name) => this.dispatchCall(target, name),
      onRootHold: level > 0 ? () => this.runInteractiveEntry(level) : undefined,
    });
    this.levels.set(level, { player, layer, swf });
    // Levels loaded after playback has started must catch up (e.g. the shell's
    // intro/_level4 loads async, after the main Play already fired).
    if (this.playing) player.play();
    this.flushPendingCalls(level);
  }

  /**
   * Once the host (_level0) has auto-loaded the level its intro lives on, run the
   * SWF's OWN intro→interactive transition through the engine (the function that
   * loads a movie into that level). For the XP tour that's `LoadInitialInteractive`:
   * it swaps the played-out intro for the category menu and calls
   * `_level6.startNavEntrance`, which is OSVersion-gated so the nav goes to the
   * Pro vs Personal toolbar from the SWF's own data. Nothing here is scene- or
   * frame-specific — an unrelated SWF is driven entirely from its own functions.
   */
  /** Flush cross-level calls that were waiting on `level` to exist. */
  private flushPendingCalls(level: number) {
    const ready = this.pendingCalls.filter((c) => c.level === level);
    if (!ready.length) return;
    this.pendingCalls = this.pendingCalls.filter((c) => c.level !== level);
    const player = this.levels.get(level)?.player;
    for (const c of ready) player?.callFunction(c.name);
  }

  /**
   * Run the host's intro→interactive transition for `level` — but only AFTER that
   * level has played its forward entrance (its `onRootHold` fired). So the intro
   * fly-in plays first, then the menu + nav entrance come on, instead of snapping
   * straight to the settled state.
   */
  private runInteractiveEntry(level: number) {
    const host = this.main;
    if (!host) return;
    const entry = host.interactiveEntryFor(level);
    if (entry) host.callFunction(entry);
  }

  /** Resolve an absolute `_levelN[.path]` function-call target to that level's Player. */
  private dispatchCall(target: string, name: string) {
    const match = PARSE_LEVEL.exec(target);
    if (!match) return;
    const level = Number(match[1]);
    const player = this.levels.get(level)?.player;
    if (player) player.callFunction(name);
    else this.pendingCalls.push({ level, name }); // target level not loaded yet
  }

  private handleNavigate(action: ControlAction) {
    if ((action.command !== "loadMovieNum" && action.command !== "loadMovie") || !action.swf) return;
    const level = Number(action.level ?? 0);
    // First load per level within a synchronous burst wins (a transition that
    // loads several movies into one level — segment4 then segment5 — should show
    // the first; the rest are later, interaction-driven swaps).
    if (this.loadBurst.has(level)) return;
    if (this.loadBurst.size === 0) queueMicrotask(() => this.loadBurst.clear());
    this.loadBurst.add(level);
    void this.loadLevel(level, action.swf);
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
