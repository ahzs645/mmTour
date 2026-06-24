import { assetUrl } from "../data/TimelineLoader";
import type { SoundTimingTable } from "../data/soundTimings";
import type { ControlAction } from "../data/timelineTypes";

/**
 * Plays the tour's extracted audio from frame actions: a single looping music
 * channel (attachSound role="music") and a single voiceover channel (playVO).
 * Browser autoplay policy means playback may only start after a user gesture.
 * Failed play attempts are retried on later gestures as long as the channel is
 * still current and the player has not been paused.
 */
export class SoundController {
  private music: HTMLAudioElement | null = null;
  private musicSrc = "";
  private musicOwner: number | string | undefined;
  private musicTarget = "";
  private voice: HTMLAudioElement | null = null;
  private voiceOwner: number | string | undefined;
  private voiceTarget = "";
  private voiceStartedAt = 0;
  private voiceDurationMs = 0;
  private pendingVoiceSegmentDurationMs = 0;
  private readonly timings = new Map<string, number>();
  private readonly pendingPlayback = new Set<HTMLAudioElement>();
  private readonly targetVolumes = new Map<string, number>();
  private muted = false;
  private suspended = false;
  private listening = false;
  private pendingMusicStop = 0;
  /** Used when a VO's metadata hasn't loaded yet (or audio is autoplay-blocked). */
  private static readonly FALLBACK_VO_MS = 5000;
  /** Marker-only VO segments do not carry their own media file duration. */
  private static readonly FALLBACK_SEGMENT_MS = 2500;
  private static readonly UNLOCK_EVENTS = ["pointerdown", "click", "keydown", "touchstart"] as const;

  constructor() {
    this.addUnlockListeners();
  }

  handle(action: ControlAction, owner?: number | string) {
    this.addUnlockListeners();
    switch (action.command) {
      case "attachSound":
        if (this.muted) break;
        if (!action.soundSrc) break;
        if (action.soundRole === "music") this.playMusic(action, owner);
        else if (action.soundRole === "vo") this.playVoice(action, owner);
        break;
      case "playVO":
        if (!this.muted && action.soundSrc) this.playVoice(action, owner);
        break;
      case "markSndSegment":
        this.markVoiceSegment(this.durationFor(action));
        break;
      case "stopSound":
        this.pendingVoiceSegmentDurationMs = 0;
        this.stopForAction(action);
        break;
      case "setVolume":
        this.setVolume(action);
        break;
      default:
        break;
    }
  }

  registerTimings(timings: SoundTimingTable | undefined) {
    for (const [name, timing] of Object.entries(timings ?? {})) {
      const durationMs = Number(timing.durationMs);
      if (name && Number.isFinite(durationMs) && durationMs > 0) this.timings.set(name, durationMs);
    }
  }

  private durationFor(action: ControlAction): number | undefined {
    const key = action.segment ?? action.sound;
    return (key ? this.timings.get(key) : undefined) ?? action.soundDurationMs;
  }

  private playMusic(action: ControlAction, owner?: number | string) {
    const src = action.soundSrc;
    if (!src) return;
    this.cancelPendingMusicStop();
    const volume = this.volumeFor(action.target, 0.5);
    if (this.musicSrc === src && this.music) {
      this.musicOwner = owner;
      this.musicTarget = normalizeSoundTarget(action.target);
      this.music.loop = true;
      this.music.volume = volume;
      this.tryPlay(this.music);
      return;
    }
    this.stopMusic();
    const audio = new Audio(assetUrl(src));
    audio.preload = "auto";
    audio.loop = true;
    audio.volume = volume;
    this.music = audio;
    this.musicSrc = src;
    this.musicOwner = owner;
    this.musicTarget = normalizeSoundTarget(action.target);
    this.tryPlay(audio);
  }

  private playVoice(action: ControlAction, owner?: number | string) {
    const src = action.soundSrc;
    if (!src) return;
    const durationMs = this.durationFor(action);
    const pendingSegmentDurationMs = this.pendingVoiceSegmentDurationMs;
    this.pendingVoiceSegmentDurationMs = 0;
    this.stopVoice();
    const audio = new Audio(assetUrl(src));
    audio.preload = "auto";
    audio.volume = this.volumeFor(action.target, 1);
    this.voiceStartedAt = performance.now();
    this.voiceDurationMs = pendingSegmentDurationMs || (durationMs && Number.isFinite(durationMs) ? durationMs : 0);
    audio.addEventListener("loadedmetadata", () => {
      if (!this.voiceDurationMs && Number.isFinite(audio.duration)) this.voiceDurationMs = audio.duration * 1000;
    });
    this.voice = audio;
    this.voiceOwner = owner;
    this.voiceTarget = normalizeSoundTarget(action.target);
    this.tryPlay(audio);
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
    this.cancelPendingMusicStop();
    const audio = this.music;
    if (audio) {
      this.pendingPlayback.delete(audio);
      audio.pause();
      resetAudio(audio);
    }
    this.music = null;
    this.musicSrc = "";
    this.musicOwner = undefined;
    this.musicTarget = "";
  }

