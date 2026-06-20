// Browser-native SWF button compositor (Route B). Replaces FFDec's per-state
// button SVG export. swf-parser gives `DefineButton { records:[{stateUp/Over/
// Down/HitTest, characterId, matrix, colorTransform}] }`. Each state's SVG is the
// union of the records flagged for that state, each placing its referenced shape
// under the record matrix — exactly how Flash composites a button.
//
// Shapes are rasterized via shapeInner (reused from the shape converter); records
// pointing at non-shapes (sprites/editText, e.g. the Skip-Intro field) are left to
// the runtime overlay and skipped here. Output matches FFDec's layout:
// buttons/DefineButton2_<id>/{1_up,2_over,3_down,4_hittest}.svg.

import { swf } from "swf-parser";
import { shapeInner } from "./svgEmit.ts";

const STATES = [
  { key: "stateUp", file: "1_up" },
  { key: "stateOver", file: "2_over" },
  { key: "stateDown", file: "3_down" },
  { key: "stateHitTest", file: "4_hittest" },
];

const num = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};
const sfixed = (v: any) => (v && typeof v === "object" && "epsilons" in v ? v.epsilons / 65536 : Number(v) || 0);
const term256 = (v: any) => (v && typeof v === "object" && "epsilons" in v ? v.epsilons / 256 : Number(v) ?? 1);
const addVal = (v: any) => (v && typeof v === "object" && "epsilons" in v ? Math.round(v.epsilons) : Number(v) || 0);

/** A record's RGB colour transform → an feComponentTransfer filter (alpha is via
 *  element opacity, matching the runtime). Returns null for an identity transform. */
function cxformFilter(id: string, cx: any): string | null {
  if (!cx) return null;
  const rm = cx.redMult !== undefined ? term256(cx.redMult) : 1;
  const gm = cx.greenMult !== undefined ? term256(cx.greenMult) : 1;
  const bm = cx.blueMult !== undefined ? term256(cx.blueMult) : 1;
  const ra = addVal(cx.redAdd) / 255;
  const ga = addVal(cx.greenAdd) / 255;
  const ba = addVal(cx.blueAdd) / 255;
  if (rm === 1 && gm === 1 && bm === 1 && ra === 0 && ga === 0 && ba === 0) return null;
  return (
    `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">` +
    `<feComponentTransfer>` +
    `<feFuncR type="linear" slope="${num(rm)}" intercept="${num(ra)}"/>` +
    `<feFuncG type="linear" slope="${num(gm)}" intercept="${num(ga)}"/>` +
    `<feFuncB type="linear" slope="${num(bm)}" intercept="${num(ba)}"/>` +
    `</feComponentTransfer></filter>`
  );
}

export interface ComposedButton {
  id: number;
  dir: string;
  /** file basename (e.g. "1_up") → SVG string */
  states: Record<string, string>;
  unsupported: string[];
}

export function collectButtons(movie: any): any[] {
  return movie.tags.filter((t: any) => t.type === swf.TagType.DefineButton);
}

/** Compose all per-state SVGs for one DefineButton. `getShape(id)` returns the
 *  parsed DefineShape tag for a character id, or undefined for non-shapes. */
export function composeButton(button: any, getShape: (id: number) => any): ComposedButton {
  const states: Record<string, string> = {};
  const unsupported: string[] = [];

  for (const { key, file } of STATES) {
    const records = button.records.filter((r: any) => r[key]);
    const parts: string[] = [];
    const defs: string[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    records.forEach((rec: any, i: number) => {
      const shape = getShape(rec.characterId);
      if (!shape) {
        unsupported.push(`record→char ${rec.characterId} (non-shape)`);
        return;
      }
      const inner = shapeInner(shape, `b${button.id}_${file}_${i}`);
      unsupported.push(...inner.unsupported.map((u) => `char ${rec.characterId}: ${u}`));
      if (!inner.body) return;

      const m = rec.matrix ?? {};
      const a = sfixed(m.scaleX ?? 1) || 1;
      const b = sfixed(m.rotateSkew0);
      const c = sfixed(m.rotateSkew1);
      const d = sfixed(m.scaleY ?? 1) || 1;
      const e = (m.translateX ?? 0) / 20;
      const f = (m.translateY ?? 0) / 20;

      const alpha = rec.colorTransform?.alphaMult !== undefined ? term256(rec.colorTransform.alphaMult) : 1;
      const opacity = alpha < 1 ? ` opacity="${num(alpha)}"` : "";

      const filterId = `b${button.id}_${file}_${i}_cx`;
      const filter = cxformFilter(filterId, rec.colorTransform);
      const filterAttr = filter ? ` filter="url(#${filterId})"` : "";
      if (filter) defs.push(filter);

      parts.push(`<g transform="matrix(${num(a)}, ${num(b)}, ${num(c)}, ${num(d)}, ${num(e)}, ${num(f)})"${opacity}${filterAttr}>${inner.body}</g>`);
      if (inner.defs) defs.push(inner.defs);

      // transform the shape's twip bounds by the record matrix → px button space
      const bd = shape.bounds;
      for (const [bx, by] of [[bd.xMin, bd.yMin], [bd.xMax, bd.yMin], [bd.xMin, bd.yMax], [bd.xMax, bd.yMax]]) {
        const px = (a * bx + c * by) / 20 + e;
        const py = (b * bx + d * by) / 20 + f;
        minX = Math.min(minX, px); minY = Math.min(minY, py);
        maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
      }
    });

    if (!parts.length || !Number.isFinite(minX)) {
      // empty state (e.g. a hit area with only non-shape records) — emit a stub.
      states[file] = `<svg xmlns:xlink="http://www.w3.org/1999/xlink" height="0px" width="0px" xmlns="http://www.w3.org/2000/svg"><g/></svg>`;
      continue;
    }

    const w = maxX - minX;
    const h = maxY - minY;
    const defsBlock = defs.length ? `<defs>${defs.join("")}</defs>` : "";
    const g = `<g transform="matrix(1.0, 0.0, 0.0, 1.0, ${num(-minX)}, ${num(-minY)})">${parts.join("")}</g>`;
    states[file] = `<svg xmlns:xlink="http://www.w3.org/1999/xlink" height="${num(h)}px" width="${num(w)}px" xmlns="http://www.w3.org/2000/svg">${defsBlock}${g}</svg>`;
  }

  return { id: button.id, dir: `DefineButton2_${button.id}`, states, unsupported };
}
