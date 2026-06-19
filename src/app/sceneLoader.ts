// Scene loading: fetch + activate a generated timeline, fonts, Ruffle, GSAP wiring.

import { gsap } from "gsap";
import {
  assetName, assetStage, awaitingLoopLayer, debugList, debugSummary, directSwfLayer,
  emptyMessage, externalLevelLayer, frameScrubber, frameStageImage, frameStageInline,
  referenceFrameImage, referenceFrameMeta, referenceName, renderModeSelect, ruffleName, select, status,
} from "./dom";
import {
  assetTimelineCache, gsapDisplayRenderer, loadedFontFaceKeys, loadedLevelSwfs, playedSpriteSoundKeys,
  playerController, state as appState,
} from "./state";
import { fontFamiliesForAsset } from "./fonts";
import { resolveSceneEntryFrame } from "./timelineQueries";
import { activatePlayerMode, isPlayerMode } from "./modes";
import { loadRuffle } from "./ruffle";
import { destroyDirectRenderer } from "./directMode";
import { clearExternalLevels } from "./externalLevels";
import { goToFrame, renderFrame } from "./frameMode";
import { clearButtonVisualState } from "./buttonOverlays";
import { stopAwaitingLoop } from "./spriteLoops";
import { stopCurrentVoiceover } from "./audio";
import { scenes, type TourScene } from "../data/scenes";
import { assetUrl, cacheKeyForSource, loadTimelineFromSource } from "../data/packedAssets";
import type { AssetTimeline, SceneEntryTarget, TimelineAsset } from "./frameModeTypes";

export async function loadScene(scene: TourScene, entryTarget?: SceneEntryTarget, preserveExternalLevels = false) {
  status.textContent = `Loading ${scene.swf}`;
  ruffleName.textContent = `${scene.length.toFixed(2)}s`;
  await loadAssetTimeline(scene, entryTarget, preserveExternalLevels);
  void loadRuffle(scene).catch((error) => {
    console.warn(`Ruffle reference failed to load ${scene.swf}`, error);
  });
}

export async function navigateToSceneBySwf(swf: string, entryTarget?: SceneEntryTarget) {
  const targetScene = scenes.find((scene) => scene.swf.toLowerCase() === swf.toLowerCase());
  if (!targetScene) {
    status.textContent = `Missing generated scene for ${swf}`;
    return;
  }

  appState.activeScene = targetScene;
  if (/^segment\d+\.swf$/i.test(targetScene.swf)) loadedLevelSwfs[4] = targetScene.swf;
  select.value = String(scenes.indexOf(appState.activeScene));
  await loadScene(appState.activeScene, entryTarget, true);
}

