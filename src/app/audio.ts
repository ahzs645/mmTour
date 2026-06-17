// Voice-over / background-music playback for the comparison render modes.

import { state as appState } from "./state";
import type { ControlAction } from "./frameModeTypes";

export async function playVoiceover(action: ControlAction) {
  if (!action.soundSrc) return;
  stopCurrentVoiceover();

  const audio = new Audio(`/${action.soundSrc}`);
  audio.preload = "auto";
  appState.currentVoiceover = audio;
  await audio.play();
}

export async function playBackgroundMusic(action: ControlAction) {
  if (!action.soundSrc || appState.currentMusic?.dataset.sound === action.sound) return;
  stopCurrentMusic();

  const audio = new Audio(`/${action.soundSrc}`);
  audio.preload = "auto";
  audio.loop = true;
  audio.volume = 0.35;
  audio.dataset.sound = action.sound ?? "";
  appState.currentMusic = audio;
  await audio.play();
}

export function stopCurrentVoiceover() {
  if (!appState.currentVoiceover) return;
  appState.currentVoiceover.pause();
  appState.currentVoiceover.currentTime = 0;
  appState.currentVoiceover = null;
}

export function stopCurrentMusic() {
  if (!appState.currentMusic) return;
  appState.currentMusic.pause();
  appState.currentMusic.currentTime = 0;
  appState.currentMusic = null;
}
