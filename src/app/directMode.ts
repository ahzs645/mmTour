// Direct SWF renderer wiring (parses the .swf in-browser via GsapSwfRenderer).

import { debugList, debugSummary, directSwfLayer, frameScrubber, referenceFrameMeta, status } from "./dom";
import { state as appState } from "./state";
import { GsapSwfRenderer } from "../engine/GsapSwfRenderer";
import { parseSwfFile } from "../engine/SwfParser";
import { isDirectRenderMode, updatePlayButton } from "./modes";
import { applyDepthHighlight, renderActionDebug, renderLabelDebug, renderStageDebug } from "./debugPanel";
import type { TourScene } from "../data/scenes";
import type { GsapDisplayDebugEntry } from "../gsap-display-list-renderer";

export function destroyDirectRenderer() {
  appState.directSwfRenderer?.destroy();
  appState.directSwfRenderer = null;
  appState.directSwfScene = "";
  appState.directSwfLoad = null;
}

export async function ensureDirectRenderer(scene: TourScene) {
  if (appState.directSwfRenderer && appState.directSwfScene === scene.swf) return appState.directSwfRenderer;
  if (appState.directSwfLoad && appState.directSwfScene === scene.swf) return appState.directSwfLoad;

  destroyDirectRenderer();
  appState.directSwfScene = scene.swf;
  status.textContent = `Parsing ${scene.swf} directly`;

  appState.directSwfLoad = parseSwfFile(`/${scene.swf}`)
    .then((movie) => {
      directSwfLayer.replaceChildren();
      const renderer = new GsapSwfRenderer(movie, directSwfLayer, {
        hiddenCharacterIds: scene.swf === "nav.swf" ? [8, 56] : [],
      });
      if (scene.swf === "nav.swf") {
        renderer.bootstrapMovie({
          tick: 2,
          globals: [{ path: "_level0.bkgd.OSVersion", value: "Per" }],
          functionName: "startAddedNav",
        });
      }
      renderer.onFrameChange = (frame) => {
        if (!isDirectRenderMode()) return;
        frameScrubber.max = String(renderer.totalFrames - 1);
        frameScrubber.value = String(frame);
        status.dataset.mode = renderer.isPlaying ? "playing" : "stopped";
        status.textContent = `${renderer.isPlaying ? "Playing" : "Ready at"} direct ${scene.swf} frame ${frame + 1}`;
        updateDirectDebugPanel(renderer, frame);
        updatePlayButton();
      };
      renderer.onPlaybackChange = (playing) => {
        if (!isDirectRenderMode()) return;
        appState.isGsapPlaying = playing;
        status.dataset.mode = playing ? "playing" : "stopped";
        status.textContent = `${playing ? "Playing" : "Ready at"} direct ${scene.swf} frame ${renderer.currentFrame + 1}`;
        updatePlayButton();
      };
      appState.directSwfRenderer = renderer;
      return renderer;
    })
    .catch((error) => {
      console.warn(`Direct SWF renderer failed to parse ${scene.swf}`, error);
      status.dataset.mode = "stopped";
      status.textContent = `Direct renderer failed for ${scene.swf}`;
      appState.directSwfRenderer = null;
      return null;
    })
    .finally(() => {
      appState.directSwfLoad = null;
    });

  return appState.directSwfLoad;
}

export async function renderDirectSwfFrame(frameIndex: number) {
  const renderer = await ensureDirectRenderer(appState.activeScene);
  if (!renderer || !isDirectRenderMode() || appState.directSwfScene !== appState.activeScene.swf) return;

  frameScrubber.max = String(renderer.totalFrames - 1);
  const frame = Math.max(0, Math.min(renderer.totalFrames - 1, frameIndex));
  renderer.seekToFrame(frame);
  updateDirectDebugPanel(renderer, frame);
}

export async function toggleDirectRendererPlayback() {
  const renderer = await ensureDirectRenderer(appState.activeScene);
  if (!renderer || !isDirectRenderMode()) return;

  if (renderer.isPlaying) {
    renderer.pause();
    appState.isGsapPlaying = false;
  } else {
    renderer.play();
    appState.isGsapPlaying = true;
  }
  updatePlayButton();
}

export async function restartDirectRenderer() {
  const renderer = await ensureDirectRenderer(appState.activeScene);
  if (!renderer || !isDirectRenderMode()) return;

  renderer.restart();
  frameScrubber.max = String(renderer.totalFrames - 1);
  frameScrubber.value = "0";
  appState.isGsapPlaying = false;
  updateDirectDebugPanel(renderer, 0);
  updatePlayButton();
}

export function updateDirectDebugPanel(renderer: GsapSwfRenderer, frameIndex = renderer.currentFrame) {
  if (!isDirectRenderMode()) return;

  const entries: GsapDisplayDebugEntry[] = renderer.getAllElements()
    .map(({ depth, charId, element }) => {
      element.dataset.depth = String(depth);
      return {
        depth,
        characterId: charId,
        kind: element.classList.contains("swf-text")
          ? "text"
          : element.classList.contains("swf-image")
            ? "image"
            : element.classList.contains("swf-sprite")
              ? "sprite"
              : "shape",
        name: "",
        placedFrame: frameIndex,
        isMask: element.style.visibility === "hidden",
        opacity: Number.parseFloat(element.style.opacity || "1"),
        src: "",
      };
    });

  debugSummary.textContent = `${entries.length} direct items`;
  if (appState.activeDebugTab === "stage") {
    renderStageDebug(appState.activeAssetTimeline, entries);
  } else if (appState.activeDebugTab === "labels") {
    if (appState.activeAssetTimeline) {
      renderLabelDebug(appState.activeAssetTimeline, frameIndex);
    } else {
      renderDirectMetadataDebug(renderer, "Direct SWF labels are evaluated internally by the renderer.");
    }
  } else {
    if (appState.activeAssetTimeline) {
      renderActionDebug(appState.activeAssetTimeline, frameIndex);
    } else {
      renderDirectMetadataDebug(renderer, "Direct SWF ActionScript is parsed at runtime for timeline control.");
    }
  }
  referenceFrameMeta.textContent = `Direct frame ${frameIndex + 1}`;
  applyDepthHighlight();
}

export function renderDirectMetadataDebug(renderer: GsapSwfRenderer, message: string) {
  debugList.replaceChildren();
  const item = document.createElement("div");
  item.className = "debug-empty";
  item.textContent = `${message} ${renderer.totalFrames} frames @ ${renderer.fps} fps.`;
  debugList.append(item);
}
