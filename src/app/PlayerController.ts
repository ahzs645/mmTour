import type { AssetTimeline, ControlAction } from "../data/timelineTypes";
import { assetUrl, loadTimeline } from "../data/TimelineLoader";
import { collectReferencedSwfs, prefetchScene } from "../data/prefetch";
import { collectExplicitSoundTimings } from "../data/soundTimings";
import { DomRenderer } from "../render/DomRenderer";
import { FontRegistry } from "../render/TextRenderer";
import { Player } from "../player/Player";
import { VariableStore, type VarValue } from "../player/VariableStore";
import { SoundController } from "../audio/SoundController";

export type PlayerControllerOptions = {
  onFrame?: (rootFrame: number, playing: boolean, label: string) => void;
  /** Enable temporary segment-flash tracing (console logs + a bottom-bar rAF watch). Off by default. */
  debug?: boolean;
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
  private pendingCalls: { level: number; name: string; args?: string }[] = [];
  /** Active AVM1 waiters (`waitForVal`): poll a store flag, then fire callBack on its level. */
  private waiters: { level: number; obj: string; val: VarValue; cb: number }[] = [];
  /** Scenes already cache-warmed this session (so a section change paints instantly). */
  private prefetched = new Set<string>();
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
    this.waiters = [];
    this.loadBurst.clear();
    this.prefetched.clear();
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
    if (existing) this.destroyLevel(level);

    // Seed the shared variable scope from this timeline's own globalDefaults
    // (e.g. _level0's bkgd.OSVersion). Existing values win so _level0 stays
    // authoritative for tour globals other levels read.
    this.store.seed((timeline.control as { globalDefaults?: Record<string, unknown> } | undefined)?.globalDefaults);
    this.sound.registerTimings(collectExplicitSoundTimings(timeline.control));

    this.fonts.register(timeline);
    const layer = document.createElement("div");
    layer.className = "player-level";
    layer.style.zIndex = String(level);
    this.container.append(layer);

    const renderer = new DomRenderer(layer, {
      resolveFontFamily: (fontId) => this.fonts.resolveFamily(fontId),
      onButtonEvent: (ownerPath, characterId, event, buttonKey) => this.levels.get(level)?.player.handleButtonEvent(ownerPath, characterId, event, buttonKey),
    });
    const player = new Player(timeline, renderer, {
      // Level 0 ticks every frame (even when stopped), so poll waiters here.
      onFrame:
        level === 0
          ? (frame, playing) => { this.checkWaiters(); this.options.onFrame?.(frame, playing, this.main?.currentLabel() ?? ""); }
          : undefined,
      onSound: (action) => this.sound.handle(action, level),
      onNavigate: (action) => this.handleNavigate(action, level),
      store: this.store,
      onCallFunction: (target, name, args) => this.dispatchCall(target, name, args),
      onClipCommand: (target, command, frame) => this.dispatchClipCommand(target, command, frame),
      onWaiter: (kind, args) => this.registerWaiter(level, kind, args),
      onLoadVariables: (action) => this.handleLoadVariables(level, action),
      isVoiceDone: () => this.sound.isVoiceDone(),
      // A movie loaded into a higher level plays from frame 0 (so its load-time gating runs,
      // e.g. segment4's `if(doAttractLoop) stay blank`); entryFrame is only the standalone preview.
      startFrame: level > 0 ? 0 : undefined,
    });
    this.levels.set(level, { player, layer, swf });
    // Levels loaded after playback has started must catch up (e.g. the shell's
    // intro/_level4 loads async, after the main Play already fired).
    if (this.playing) player.play();
    this.flushPendingCalls(level);
    this.prefetchReferenced(timeline);

    // [FLASHDBG] Temporary: trace the segment-flash cause. Log the doAttractLoop
    // flag at load, then watch the bottom-center for ~6s and report the exact
    // instant it goes uncovered (white) with every level's current frame.
    if (this.options.debug && level > 0) {
      const da = this.store.get("bkgd.doAttractLoop");
      // eslint-disable-next-line no-console
      console.log(`[FLASHDBG] load ${swf} → _level${level}  doAttractLoop=${JSON.stringify(da)}`);
      this.watchBottom(swf);
    }
  }

  /** [FLASHDBG] Temporary: rAF-watch the bottom-center of the stage after a segment
   *  loads; log the moment it has no covering image (the white flash) with each
   *  level's current frame, so we can see WHICH level fails to cover and when. */
  private watchBottom(swf: string) {
    const start = performance.now();
    let reports = 0;
    const tick = () => {
      const t = performance.now() - start;
      if (t > 6000 || reports > 4 || !this.active) return;
      const root = this.container.getBoundingClientRect();
      const px = root.left + root.width / 2, py = root.bottom - 12;
      const covers = (r: DOMRect) => r.left <= px && r.right >= px && r.top <= py && r.bottom >= py;
      const entries = [...this.levels.entries()].map(([lvl, L]) => {
        const imgs = [...L.layer.querySelectorAll("img.player-media")].filter((im) => im.getAttribute("src"));
        const cov = imgs.find((im) => covers(im.getBoundingClientRect()));
        return { lvl, str: `_lvl${lvl}(${L.swf.replace(".swf", "")},f${L.player.currentFrame}):${cov ? "BAR" : "-"}` };
      });
      const levels = entries.map((e) => e.str);
      // The level-0 shell's near-white swoosh covers this point continuously, so a
      // "flash" is when NO content level (>0) — the nav bar or the segment bar —
      // covers it, exposing that swoosh.
      const barCovered = entries.some((e) => e.lvl > 0 && e.str.endsWith("BAR"));
      if (!barCovered) {
        reports++;
        // eslint-disable-next-line no-console
        console.log(`[FLASHDBG] !!! WHITE-BOTTOM @${Math.round(t)}ms after ${swf}: ${levels.join("  ")}`);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Warm the cache for the scenes this level can navigate to (e.g. the nav's five
   *  section buttons → segmentN.swf), so a later section change paints immediately
   *  instead of flashing the bare stage while a cold multi-MB timeline loads on
   *  click. Without it the bottom bar flashes white on a section change: the nav
   *  strips its own toolbar mid-exit (a real RemoveObject in nav.swf at that frame),
   *  and the incoming segment — whose own bar should take over — hasn't painted yet.
   *  Ruffle never shows this because it loads segments instantly from local SWF. */
  private prefetchReferenced(timeline: AssetTimeline) {
    for (const swf of collectReferencedSwfs(timeline)) {
      const key = swf.toLowerCase();
      if (key === this.mainSwf.toLowerCase() || this.prefetched.has(key)) continue;
      this.prefetched.add(key);
      void prefetchScene(swf);
    }
  }

  /** Flush cross-level calls that were waiting on `level` to exist. The intro's
   *  `_level0.LoadIntroNav()` / `LoadInitialInteractive()` (now captured by the
   *  decompiler) drive the nav-on-stage and intro→menu hand-off entirely from data. */
  private flushPendingCalls(level: number) {
    const ready = this.pendingCalls.filter((c) => c.level === level);
    if (!ready.length) return;
    this.pendingCalls = this.pendingCalls.filter((c) => c.level !== level);
    const player = this.levels.get(level)?.player;
    for (const c of ready) player?.callFunction(c.name, c.args);
  }

  /** Register an AVM1 waiter. `waitForVal(obj, val, cb)` fires `callBack(cb)` on its
   *  owning level once `obj == val`; checked each tick (see checkWaiters). The tour
   *  uses it to defer the section highlight until the nav reports `bln_CoreNavLoaded`. */
  private registerWaiter(level: number, kind: string, args: (VarValue | undefined)[]) {
    if (kind !== "waitForVal") return; // startTimer (time-based) isn't on the highlight path
    const [obj, val, cb] = args;
    if (typeof obj !== "string" || val === undefined) return;
    this.waiters.push({ level, obj, val, cb: Number(cb ?? 0) });
    this.checkWaiters(); // the watched flag may already hold (nav loaded before the showcase)
  }

  /** Fire any waiter whose watched store value now equals its target, then drop it. */
  private checkWaiters() {
    if (!this.waiters.length) return;
    const still: typeof this.waiters = [];
    for (const w of this.waiters) {
      if (String(this.store.get(w.obj) ?? "") === String(w.val)) this.dispatchCall(`_level${w.level}`, "callBack", String(w.cb));
      else still.push(w);
    }
    this.waiters = still;
  }

  /** Run a timeline command on a named clip in another level — the nav section
   *  highlight (`_level6.yellowPro.gotoAndPlay("over")`). */
  private dispatchClipCommand(target: string, command: string, frame: VarValue) {
    const match = PARSE_LEVEL.exec(target);
    if (!match) return;
    const player = this.levels.get(Number(match[1]))?.player;
    if (!player) return;
    const path = target.replace(/^_level\d+\.?/i, ""); // "_level6.yellowPro" → "yellowPro"
    // Empty path = the whole level root (`_level4.gotoAndPlay("segStart")` — the attract loop
    // playing the loaded segment); a non-empty path targets a named clip in that level.
    player.runNamedClipCommand(player.rootClip, path, command, frame);
  }

  /** Fetch a `loadVariables` text file (`&key=value&…`) and feed it to the level's text fields. */
  private async handleLoadVariables(level: number, action: ControlAction) {
    const file = action.variableSource ?? (action.swf && !/\.swf$/i.test(action.swf) ? action.swf : undefined) ?? action.target;
    if (!file) return;
    try {
      const res = await fetch(assetUrl(file));
      if (!res.ok || this.container.hidden) return;
      this.levels.get(level)?.player.setTextVars(parseFlashVars(await res.text()));
    } catch {
      /* a missing text file just leaves the bound fields blank */
    }
  }

  /** Resolve an absolute `_levelN[.path]` function-call target to that level's Player. */
  private dispatchCall(target: string, name: string, args?: string) {
    const match = PARSE_LEVEL.exec(target);
    if (!match) return;
    const level = Number(match[1]);
    const player = this.levels.get(level)?.player;
    if (player) player.callFunction(name, args);
    else this.pendingCalls.push({ level, name, args }); // target level not loaded yet
  }

  private handleNavigate(action: ControlAction, sourceLevel = 0) {
    if (action.command === "unloadMovieNum" || action.command === "unloadMovie") {
      const level = Number(action.level ?? this.inferLoadLevel(sourceLevel) ?? 0);
      if (level > 0) this.destroyLevel(level);
      return;
    }
    if ((action.command !== "loadMovieNum" && action.command !== "loadMovie") || !action.swf) return;
    const level = Number(action.level ?? this.inferLoadLevel(sourceLevel) ?? 0);
    const existing = this.levels.get(level);
    if (level > 0 && existing && (action.reload || existing.swf.toLowerCase() !== action.swf.toLowerCase())) {
      this.sound.stopOwner(level);
    }
    // A nav section click forces a fresh (re)load (the SWF's doRelease unloads+reloads), so it
    // bypasses the burst/already-loaded guards that exist only for the initial multi-load.
    if (!action.reload) {
      // First load per level within a synchronous burst wins (a transition that
      // loads several movies into one level — segment4 then segment5 — should show
      // the first; the rest are later, interaction-driven swaps).
      if (this.loadBurst.has(level)) return;
      if (this.loadBurst.size === 0) queueMicrotask(() => this.loadBurst.clear());
      this.loadBurst.add(level);
    }
    void this.loadLevel(level, action.swf, Boolean(action.reload));
  }

  private inferLoadLevel(sourceLevel: number): number | undefined {
    if (sourceLevel <= 0) return undefined;
    const candidates = [...this.levels.keys()].filter((level) => level > 0 && level < sourceLevel);
    return candidates.length ? Math.max(...candidates) : undefined;
  }

  private async loadLevel(level: number, swf: string, reload = false) {
    if (level <= 0) return; // _level0 is the selected scene; don't replace it
    const existing = this.levels.get(level);
    if (!reload && existing && existing.swf.toLowerCase() === swf.toLowerCase()) return; // already loaded
    if (swf.toLowerCase() === this.mainSwf.toLowerCase()) return; // avoid loading self into a level

    const timeline = await loadTimeline(swf);
    if (!timeline || this.container.hidden) return; // deactivated while loading
    this.createLevel(level, swf, timeline as unknown as AssetTimeline);
  }

  private destroyLevel(level: number) {
    const existing = this.levels.get(level);
    if (!existing) return;
    this.sound.stopOwner(level);
    existing.player.destroy();
    existing.layer.remove();
    this.levels.delete(level);
  }

  private emitFrame() {
    const player = this.main;
    if (!player) return;
    this.options.onFrame?.(player.currentFrame, player.isPlaying, player.currentLabel());
  }
}

/** Parse a Flash `loadVariables` body (`&key=value&key2=value2…`) into a map. */
function parseFlashVars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).replace(/\r?\n$/, "");
    try {
      value = decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      /* keep the literal value if it isn't percent-encoded */
    }
    out[key] = value;
  }
  return out;
}
