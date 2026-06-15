import type { AssetTimeline } from "../data/timelineTypes";

/**
 * Resolves a CSS font stack for a text field's DefineEditText fontId using the
 * font's NAME plus a system sans fallback — mirroring how Flash/Ruffle render
 * these fields (the named font if the OS has it, otherwise a generic sans). We
 * deliberately do NOT @font-face the extracted TTF: on macOS Ruffle falls back
 * to the system sans, so using the embedded Franklin Gothic would make the
 * player diverge from the reference.
 */
export class FontRegistry {
  private names = new Map<number, string>();

  register(timeline: AssetTimeline) {
    for (const asset of Object.values(timeline.assets ?? {})) {
      if (asset.kind !== "font" || !asset.src) continue;
      const file = asset.src.split("/").pop() ?? "";
      const name = file.replace(/\.ttf$/i, "").replace(/^\d+_/, "").trim();
      if (name) this.names.set(asset.id, name);
    }
  }

  resolveFamily(fontId?: number): string | undefined {
    if (fontId == null) return undefined;
    const name = this.names.get(fontId);
    return name ? `"${name}", Arial, Helvetica, sans-serif` : undefined;
  }
}
