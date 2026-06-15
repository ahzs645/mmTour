import { assetUrl } from "../data/TimelineLoader";
import type { AssetTimeline } from "../data/timelineTypes";

/**
 * Registers each scene's embedded fonts as @font-face faces (family
 * `swf-font-<id>`) so dynamic/edit text can render in its original typeface,
 * and resolves a CSS font stack for a given DefineEditText fontId.
 */
export class FontRegistry {
  private registered = new Set<number>();
  private families = new Map<number, string>();

  register(timeline: AssetTimeline) {
    if (!("fonts" in document)) return;
    for (const asset of Object.values(timeline.assets ?? {})) {
      if (asset.kind !== "font" || !asset.src) continue;
      const family = `swf-font-${asset.id}`;
      this.families.set(asset.id, family);
      if (this.registered.has(asset.id)) continue;
      this.registered.add(asset.id);
      // Font filenames often contain spaces (e.g. "47_Franklin Gothic.ttf");
      // encode the URL so the FontFace fetch doesn't silently fail.
      const face = new FontFace(family, `url("${encodeURI(assetUrl(asset.src))}")`);
      face
        .load()
        .then((loaded) => document.fonts.add(loaded))
        .catch(() => {
          /* font missing/undecodable — fall back to the CSS stack */
        });
    }
  }

  resolveFamily(fontId?: number): string | undefined {
    if (fontId == null) return undefined;
    const family = this.families.get(fontId);
    return family ? `"${family}", Arial, Helvetica, sans-serif` : undefined;
  }
}
