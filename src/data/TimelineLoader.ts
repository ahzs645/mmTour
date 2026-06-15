import type { AssetTimeline } from "./timelineTypes";
import { sceneNameFromSwf } from "./scenes";

const cache = new Map<string, AssetTimeline>();

/**
 * Fetch and cache a scene's decompiled timeline.json. Fills in default
 * frame-SVG paths when the build did not inline them.
 */
export async function loadTimeline(swf: string): Promise<AssetTimeline | null> {
  const cacheKey = swf.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const scene = sceneNameFromSwf(swf);
  const response = await fetch(`/generated/${scene}/timeline.json`);
  if (!response.ok) return null;

  const timeline = (await response.json()) as AssetTimeline;
  if (!timeline.frameSvgs?.length) {
    timeline.frameSvgs = Array.from(
      { length: timeline.frameCount },
      (_, index) => `generated/${timeline.scene}/frames/${index + 1}.svg`,
    );
  }
  cache.set(cacheKey, timeline);
  return timeline;
}

export function assetUrl(src: string): string {
  return src.startsWith("/") ? src : `/${src}`;
}
