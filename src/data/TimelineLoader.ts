import type { AssetTimeline } from "./timelineTypes";
import { sceneNameFromSwf } from "./scenes";

const cache = new Map<string, AssetTimeline>();

/**
 * Fetch and cache a scene's decompiled timeline.json. Fills in default
 * frame-SVG paths when the build did not inline them, unless this is a
 * player-only bundle that intentionally omitted root frame composites.
 */
export async function loadTimeline(swf: string): Promise<AssetTimeline | null> {
  const cacheKey = swf.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const scene = sceneNameFromSwf(swf);
  const response = await fetch(`/generated/${scene}/timeline.json`);
  if (!response.ok) return null;

  // A scene with no generated assets (e.g. the restart button's `mslogo.swf`, or a
  // case-mismatched path) isn't a 404 under Vite — the dev/SPA server answers 200
  // with index.html. Parsing that as JSON throws, so treat any non-JSON body as a
  // missing scene and return null rather than crash the caller (runtime nav or prefetch).
  let timeline: AssetTimeline;
  try {
    timeline = (await response.json()) as AssetTimeline;
  } catch {
    return null;
  }
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
  return src.startsWith("/") ? src : `/${src}`;
}
