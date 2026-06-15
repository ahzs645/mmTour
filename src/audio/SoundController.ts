import { assetUrl } from "../data/TimelineLoader";
import type { ControlAction } from "../data/timelineTypes";

/**
 * Plays the tour's extracted audio from frame actions: a single looping music
 * channel (attachSound role="music") and a single voiceover channel (playVO).
 * Browser autoplay policy means playback only starts after a user gesture — the
 * Play button click — so play() rejections are swallowed.
 */
export class SoundController {
  private music: HTMLAudioElement | null = null;
  private musicSrc = "";
  private voice: HTMLAudioElement | null = null;
  private muted = false;

  handle(action: ControlAction) {
    if (this.muted) return;
    switch (action.command) {
      case "attachSound":
        if (!action.soundSrc) break;
        if (action.soundRole === "music") this.playMusic(action.soundSrc);
        else this.playVoice(action.soundSrc);
        break;
      case "playVO":
        if (action.soundSrc) this.playVoice(action.soundSrc);
        break;
      case "stopSound":
        this.stopVoice();
        break;
      default:
        break;
    }
  }

  private playMusic(src: string) {
    if (this.musicSrc === src && this.music) return;
    this.stopMusic();
    const audio = new Audio(assetUrl(src));
    audio.loop = true;
    audio.volume = 0.4;
    void audio.play().catch(() => undefined);
    this.music = audio;
    this.musicSrc = src;
  }

  private playVoice(src: string) {
    this.stopVoice();
    const audio = new Audio(assetUrl(src));
    audio.volume = 1;
    void audio.play().catch(() => undefined);
    this.voice = audio;
  }

  private stopMusic() {
    this.music?.pause();
    this.music = null;
    this.musicSrc = "";
  }

  private stopVoice() {
    this.voice?.pause();
    this.voice = null;
  }

  /** Pause both channels (global pause) without forgetting the music track. */
  suspend() {
    this.music?.pause();
    this.voice?.pause();
  }

  resume() {
    void this.music?.play().catch(() => undefined);
  }

  destroy() {
    this.stopMusic();
    this.stopVoice();
  }
}