export async function loadAssetTimeline(scene: TourScene, entryTarget?: SceneEntryTarget, preserveExternalLevels = false) {
  appState.timeline?.kill();
  appState.activeAssetTimeline = null;
  playerController.deactivate();
  destroyDirectRenderer();
  stopAwaitingLoop();
  stopCurrentVoiceover();
  appState.lastSoundFrameKey = "";
  appState.lastFrameFunctionCallKey = "";
  playedSpriteSoundKeys.clear();
  appState.renderedInstances = new Map();
  assetStage.querySelectorAll(".asset-instance").forEach((node) => node.remove());
  gsapDisplayRenderer.clear();
  directSwfLayer.hidden = true;
  directSwfLayer.replaceChildren();
  externalLevelLayer.hidden = false;
  appState.highlightedDepth = null;
  frameStageImage.removeAttribute("src");
  frameStageInline.replaceChildren();
  referenceFrameImage.removeAttribute("src");
  referenceName.textContent = "No generated frame";
  referenceFrameMeta.textContent = "Frame 0";
  debugSummary.textContent = "";
  debugList.replaceChildren();
  if (!preserveExternalLevels) clearExternalLevels();
  clearButtonVisualState();
  awaitingLoopLayer.replaceChildren();
  assetStage.style.background = "#ffffff";
  emptyMessage.hidden = false;
  assetName.textContent = "No generated timeline";
  frameScrubber.max = "0";
  frameScrubber.value = "0";

  const loadedTimeline = await fetchAssetTimeline(scene.swf);
  if (!loadedTimeline) {
    status.textContent = `No extracted asset timeline for ${scene.swf}`;
    return;
  }

  appState.activeAssetTimeline = loadedTimeline;
  await loadExtractedFonts(appState.activeAssetTimeline);
  if (!appState.activeAssetTimeline.frameSvgsOmitted && !appState.activeAssetTimeline.frameSvgs?.length) {
    appState.activeAssetTimeline.frameSvgs = Array.from(
      { length: appState.activeAssetTimeline.frameCount },
      (_, index) => `generated/${appState.activeAssetTimeline!.scene}/frames/${index + 1}.svg`,
    );
  }
  appState.assetTimelineVersion += 1;
  // The decompiled player is the primary experience; other modes remain for
  // comparison via the dropdown.
  renderModeSelect.value = "player";
  const frameOption = [...renderModeSelect.options].find((option) => option.value === "frame");
  if (frameOption) frameOption.disabled = Boolean(appState.activeAssetTimeline.frameSvgsOmitted);
  assetStage.style.background = appState.activeAssetTimeline.backgroundColor ?? "#ffffff";
  frameScrubber.max = String(appState.activeAssetTimeline.frameCount - 1);
  const entryFrame = resolveSceneEntryFrame(appState.activeAssetTimeline, entryTarget);
  emptyMessage.hidden = true;
  assetName.textContent = `${appState.activeAssetTimeline.frameCount} frames @ ${appState.activeAssetTimeline.fps} fps`;
  // Build the flat GSAP timeline that the legacy comparison modes depend on.
  buildGsapAssetPlayer(appState.activeAssetTimeline);
  frameScrubber.value = String(entryFrame);
  if (isPlayerMode()) {
    activatePlayerMode();
  } else {
    goToFrame(entryFrame, false);
  }
}

export async function fetchAssetTimeline(swf: string) {
  const cacheKey = cacheKeyForSource(swf.toLowerCase());
  const cached = assetTimelineCache.get(cacheKey);
  if (cached) return cached;

  const sceneName = swf.replace(/\.swf$/i, "");
  const assetTimeline = (await loadTimelineFromSource(sceneName)) as AssetTimeline | null;
  if (!assetTimeline) return null;
  if (!assetTimeline.frameSvgsOmitted && !assetTimeline.frameSvgs?.length) {
    assetTimeline.frameSvgs = Array.from(
      { length: assetTimeline.frameCount },
      (_, index) => `generated/${assetTimeline.scene}/frames/${index + 1}.svg`,
    );
  }
  assetTimelineCache.set(cacheKey, assetTimeline);
  return assetTimeline;
}

export async function loadExtractedFonts(assetTimeline: AssetTimeline) {
  if (!("fonts" in document)) return;

  const fontAssets = Object.values(assetTimeline.assets ?? {})
    .filter((asset) => asset.kind === "font" && asset.src);
  if (!fontAssets.length) return;

  const loads: Promise<void>[] = [];
  for (const asset of fontAssets) {
    if (!asset.src) continue;
    const families = fontFamiliesForAsset(asset);
    for (const family of families) {
      const key = `${family}:${asset.src}`;
      if (loadedFontFaceKeys.has(key)) continue;
      loadedFontFaceKeys.add(key);
      const face = new FontFace(family, `url("${encodeURI(assetUrl(asset.src))}")`, {
        style: "normal",
        weight: family.includes("Medium") ? "700" : "400",
      });
      loads.push(face.load().then((loadedFace) => {
        document.fonts.add(loadedFace);
      }));
    }
  }

  await Promise.allSettled(loads);
}

export function buildGsapAssetPlayer(assetTimeline: AssetTimeline) {
  const state = { frame: 0 };
  const setFrame = () => {
    const frame = Math.round(state.frame);
    frameScrubber.value = String(frame);
    renderFrame(assetTimeline, frame);
  };

  setFrame();
  appState.timeline = gsap.timeline({ repeat: -1, paused: true });
  appState.timeline.to(state, {
    frame: assetTimeline.frames.length - 1,
    duration: assetTimeline.duration,
    ease: `steps(${assetTimeline.frames.length - 1})`,
    onUpdate: setFrame,
    onRepeat: setFrame,
  });
}
