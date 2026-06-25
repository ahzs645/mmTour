import type { RuffleElement } from "./app/frameModeTypes";
import type { CompiledScene } from "./convert/compileScene.ts";
import type { TourScene } from "./data/scenes";

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

/** One converted scene the studio offers up for Ruffle comparison. */
export type ComparableScene = {
  name: string;
  compiled: CompiledScene;
  /** Object URL of the original SWF bytes, played as the Ruffle reference. */
  ruffleUrl?: string;
};

export type ConversionLabHandle = {
  /**
   * Replace the Compare workspace's scene list with the studio's converted
   * library and focus one of them. Every scene plays from its own pack and,
   * when available, its original SWF bytes drive Ruffle — so any converted SWF
   * shows a reference without depending on a file living on the server.
   */
  showComparableScenes: (items: ComparableScene[], activeSwf?: string) => Promise<void>;
};

export async function mountConversionLab(container: HTMLElement, options: { includeHeader?: boolean; autoLoad?: boolean } = {}): Promise<ConversionLabHandle> {
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

  // The studio drives the scene list via showComparableScenes(); only the
  // standalone lab auto-loads a default bundled scene on mount.
  if (options.autoLoad !== false) void loadScene(appState.activeScene);
  stageResizeObserver.observe(dom.assetWrap);

  handle = {
    async showComparableScenes(items, activeSwf) {
      packedAssets.setAssetSource("pack");

      // Rebuild the comparable list straight from the studio's converted
      // library, in place so every module that imported `scenes` sees it.
      const rebuilt: TourScene[] = items.map(({ name, compiled, ruffleUrl }) => {
        packedAssets.registerPackedScene(compiled.scene, compiled.files, compiled.timeline);
        return {
          swf: `${compiled.scene}.swf`,
          label: name.replace(/\.swf$/i, ""),
          length: compiled.timeline?.duration ?? 0,
          ruffleUrl,
        };
      });
      scenes.splice(0, scenes.length, ...rebuilt);
      clearTimelineCache();
      assetTimelineCache.clear();
      loadedFontFaceKeys.clear();
      dom.assetSourceSelect.value = "pack";
      dom.select.innerHTML = scenes
        .map((scene, index) => `<option value="${index}">${scene.label} - ${scene.swf}</option>`)
        .join("");

      if (!scenes.length) {
        appState.activeAssetTimeline = null;
        appState.rufflePlayer = null;
        dom.ruffleMount.replaceChildren();
        dom.ruffleName.textContent = "";
        dom.assetName.textContent = "No converted scene";
        dom.status.textContent = "Convert a SWF in the Convert tab to compare it here.";
        dom.emptyMessage.hidden = false;
        dom.emptyMessage.textContent = "Convert a SWF to compare it against the Ruffle reference here.";
        return;
      }

      // Keep the scene already on screen unless the caller asks for a specific
      // one — so finishing a background convert doesn't yank the view away.
      const wanted = (activeSwf ?? appState.activeScene?.swf ?? "").toLowerCase();
      const targetIndex = scenes.findIndex((scene) => scene.swf.toLowerCase() === wanted);
      const target = scenes[targetIndex >= 0 ? targetIndex : scenes.length - 1];
      const alreadyShown = !activeSwf
        && Boolean(appState.activeAssetTimeline)
        && target.swf.toLowerCase() === (appState.activeScene?.swf ?? "").toLowerCase();
      appState.activeScene = target;
      dom.select.value = String(scenes.indexOf(target));
      if (!alreadyShown) await loadScene(target);
    },
  };
  return handle;
}
