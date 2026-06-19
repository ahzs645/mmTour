import { scenes } from "./data/scenes";
import {
  assetSourceSelect, assetWrap, externalLevelLayer, frameScrubber, infoBtn, infoModal, liveDetail, liveFilters, playBtn,
  renderModeSelect, restartBtn, select, traceBar,
} from "./app/dom";
import { assetTimelineCache, loadedFontFaceKeys, playerController, state as appState } from "./app/state";
import type { RuffleElement } from "./app/frameModeTypes";
import { loadRuffle } from "./app/ruffle";
import { activatePlayerMode, isDirectRenderMode, isPlayerMode, updatePlayButton } from "./app/modes";
import {
  renderDirectSwfFrame, restartDirectRenderer, toggleDirectRendererPlayback, updateDirectDebugPanel,
} from "./app/directMode";
import {
  clearLiveHighlights, initLiveFilters, initTrace, renderLiveDebug, renderTraceDebug,
  startLiveDebugLoop, updateDebugPanel,
} from "./app/debugPanel";
import { shouldStopAtFrame } from "./app/runtimeActions";
import { loadScene } from "./app/sceneLoader";
import { goToFrame, renderFrame, syncAssetStageScale } from "./app/frameMode";
import { setAssetSource, type AssetSource } from "./data/packedAssets";

declare global {
  interface Window {
    RufflePlayer?: {
      newest: () => {
        createPlayer: () => RuffleElement;
      };
    };
  }
}

renderModeSelect.selectedIndex = 0;
renderModeSelect.value = "player";
assetSourceSelect.value = "files";

const stageResizeObserver = new ResizeObserver(syncAssetStageScale);

select.innerHTML = scenes.map((scene, index) => `<option value="${index}">${scene.label} - ${scene.swf}</option>`).join("");
select.value = String(scenes.indexOf(appState.activeScene));

select.addEventListener("change", () => {
  appState.activeScene = scenes[Number(select.value)] ?? scenes[0];
  void loadScene(appState.activeScene);
});

assetSourceSelect.addEventListener("change", () => {
  setAssetSource(assetSourceSelect.value as AssetSource);
  assetTimelineCache.clear();
  loadedFontFaceKeys.clear();
  void loadScene(appState.activeScene);
});

restartBtn.addEventListener("click", () => {
  if (isPlayerMode()) {
    playerController.restart();
  } else if (isDirectRenderMode()) {
    void restartDirectRenderer();
  } else {
    goToFrame(appState.activeAssetTimeline?.entryFrame ?? 0, false);
  }
  void loadRuffle(appState.activeScene).catch((error) => {
    console.warn(`Ruffle reference failed to reload ${appState.activeScene.swf}`, error);
  });
});

playBtn.addEventListener("click", () => {
  if (isPlayerMode()) {
    playerController.toggle();
    playBtn.textContent = playerController.isPlaying ? "Pause" : "Play GSAP";
    return;
  }

  if (isDirectRenderMode()) {
    void toggleDirectRendererPlayback();
    return;
  }

  if (!appState.timeline || appState.isAwaitingSelection) return;
  if (appState.isGsapPlaying) {
    appState.isGsapPlaying = false;
    updatePlayButton();
    appState.timeline.pause();
    return;
  }

  const currentFrame = Number(frameScrubber.value);
  const startFrame = appState.activeAssetTimeline && shouldStopAtFrame(appState.activeAssetTimeline, currentFrame)
    ? Math.min(currentFrame + 1, appState.activeAssetTimeline.frameCount - 1)
    : currentFrame;
  goToFrame(startFrame, true);
});

frameScrubber.addEventListener("input", () => {
  if (isPlayerMode()) {
    playerController.seekRootFrame(Number(frameScrubber.value));
    playBtn.textContent = "Play GSAP";
    return;
  }

  if (isDirectRenderMode()) {
    appState.isGsapPlaying = false;
    updatePlayButton();
    void renderDirectSwfFrame(Number(frameScrubber.value));
    return;
  }

  if (!appState.activeAssetTimeline || !appState.timeline) return;
  appState.isGsapPlaying = false;
  playBtn.textContent = "Play GSAP";
  const frame = Number(frameScrubber.value);
  goToFrame(frame, false);
});

renderModeSelect.addEventListener("change", () => {
  if (!appState.activeAssetTimeline) return;
  if (isPlayerMode()) {
    activatePlayerMode();
    return;
  }
  if (playerController.active) {
    playerController.deactivate();
    externalLevelLayer.hidden = false;
  }
  renderFrame(appState.activeAssetTimeline, Number(frameScrubber.value));
});

infoBtn.addEventListener("click", () => infoModal.showModal());
infoModal.addEventListener("click", (event) => {
  // Click on the backdrop (the dialog element itself, outside its content) closes it.
  if (event.target === infoModal) infoModal.close();
});

document.querySelectorAll<HTMLButtonElement>(".debug-tab").forEach((button) => {
  button.addEventListener("click", () => {
    appState.activeDebugTab = (button.dataset.debugTab as typeof appState.activeDebugTab | undefined) ?? "stage";
    document.querySelectorAll<HTMLButtonElement>(".debug-tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab === button);
    });
    const live = appState.activeDebugTab === "live";
    const trace = appState.activeDebugTab === "trace";
    liveFilters.hidden = !live;
    liveDetail.hidden = !live;
    traceBar.hidden = !trace;
    if (!live) clearLiveHighlights(); // drop stage outlines when leaving Live
    if (live) {
      initLiveFilters();
      renderLiveDebug();
      startLiveDebugLoop();
      return;
    }
    if (trace) {
      initTrace();
      renderTraceDebug();
      return;
    }
    if (isDirectRenderMode() && appState.directSwfRenderer) {
      updateDirectDebugPanel(appState.directSwfRenderer);
      return;
    }
    updateDebugPanel();
  });
});

void loadScene(appState.activeScene);
stageResizeObserver.observe(assetWrap);
