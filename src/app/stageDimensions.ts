import type { AssetTimeline } from "./frameModeTypes";
import { assetStage, assetWrap } from "./dom";
import { state as appState } from "./state";

export function applyStageDimensions(assetTimeline: Pick<AssetTimeline, "dimensions">) {
  const width = Number(assetTimeline.dimensions?.width) || 640;
  const height = Number(assetTimeline.dimensions?.height) || 480;
  assetWrap.style.setProperty("--stage-aspect", `${width} / ${height}`);
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
