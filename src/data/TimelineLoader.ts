import type { AssetTimeline } from "./timelineTypes";
import { sceneNameFromSwf } from "./scenes";
import { assetUrl as resolveAssetUrl, cacheKeyForSource, loadTimelineFromSource } from "./packedAssets";

const cache = new Map<string, AssetTimeline>();

/**
 * Fetch and cache a scene's decompiled timeline.json. Fills in default
 * frame-SVG paths when the build did not inline them, unless this is a
 * player-only bundle that intentionally omitted root frame composites.
 */
export async function loadTimeline(swf: string): Promise<AssetTimeline | null> {
  const cacheKey = cacheKeyForSource(swf.toLowerCase());
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const scene = sceneNameFromSwf(swf);
  const timeline = await loadTimelineFromSource(scene);
  if (!timeline) return null;
  if (!timeline.frameSvgsOmitted && !timeline.frameSvgs?.length) {
    timeline.frameSvgs = Array.from(
      { length: timeline.frameCount },
      (_, index) => `generated/${timeline.scene}/frames/${index + 1}.svg`,
    );
  }
  cache.set(cacheKey, timeline);
  return timeline;
}

export function assetUrl(src: string): string {
  return resolveAssetUrl(src);
}
