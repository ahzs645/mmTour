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
  return reconstructTextRecords(defineText, fonts).map((record) => record.text).join("\n--- RECORDSEPARATOR ---\n").trim();
}

export function reconstructTextRecords(defineText: any, fonts: Map<number, any>): Array<{ text: string; x: number; y: number; width?: number }> {
  let fontId: number | undefined;
  const records: Array<{ text: string; x: number; y: number; width?: number }> = [];
  for (const rec of defineText.records ?? []) {
    if (rec.fontId !== undefined) fontId = rec.fontId;
    const font = fontId !== undefined ? fonts.get(fontId) : undefined;
    let text = "";
    let width = 0;
    for (const entry of rec.entries ?? []) {
      const code = font?.codeUnits?.[entry.index];
      if (code !== undefined) text += String.fromCharCode(code);
      width += Number(entry.advance ?? 0) / 20;
    }
    if (text) {
      records.push({
        text,
        x: Number(rec.offsetX ?? 0) / 20,
        y: Number(rec.offsetY ?? 0) / 20,
        width: width > 0 ? width : undefined,
      });
    }
  }
  return records;
}
