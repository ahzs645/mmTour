// Shared render-mode helpers + the Decompiled Player activation.

import type { AssetTimeline as DecompiledTimeline } from "../data/timelineTypes";
import {
  assetStage, awaitingLoopLayer, directSwfLayer, emptyMessage, frameScrubber,
  frameStageImage, frameStageInline, gsapDisplayLayer, playBtn, renderModeSelect,
} from "./dom";
import { gsapDisplayRenderer, playerController, state as appState } from "./state";

export function isPlayerMode() {
  return renderModeSelect.value === "player";
}

export function activatePlayerMode() {
  if (!appState.activeAssetTimeline) return;
  appState.timeline?.pause();
  appState.isGsapPlaying = false;
  appState.directSwfRenderer?.pause();
  directSwfLayer.hidden = true;
  // Hide every other render surface; the player owns its own layer.
  frameStageImage.hidden = true;
  frameStageInline.replaceChildren();
  assetStage.querySelectorAll(".asset-instance").forEach((node) => node.remove());
  appState.renderedInstances.clear();
  gsapDisplayRenderer.clear();
  gsapDisplayLayer.hidden = true;
  awaitingLoopLayer.replaceChildren();
  emptyMessage.hidden = true;
  playerController.activate(appState.activeAssetTimeline as unknown as DecompiledTimeline, appState.activeScene.swf);
  frameScrubber.max = String(playerController.frameCount - 1);
  frameScrubber.value = String(playerController.currentFrame);
  // Autoplay like Ruffle: the root holds on its menu stop() while nested clips
  // (icon attract animations) play and loop on their own playheads.
  playerController.play();
  updatePlayButton();
}

export function isDirectRenderMode() {
  return renderModeSelect.value === "direct";
}

export function updatePlayButton() {
  if (isPlayerMode()) {
    playBtn.disabled = false;
    playBtn.textContent = playerController.isPlaying ? "Pause" : "Play GSAP";
    return;
  }

  if (isDirectRenderMode()) {
    playBtn.disabled = false;
    playBtn.textContent = appState.isGsapPlaying ? "Pause Direct" : "Play Direct";
    return;
  }

  playBtn.disabled = appState.isAwaitingSelection || appState.isNestedSectionActive;
  playBtn.textContent = appState.isNestedSectionActive ? "Section Playing" : appState.isAwaitingSelection ? "Awaiting Choice" : appState.isGsapPlaying ? "Pause GSAP" : "Play GSAP";
}