  private stopVoice() {
    const audio = this.voice;
    if (audio) {
      this.pendingPlayback.delete(audio);
      audio.pause();
      resetAudio(audio);
    }
    this.voice = null;
    this.voiceOwner = undefined;
    this.voiceTarget = "";
    this.voiceStartedAt = 0;
    this.voiceDurationMs = 0;
  }

  private stopForAction(action: ControlAction) {
    const target = normalizeSoundTarget(action.target);
    const stopMusic = action.soundRole === "music" || (target && target === this.musicTarget);
    const stopVoice = action.soundRole === "vo" || !target || target === this.voiceTarget;
    if (stopMusic) this.scheduleMusicStop();
    if (stopVoice) this.stopVoice();
  }

  private setVolume(action: ControlAction) {
    const target = normalizeSoundTarget(action.target);
    if (!target) return;
    const volume = normalizeVolume(action.value);
    this.targetVolumes.set(target, volume);
    if (this.music && target === this.musicTarget) this.music.volume = volume;
    if (this.voice && target === this.voiceTarget) this.voice.volume = volume;
  }

  private volumeFor(target: string | undefined, fallback: number): number {
    const key = normalizeSoundTarget(target);
    return key ? (this.targetVolumes.get(key) ?? fallback) : fallback;
  }

  private scheduleMusicStop() {
    const token = this.pendingMusicStop + 1;
    this.pendingMusicStop = token;
    queueMicrotask(() => {
      if (this.pendingMusicStop !== token) return;
      this.pendingMusicStop = 0;
      this.stopMusic();
    });
  }

  private cancelPendingMusicStop() {
    this.pendingMusicStop = 0;
  }

  stopOwner(owner: number | string) {
    const stopsVoice = this.voiceOwner === owner;
    if (this.musicOwner === owner) this.stopMusic();
    if (stopsVoice) {
      this.pendingVoiceSegmentDurationMs = 0;
      this.stopVoice();
    }
  }

  /** Pause both channels (global pause) without forgetting the music track. */
  suspend() {
    this.suspended = true;
    this.music?.pause();
    this.voice?.pause();
  }

  resume() {
    this.suspended = false;
    if (this.music) this.tryPlay(this.music);
    if (this.voice) this.tryPlay(this.voice);
  }

  destroy() {
    this.removeUnlockListeners();
    this.pendingPlayback.clear();
    this.stopMusic();
    this.stopVoice();
    this.timings.clear();
    this.targetVolumes.clear();
  }

  private readonly retryPendingPlayback = () => {
    if (this.suspended || this.muted || !this.pendingPlayback.size) return;
    for (const audio of [...this.pendingPlayback]) this.tryPlay(audio);
  };

  private tryPlay(audio: HTMLAudioElement) {
    if (this.suspended || this.muted) return;
    const play = audio.play();
    if (!play?.then) return;
    void play.then(
      () => this.pendingPlayback.delete(audio),
      () => {
        if (this.isCurrentAudio(audio) && !this.suspended && !this.muted) this.pendingPlayback.add(audio);
        else this.pendingPlayback.delete(audio);
      },
    );
  }

  private isCurrentAudio(audio: HTMLAudioElement): boolean {
    return audio === this.music || audio === this.voice;
  }

  private addUnlockListeners() {
    if (this.listening || typeof document === "undefined") return;
    for (const event of SoundController.UNLOCK_EVENTS) {
      document.addEventListener(event, this.retryPendingPlayback, { capture: true, passive: true });
    }
    this.listening = true;
  }

  private removeUnlockListeners() {
    if (!this.listening || typeof document === "undefined") return;
    for (const event of SoundController.UNLOCK_EVENTS) {
      document.removeEventListener(event, this.retryPendingPlayback, { capture: true });
    }
    this.listening = false;
  }
}

function normalizeSoundTarget(target: string | undefined): string {
  return (target ?? "")
    .replace(/^_root\./i, "")
    .replace(/^_level0\./i, "")
    .replace(/^this\./i, "")
    .replace(/^self\./i, "");
}

function resetAudio(audio: HTMLAudioElement) {
  try {
    audio.currentTime = 0;
  } catch {
    /* Some media elements cannot seek before metadata is loaded. */
  }
}

function normalizeVolume(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n / 100));
}
