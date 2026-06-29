import type { AssetTimeline } from "./frameModeTypes";
import { assetStage, assetWrap, ruffleMount } from "./dom";
import { state as appState } from "./state";

export function applyStageDimensions(assetTimeline: Pick<AssetTimeline, "dimensions">) {
  const width = Number(assetTimeline.dimensions?.width) || 640;
  const height = Number(assetTimeline.dimensions?.height) || 480;
  assetWrap.style.setProperty("--stage-aspect", `${width} / ${height}`);
  // The Ruffle reference mount (`.stage-wrap`) sizes itself from `--stage-aspect` too, but it
  // is a sibling of `assetWrap`, so it never inherited the value and fell back to the default
  // 4/3 — letterboxing non-4/3 movies (e.g. bnl's 1000×850) to a SMALLER scale than the player
  // stage, so the two panels couldn't be compared 1:1 (Ruffle looked ~12% smaller, its content
  // higher). Give it the movie's real aspect so both panels render at the same scale.
  ruffleMount.style.setProperty("--stage-aspect", `${width} / ${height}`);
  assetStage.style.setProperty("--stage-width", `${width}px`);
  assetStage.style.setProperty("--stage-height", `${height}px`);
  syncAssetStageScale();
}

export function syncAssetStageScale() {
  const rect = assetWrap.getBoundingClientRect();
  const width = Number(appState.activeAssetTimeline?.dimensions?.width) || 640;
  const height = Number(appState.activeAssetTimeline?.dimensions?.height) || 480;
  const scale = Math.min(rect.width / width, rect.height / height);
  assetStage.style.setProperty("--stage-scale", String(scale));
}
