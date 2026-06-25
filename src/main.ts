import type { RuffleElement } from "./app/frameModeTypes";
import type { CompiledScene } from "./convert/compileScene.ts";

declare global {
  interface Window {
    RufflePlayer?: {
      newest: () => {
        createPlayer: () => RuffleElement;
      };
    };
  }
}

let mounted = false;
let handle: ConversionLabHandle | null = null;

export type ConversionLabHandle = {
  compareCompiledSwf: (input: { name: string; compiled: CompiledScene; ruffleUrl: string }) => Promise<void>;
};

export async function mountConversionLab(container: HTMLElement, options: { includeHeader?: boolean } = {}): Promise<ConversionLabHandle> {
  if (mounted && handle) return handle;
  mounted = true;

  const dom = await import("./app/dom");
  dom.mountConversionLabDom(container, options);

  const { scenes } = await import("./data/scenes");
  const { assetTimelineCache, loadedFontFaceKeys, playerController, state: appState } = await import("./app/state");
  const { loadRuffle } = await import("./app/ruffle");
  const { activatePlayerMode, isDirectRenderMode, isPlayerMode, updatePlayButton } = await import("./app/modes");
  const directMode = await import("./app/directMode");
  const debugPanel = await import("./app/debugPanel");
  const { shouldStopAtFrame } = await import("./app/runtimeActions");
  const { loadScene } = await import("./app/sceneLoader");
  const { goToFrame, renderFrame } = await import("./app/frameMode");
  const { syncAssetStageScale } = await import("./app/stageDimensions");
  const packedAssets = await import("./data/packedAssets.ts");
  const { clearTimelineCache } = await import("./data/TimelineLoader");

  dom.renderModeSelect.selectedIndex = 0;
  dom.renderModeSelect.value = "player";
  dom.assetSourceSelect.value = "files";

  const stageResizeObserver = new ResizeObserver(syncAssetStageScale);

  dom.select.innerHTML = scenes.map((scene, index) => `<option value="${index}">${scene.label} - ${scene.swf}</option>`).join("");
  dom.select.value = String(scenes.indexOf(appState.activeScene));

  dom.select.addEventListener("change", () => {
    appState.activeScene = scenes[Number(dom.select.value)] ?? scenes[0];
    void loadScene(appState.activeScene);
  });

  dom.assetSourceSelect.addEventListener("change", () => {
    packedAssets.setAssetSource(dom.assetSourceSelect.value as import("./data/packedAssets.ts").AssetSource);
    assetTimelineCache.clear();
    loadedFontFaceKeys.clear();
    void loadScene(appState.activeScene);
  });

  dom.restartBtn.addEventListener("click", () => {
    if (isPlayerMode()) {
      playerController.restart();
    } else if (isDirectRenderMode()) {
      void directMode.restartDirectRenderer();
    } else {
      goToFrame(appState.activeAssetTimeline?.entryFrame ?? 0, false);
    }
    void loadRuffle(appState.activeScene).catch((error) => {
      console.warn(`Ruffle reference failed to reload ${appState.activeScene.swf}`, error);
    });
  });

  dom.playBtn.addEventListener("click", () => {
    if (isPlayerMode()) {
      playerController.toggle();
      dom.playBtn.textContent = playerController.isPlaying ? "Pause" : "Play GSAP";
      return;
    }

    if (isDirectRenderMode()) {
      void directMode.toggleDirectRendererPlayback();
      return;
    }

    if (!appState.timeline || appState.isAwaitingSelection) return;
    if (appState.isGsapPlaying) {
      appState.isGsapPlaying = false;
      updatePlayButton();
      appState.timeline.pause();
      return;
    }

    const currentFrame = Number(dom.frameScrubber.value);
    const startFrame = appState.activeAssetTimeline && shouldStopAtFrame(appState.activeAssetTimeline, currentFrame)
      ? Math.min(currentFrame + 1, appState.activeAssetTimeline.frameCount - 1)
      : currentFrame;
    goToFrame(startFrame, true);
  });

  dom.frameScrubber.addEventListener("input", () => {
    if (isPlayerMode()) {
      playerController.seekRootFrame(Number(dom.frameScrubber.value));
      dom.playBtn.textContent = "Play GSAP";
      return;
    }

    if (isDirectRenderMode()) {
      appState.isGsapPlaying = false;
      updatePlayButton();
      void directMode.renderDirectSwfFrame(Number(dom.frameScrubber.value));
      return;
    }

    if (!appState.activeAssetTimeline || !appState.timeline) return;
    appState.isGsapPlaying = false;
    dom.playBtn.textContent = "Play GSAP";
    const frame = Number(dom.frameScrubber.value);
    goToFrame(frame, false);
  });

  dom.renderModeSelect.addEventListener("change", () => {
    if (!appState.activeAssetTimeline) return;
    if (isPlayerMode()) {
      activatePlayerMode();
      return;
    }
    if (playerController.active) {
      playerController.deactivate();
      dom.externalLevelLayer.hidden = false;
    }
    renderFrame(appState.activeAssetTimeline, Number(dom.frameScrubber.value));
  });

  dom.infoBtn.addEventListener("click", () => dom.infoModal.showModal());
  dom.infoModal.addEventListener("click", (event) => {
    if (event.target === dom.infoModal) dom.infoModal.close();
  });

  container.querySelectorAll<HTMLButtonElement>(".debug-tab").forEach((button) => {
    button.addEventListener("click", () => {
      appState.activeDebugTab = (button.dataset.debugTab as typeof appState.activeDebugTab | undefined) ?? "stage";
      container.querySelectorAll<HTMLButtonElement>(".debug-tab").forEach((tab) => {
        tab.classList.toggle("is-active", tab === button);
      });
      const live = appState.activeDebugTab === "live";
      const trace = appState.activeDebugTab === "trace";
      dom.liveFilters.hidden = !live;
      dom.liveDetail.hidden = !live;
      dom.traceBar.hidden = !trace;
      if (!live) debugPanel.clearLiveHighlights();
      if (live) {
        debugPanel.initLiveFilters();
        debugPanel.renderLiveDebug();
        debugPanel.startLiveDebugLoop();
        return;
      }
      if (trace) {
        debugPanel.initTrace();
        debugPanel.renderTraceDebug();
        return;
      }
      if (isDirectRenderMode() && appState.directSwfRenderer) {
        directMode.updateDirectDebugPanel(appState.directSwfRenderer);
        return;
      }
      debugPanel.updateDebugPanel();
    });
  });

  void loadScene(appState.activeScene);
  stageResizeObserver.observe(dom.assetWrap);

  handle = {
    async compareCompiledSwf({ name, compiled, ruffleUrl }) {
      packedAssets.setAssetSource("pack");
      packedAssets.registerPackedScene(compiled.scene, compiled.files, compiled.timeline);
      clearTimelineCache();
      assetTimelineCache.clear();
      loadedFontFaceKeys.clear();

      const swf = `${compiled.scene}.swf`;
      const existingIndex = scenes.findIndex((scene) => scene.swf === swf);
      const comparableScene = {
        swf,
        label: name.replace(/\.swf$/i, ""),
        length: compiled.timeline.duration,
        ruffleUrl,
      };
      if (existingIndex >= 0) scenes[existingIndex] = comparableScene;
      else scenes.push(comparableScene);

      dom.select.innerHTML = scenes.map((scene, index) => `<option value="${index}">${scene.label} - ${scene.swf}</option>`).join("");
      appState.activeScene = scenes[existingIndex >= 0 ? existingIndex : scenes.length - 1] ?? comparableScene;
      dom.select.value = String(scenes.indexOf(appState.activeScene));
      dom.assetSourceSelect.value = "pack";
      await loadScene(appState.activeScene);
    },
  };
  return handle;
}
