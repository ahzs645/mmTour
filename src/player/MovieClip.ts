import { clamp } from "./types";

/**
 * An independent playhead for a placed sprite instance. Each on-stage sprite
 * gets its own MovieClip so its internal animation advances (and loops) on its
 * own clock, regardless of whether the root timeline is playing or pinned on a
 * stop() frame. This is the core fix for nested loops freezing when the root
 * pauses.
 *
 * Stop frames come from the decompiled control data (control.spriteStopFrames):
 * frames on which the original ActionScript called stop(). Reaching one pins
 * the clip until something calls play()/gotoAndPlay().
 */
export class MovieClip {
  readonly characterId: number;
  readonly frameCount: number;
  private readonly stopFrames: Set<number>;
  currentFrame: number;
  playing: boolean;

  constructor(characterId: number, frameCount: number, stopFrames: number[] = [], startFrame = 0) {
    this.characterId = characterId;
    this.frameCount = Math.max(1, frameCount);
    this.stopFrames = new Set(stopFrames.filter((frame) => frame >= 0 && frame < this.frameCount));
    this.currentFrame = clamp(startFrame, 0, this.frameCount - 1);
    // A clip whose first frame carries stop() starts pinned (static graphic /
    // waits for a trigger), exactly as it would under Ruffle.
    this.playing = !this.stopFrames.has(this.currentFrame);
  }

  /** Advance one tick. Loops at the end unless a stop frame is reached. */
  advance() {
    if (!this.playing || this.frameCount <= 1) return;
    const next = (this.currentFrame + 1) % this.frameCount;
    this.currentFrame = next;
    if (this.stopFrames.has(next)) this.playing = false;
  }

  gotoAndPlay(frame: number) {
    this.currentFrame = clamp(frame, 0, this.frameCount - 1);
    this.playing = true;
  }

  gotoAndStop(frame: number) {
    this.currentFrame = clamp(frame, 0, this.frameCount - 1);
    this.playing = false;
  }

  play() {
    this.playing = true;
  }

  stop() {
    this.playing = false;
  }
}
