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
  private style: HTMLStyleElement | undefined;
  private cssRules = new Set<string>();
  private loads: Promise<unknown>[] = [];

  /** Resolves once every embedded face registered so far has loaded (or failed).
   *  Data-driven apps measure `textWidth` to lay themselves out, so the bootstrap
   *  waits on this — otherwise a one-shot layout that runs before the font loads
   *  measures the fallback face and never corrects (e.g. the bnl top-nav drifting). */
  ready(): Promise<void> {
    return Promise.allSettled(this.loads).then(() => undefined);
  }

  register(timeline: AssetTimeline) {
    const fonts = Object.values(timeline.assets ?? {}).filter((asset) => asset.kind === "font" && asset.src);
    const loadableByName = new Map<string, { family: string; byteLength: number }>();
    const loadableByNormalizedName = new Map<string, { family: string; byteLength: number }>();
    for (const asset of fonts) {
      const file = asset.src!.split("/").pop() ?? "";
      const name = asset.fontName ?? file.replace(/\.ttf$/i, "").replace(/^\d+_/, "").trim();
      if (asset.fontLoadable !== false) {
        rememberLoadableFont(loadableByName, name, `swf-font-${asset.id}`, asset.byteLength);
        rememberLoadableFont(loadableByNormalizedName, normalizeFontName(name), `swf-font-${asset.id}`, asset.byteLength);
      }
    }

    for (const asset of fonts) {
      if (asset.kind !== "font" || !asset.src) continue;
      const file = asset.src.split("/").pop() ?? "";
      const name = asset.fontName ?? file.replace(/\.ttf$/i, "").replace(/^\d+_/, "").trim();
      const embedded = `swf-font-${asset.id}`;
      const sameNameFallback = asset.fontLoadable === false
        ? (loadableByNormalizedName.get(normalizeFontName(name)) ?? loadableByName.get(name))?.family
        : undefined;
      // Prefer the embedded face, then the font's real name (if installed), then sans.
      this.families.set(asset.id, `${sameNameFallback ? `"${sameNameFallback}", ` : ""}"${embedded}", "${name}", Arial, Helvetica, sans-serif`);

      if (asset.fontLoadable === false || this.registered.has(asset.id)) continue;
      this.registered.add(asset.id);
      // Filenames often contain spaces (e.g. "47_Franklin Gothic.ttf") → encode.
      const url = encodeURI(assetUrl(asset.src));
      this.addCssFace(embedded, url);
      if (typeof FontFace !== "undefined" && typeof document.fonts?.add === "function") {
        const face = new FontFace(embedded, `url("${url}")`);
        this.loads.push(
          face
            .load()
            .then((loaded) => document.fonts.add(loaded))
            .catch(() => {
              /* extraction failed — the CSS fallback stack still applies */
            }),
        );
      }
    }
  }

  resolveFamily(fontId?: number): string | undefined {
    if (fontId == null) return undefined;
    return this.families.get(fontId);
  }

  private addCssFace(family: string, url: string) {
    if (!this.style) {
      this.style = document.createElement("style");
      this.style.dataset.mmtourFonts = "true";
      document.head.append(this.style);
    }
    if (this.cssRules.has(family)) return;
    this.cssRules.add(family);
    this.style.append(`\n@font-face{font-family:"${escapeCssString(family)}";src:url("${url}") format("truetype");font-weight:400;font-style:normal;font-display:block;}`);
  }
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function rememberLoadableFont(map: Map<string, { family: string; byteLength: number }>, key: string, family: string, byteLength = 0) {
  const previous = map.get(key);
  if (!previous || byteLength > previous.byteLength) map.set(key, { family, byteLength });
}

function normalizeFontName(value: string): string {
  return value.toLowerCase().replace(/\b(lt|std|regular|medium|book|roman)\b/g, "").replace(/[^a-z0-9]+/g, "");
}
