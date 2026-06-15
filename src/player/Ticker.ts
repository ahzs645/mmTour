import { gsap } from "gsap";

/**
 * A GSAP-driven, monotonically increasing frame clock. Time never stops while
 * playing — individual playheads (root and clips) decide whether to advance.
 * This is what lets nested animations keep looping while the root timeline is
 * pinned on a stop() frame, matching Flash/Ruffle semantics.
 */
export class Ticker {
  readonly fps: number;
  private state = { t: 0 };
  private tween: gsap.core.Tween;
  private lastTick = -1;
  private readonly onTick: (tick: number) => void;
  // Large horizon so the linear clock effectively never ends.
  private static readonly HORIZON = 10_000_000;

  constructor(fps: number, onTick: (tick: number) => void) {
    this.fps = fps;
    this.onTick = onTick;
    this.tween = gsap.to(this.state, {
      t: Ticker.HORIZON,
      duration: Ticker.HORIZON / fps,
      ease: "none",
      paused: true,
      onUpdate: () => this.emit(),
    });
  }

  private emit() {
    const tick = Math.round(this.state.t);
    if (tick === this.lastTick) return;
    this.lastTick = tick;
    this.onTick(tick);
  }

  play() {
    this.tween.play();
  }

  pause() {
    this.tween.pause();
  }

  get isPlaying(): boolean {
    return this.tween.isActive();
  }

  get tick(): number {
    return Math.round(this.state.t);
  }

  /** Jump the clock to an absolute tick and emit synchronously. */
  seek(tick: number) {
    this.state.t = tick;
    this.tween.pause(tick / this.fps, false);
    this.lastTick = -1;
    this.emit();
  }

  destroy() {
    this.tween.kill();
  }
}
