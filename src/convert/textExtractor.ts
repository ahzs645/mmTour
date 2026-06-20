// Static text reconstruction. A DefineText stores glyph *indices* (into a font),
// not characters — to recover the string, map each entry's index through the
// font's `codeUnits` (the same parallel array the font builder uses for cmap).
// DefineDynamicText (editText) already carries its literal `text`.

import { swf } from "swf-parser";

export function collectStaticTexts(movie: any): any[] {
  return movie.tags.filter((t: any) => t.type === swf.TagType.DefineText);
}

/** Build id → DefineFont map (for codeUnits lookup). */
export function fontsById(movie: any): Map<number, any> {
  const map = new Map<number, any>();
  for (const t of movie.tags) if (t.type === swf.TagType.DefineFont) map.set(t.id, t);
  return map;
}

/** Reconstruct a DefineText's string via the referenced fonts' codeUnits.
 *  fontId is sticky across records (set when it changes). */
export function reconstructText(defineText: any, fonts: Map<number, any>): string {
  let fontId: number | undefined;
  let out = "";
  for (const rec of defineText.records ?? []) {
    if (rec.fontId !== undefined) fontId = rec.fontId;
    const font = fontId !== undefined ? fonts.get(fontId) : undefined;
    for (const entry of rec.entries ?? []) {
      const code = font?.codeUnits?.[entry.index];
      if (code !== undefined) out += String.fromCharCode(code);
    }
  }
  return out;
}
