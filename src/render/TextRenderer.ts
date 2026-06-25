import { assetUrl } from "../data/TimelineLoader";
import type { AssetTimeline } from "../data/timelineTypes";

/**
 * Registers each scene's embedded fonts as @font-face faces and resolves a CSS
 * stack for a text field's fontId. The tour's edit-text fields are
 * useOutlines=true (embedded), so — like Ruffle — we render the embedded font
 * (e.g. the condensed Franklin Gothic Medium); a system sans is the fallback if
 * the extracted face fails to load.
 */
export class FontRegistry {
  private registered = new Set<number>();
  private readonly families = new Map<number, string>();

  register(timeline: AssetTimeline) {
    const canEmbed = "fonts" in document;
    for (const asset of Object.values(timeline.assets ?? {})) {
      if (asset.kind !== "font" || !asset.src) continue;
      const file = asset.src.split("/").pop() ?? "";
      const name = asset.fontName ?? file.replace(/\.ttf$/i, "").replace(/^\d+_/, "").trim();
      const embedded = `swf-font-${asset.id}`;
      // Prefer the embedded face, then the font's real name (if installed), then sans.
      this.families.set(asset.id, `"${embedded}", "${name}", Arial, Helvetica, sans-serif`);

      if (!canEmbed || asset.fontLoadable === false || this.registered.has(asset.id)) continue;
      this.registered.add(asset.id);
      // Filenames often contain spaces (e.g. "47_Franklin Gothic.ttf") → encode.
      const face = new FontFace(embedded, `url("${encodeURI(assetUrl(asset.src))}")`);
      face
        .load()
        .then((loaded) => document.fonts.add(loaded))
        .catch(() => {
          /* extraction failed — the CSS fallback stack still applies */
        });
    }
  }

  resolveFamily(fontId?: number): string | undefined {
    if (fontId == null) return undefined;
    return this.families.get(fontId);
  }
}
