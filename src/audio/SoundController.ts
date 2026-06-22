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
  private voiceStartedAt = 0;
  private voiceDurationMs = 0;
  private pendingVoiceSegmentDurationMs = 0;
  private muted = false;
  /** Used when a VO's metadata hasn't loaded yet (or audio is autoplay-blocked). */
  private static readonly FALLBACK_VO_MS = 5000;
  /** Marker-only VO segments do not carry their own media file duration. */
  private static readonly FALLBACK_SEGMENT_MS = 2500;

  handle(action: ControlAction) {
    if (this.muted) return;
    switch (action.command) {
      case "attachSound":
        if (!action.soundSrc) break;
        if (action.soundRole === "music") this.playMusic(action.soundSrc);
        else this.playVoice(action.soundSrc);
        break;
      case "playVO":
        if (action.soundSrc) this.playVoice(action.soundSrc, action.soundDurationMs);
        break;
      case "markSndSegment":
        this.markVoiceSegment(action.soundDurationMs);
        break;
      case "stopSound":
        this.pendingVoiceSegmentDurationMs = 0;
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

  private playVoice(src: string, durationMs?: number) {
    const pendingSegmentDurationMs = this.pendingVoiceSegmentDurationMs;
    this.pendingVoiceSegmentDurationMs = 0;
    this.stopVoice();
    const audio = new Audio(assetUrl(src));
    audio.volume = 1;
    this.voiceStartedAt = performance.now();
    this.voiceDurationMs = pendingSegmentDurationMs || (durationMs && Number.isFinite(durationMs) ? durationMs : 0);
    audio.addEventListener("loadedmetadata", () => {
      if (!this.voiceDurationMs && Number.isFinite(audio.duration)) this.voiceDurationMs = audio.duration * 1000;
    });
    void audio.play().catch(() => undefined);
    this.voice = audio;
  }

  private markVoiceSegment(durationMs?: number) {
    const segmentDurationMs =
      durationMs && Number.isFinite(durationMs) ? durationMs : SoundController.FALLBACK_SEGMENT_MS;
    if (!this.voice) {
      this.pendingVoiceSegmentDurationMs = segmentDurationMs;
      return;
    }
    this.voiceStartedAt = performance.now();
    this.voiceDurationMs = segmentDurationMs;
  }

  /**
   * Whether the current voice-over segment has finished — the runtime equivalent
   * of the tour's `sndDonePlaying()` (`getTimer() >= bkgd.vo.targTime`). Driven by
   * the VO audio's own duration so the intro's VO-gated hold-loops advance in sync
   * with the narration, even when autoplay is blocked (the metadata still loads).
   */
  isVoiceDone(): boolean {
    if (!this.voice) return true;
    if (this.voice.ended) return true;
    const dur = this.voiceDurationMs || SoundController.FALLBACK_VO_MS;
    return performance.now() - this.voiceStartedAt >= dur;
  }

  private stopMusic() {
    this.music?.pause();
    this.music = null;
    this.musicSrc = "";
  }

  private stopVoice() {
    this.voice?.pause();
    this.voice = null;
    this.voiceStartedAt = 0;
    this.voiceDurationMs = 0;
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
