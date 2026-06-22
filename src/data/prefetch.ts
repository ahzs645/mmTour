import type { AssetTimeline, ControlAction } from "./timelineTypes";
import { assetUrl, loadTimeline } from "./TimelineLoader";

const SWF = /\.swf$/i;

/**
 * Every OTHER SWF a timeline can navigate to — the targets of its button releases
 * and frame `loadMovie`/`doRelease` actions (e.g. the nav's five section buttons
 * each point at a `segmentN.swf`). These are exactly the scenes a section change
 * will pull into a content level moments later.
 */
export function collectReferencedSwfs(timeline: AssetTimeline): string[] {
  const swfs = new Set<string>();
  const add = (action?: ControlAction) => {
    if (!action) return;
    if (action.swf && SWF.test(action.swf)) swfs.add(action.swf);
    if (action.exitNavigation?.swf && SWF.test(action.exitNavigation.swf)) swfs.add(action.exitNavigation.swf);
    for (const load of action.loads ?? []) if (SWF.test(load.swf)) swfs.add(load.swf);
  };
  for (const record of Object.values(timeline.control?.buttonActions ?? {})) {
    add(record.release);
    add(record.rollOver);
    add(record.rollOut);
    add(record.press);
  }
  for (const frame of timeline.control?.frameActions ?? []) {
    for (const action of frame.actions ?? []) add(action);
  }
  return [...swfs];
}

/**
 * Warm the browser cache for a scene — its (multi-MB) `timeline.json` plus the
 * images that paint on its first frame — so a later `loadMovie` into a level can
 * paint near-instantly, like Ruffle's local-SWF section swaps. Without this a cold
 * section change fetches everything on click and the bare stage shows through for a
 * beat (e.g. the bottom bar flashing white while the nav has already stripped its
 * own toolbar mid-exit). Fire-and-forget; failures are ignored.
 */
export async function prefetchScene(swf: string): Promise<void> {
  const timeline = await loadTimeline(swf); // fills TimelineLoader's cache
  if (timeline) warmFrameImages(timeline, 0);
}

/** Fetch (cache-warm) the image assets a given frame places — the first frame's
 *  background/bar/art, so they decode the instant the scene is shown. */
function warmFrameImages(timeline: AssetTimeline, frame: number): void {
  for (const instance of timeline.frames[frame]?.instances ?? []) {
    const asset = timeline.assets[String(instance.characterId)];
    const src = asset?.src ?? asset?.frames?.[0] ?? asset?.states?.up?.src;
    if (src) void fetch(assetUrl(src)).catch(() => {});
  }
}
