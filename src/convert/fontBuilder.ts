// Browser-native SWF font → TrueType (.ttf) builder (Route B). Replaces FFDec's
// `font:ttf` export so the runtime's FontRegistry @font-face path is unchanged.
//
// swf-parser unifies DefineFont2/3 into `DefineFont { glyphs, codeUnits, layout,
// emSquareSize }`. A SWF glyph is a shape-record list using the same quadratic
// edge model as DefineShape — and TrueType `glyf` is also quadratic — so glyph
// outlines map across directly: walk records into contours, negate y (SWF y-down
// baseline → TrueType y-up). We then assemble a minimal-but-valid SFNT.

import { swf } from "swf-parser";

const REC_STYLE = 1;

export interface FontTag {
  id: number;
  fontName: string;
  isBold: boolean;
  isItalic: boolean;
  emSquareSize: number;
  glyphs: { records: any[] }[];
  codeUnits: number[];
  layout: any;
}

export function collectFonts(movie: any): any[] {
  return movie.tags.filter((t: any) => t.type === swf.TagType.DefineFont && t.glyphs?.length);
}

interface Pt {
  x: number;
  y: number;
  on: boolean;
}

/** Walk a glyph's shape records into closed TrueType contours (y negated). */
function glyphContours(records: any[]): Pt[][] {
  const contours: Pt[][] = [];
  let cur: Pt[] | null = null;
  let x = 0;
  let y = 0;
  const closeCurrent = () => {
    if (!cur) return;
    // TrueType auto-closes; drop a trailing on-curve point equal to the start.
    if (cur.length > 1) {
      const a = cur[0];
      const b = cur[cur.length - 1];
      if (b.on && a.x === b.x && a.y === b.y) cur.pop();
    }
    if (cur.length) contours.push(cur);
  };

  for (const rec of records) {
    if (rec.type === REC_STYLE) {
      if (rec.moveTo) {
        closeCurrent();
        x = rec.moveTo.x;
        y = rec.moveTo.y;
        cur = [{ x, y: -y, on: true }];
      }
      continue;
    }
    // Edge — delta/controlDelta relative to the edge start.
    if (!cur) cur = [{ x, y: -y, on: true }];
    const x2 = x + rec.delta.x;
    const y2 = y + rec.delta.y;
    if (rec.controlDelta) {
      cur.push({ x: x + rec.controlDelta.x, y: -(y + rec.controlDelta.y), on: false });
    }
    cur.push({ x: x2, y: -y2, on: true });
    x = x2;
    y = y2;
  }
  closeCurrent();
  return contours;
}

class Writer {
  private bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    this.bytes.push((v >> 8) & 0xff, v & 0xff);
    return this;
  }
  i16(v: number) {
    return this.u16(v < 0 ? v + 0x10000 : v);
  }
  u32(v: number) {
    this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  raw(arr: number[] | Uint8Array) {
    for (const b of arr) this.bytes.push(b & 0xff);
    return this;
  }
  tag(s: string) {
    for (let i = 0; i < 4; i++) this.bytes.push(s.charCodeAt(i));
    return this;
  }
  utf16be(s: string) {
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    return this;
  }
  get length() {
    return this.bytes.length;
  }
  build(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

function pad4(b: Uint8Array): Uint8Array {
  if (b.length % 4 === 0) return b;
  const out = new Uint8Array(b.length + (4 - (b.length % 4)));
  out.set(b);
  return out;
}

function checksum(b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) {
    sum = (sum + (((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + (b[i + 3] | 0))) >>> 0;
  }
  return sum >>> 0;
}

/** Build a TrueType font from a parsed DefineFont. */
// OpenType caps unitsPerEm at 16384 (OTS/Chrome reject anything larger), but
// SWF DefineFont3 uses a 20480-unit em square. When the source em exceeds the
// cap, scale the whole font (outlines + advances + vertical metrics) down to a
// valid em so the generated face loads instead of silently falling back to a
// system font. Scaling is uniform, so all metrics stay self-consistent.
const MAX_UPM = 16384;
const SCALED_UPM = 2048;

export function buildTtf(font: FontTag): Uint8Array {
  const srcUpm = font.emSquareSize || 1024;
  const upm = srcUpm > MAX_UPM ? SCALED_UPM : srcUpm;
  const scale = upm / srcUpm;
  const sc = (v: number) => Math.round(v * scale);
  // gid 0 must be .notdef — renderers treat any char that maps to glyph 0 as
  // "missing" and fall back to a system font. So prepend an empty .notdef and
  // shift every SWF glyph to gid+1 (cmap below compensates).
  const swfContours = font.glyphs.map((g) => {
    const contours = glyphContours(g.records);
    return scale === 1 ? contours : contours.map((c) => c.map((p) => ({ x: sc(p.x), y: sc(p.y), on: p.on })));
  });
  const glyphs: Pt[][][] = [[], ...swfContours];
  const numGlyphs = glyphs.length;
  const swfAdvances: number[] = (font.layout?.advances ?? new Array(swfContours.length).fill(srcUpm)).map(sc);
  const advances: number[] = [Math.round(upm * 0.5), ...swfAdvances];

  // --- glyf + loca ---
  let fxMin = 32767, fyMin = 32767, fxMax = -32768, fyMax = -32768;
  let maxPoints = 0, maxContours = 0;
  const glyf = new Writer();
  const loca: number[] = [0];
  const glyphXMin: number[] = []; // per-glyph left side bearing (= xMin)
  for (const contours of glyphs) {
    if (contours.length === 0) {
      glyphXMin.push(0);
      loca.push(glyf.length);
      continue;
    }
    let gxMin = 32767, gyMin = 32767, gxMax = -32768, gyMax = -32768;
    let totalPts = 0;
    for (const c of contours) {
      for (const p of c) {
        gxMin = Math.min(gxMin, p.x); gyMin = Math.min(gyMin, p.y);
        gxMax = Math.max(gxMax, p.x); gyMax = Math.max(gyMax, p.y);
      }
      totalPts += c.length;
    }
    maxPoints = Math.max(maxPoints, totalPts);
    maxContours = Math.max(maxContours, contours.length);
    fxMin = Math.min(fxMin, gxMin); fyMin = Math.min(fyMin, gyMin);
    fxMax = Math.max(fxMax, gxMax); fyMax = Math.max(fyMax, gyMax);
    glyphXMin.push(gxMin);

    glyf.i16(contours.length).i16(gxMin).i16(gyMin).i16(gxMax).i16(gyMax);
    let pt = 0;
    for (const c of contours) {
      pt += c.length;
      glyf.u16(pt - 1); // endPtsOfContours
    }
    glyf.u16(0); // instructionLength
    // flags: only ON_CURVE bit; long-form coords (16-bit signed deltas).
    for (const c of contours) for (const p of c) glyf.u8(p.on ? 0x01 : 0x00);
    let px = 0;
    for (const c of contours) for (const p of c) { glyf.i16(p.x - px); px = p.x; }
    let py = 0;
    for (const c of contours) for (const p of c) { glyf.i16(p.y - py); py = p.y; }
    while (glyf.length % 2 !== 0) glyf.u8(0);
    loca.push(glyf.length);
  }
  if (fxMin > fxMax) { fxMin = fyMin = 0; fxMax = fyMax = upm; }
  const glyfTable = glyf.build();

  const locaW = new Writer();
  for (const o of loca) locaW.u32(o);
  const locaTable = locaW.build();

  // --- cmap (format 4, platform 3/1) ---
  const cmapTable = buildCmap(font.codeUnits);

  // --- hmtx + hhea ---
  const hmtx = new Writer();
  for (let i = 0; i < numGlyphs; i++) hmtx.u16(Math.max(0, Math.round(advances[i] ?? upm))).i16(glyphXMin[i] ?? 0);
  const hmtxTable = hmtx.build();

  const ascent = Math.round(font.layout?.ascent != null ? font.layout.ascent * scale : fyMax);
  const descent = Math.round(font.layout?.descent != null ? font.layout.descent * scale : -fyMin);
  const lineGap = Math.round((font.layout?.leading ?? 0) * scale);
  const advanceMax = advances.reduce((m, a) => Math.max(m, Math.round(a)), 0);

  const hhea = new Writer();
  hhea.u32(0x00010000)
    .i16(ascent).i16(-descent).i16(lineGap)   // ascender, descender, lineGap
    .u16(advanceMax)                          // advanceWidthMax
    .i16(fxMin).i16(fxMin).i16(fxMax)         // minLSB, minRSB, xMaxExtent
    .i16(1).i16(0).i16(0)                     // caretSlopeRise, Run, Offset
    .i16(0).i16(0).i16(0).i16(0)              // reserved ×4
    .i16(0)                                   // metricDataFormat
    .u16(numGlyphs);                          // numberOfHMetrics
  const hheaTable = hhea.build();

  // --- maxp (version 1.0, 15 fields) ---
  const maxp = new Writer();
  maxp.u32(0x00010000).u16(numGlyphs).u16(maxPoints).u16(maxContours)
    .u16(0).u16(0)        // maxCompositePoints, maxCompositeContours
    .u16(2).u16(1)        // maxZones, maxTwilightPoints
    .u16(0).u16(0).u16(0) // maxStorage, maxFunctionDefs, maxInstructionDefs
    .u16(0).u16(0)        // maxStackElements, maxSizeOfInstructions
    .u16(0).u16(0);       // maxComponentElements, maxComponentDepth
  const maxpTable = maxp.build();

  // --- OS/2 (version 3 — exactly 96 bytes) ---
  const fsSel = (font.isBold ? 0x20 : 0) | (font.isItalic ? 0x01 : 0) || 0x40;
  const os2 = new Writer();
  os2.u16(3)                                            // version
    .i16(Math.round(advanceMax * 0.5))                  // xAvgCharWidth
    .u16(font.isBold ? 700 : 400).u16(5)                // usWeightClass, usWidthClass
    .u16(0)                                             // fsType
    .i16(Math.round(upm * 0.65)).i16(Math.round(upm * 0.7)).i16(0).i16(Math.round(upm * 0.14))   // subscript X/Y size, X/Y offset
    .i16(Math.round(upm * 0.65)).i16(Math.round(upm * 0.7)).i16(0).i16(Math.round(upm * 0.48))   // superscript X/Y size, X/Y offset
    .i16(Math.round(upm * 0.05)).i16(Math.round(upm * 0.26))   // yStrikeoutSize, yStrikeoutPosition
    .i16(0)                                             // sFamilyClass
    .raw([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])               // panose (10)
    .u32(0).u32(0).u32(0).u32(0)                        // ulUnicodeRange 1-4
    .tag("MMTR")                                        // achVendID
    .u16(fsSel)                                         // fsSelection
    .u16(firstCode(font.codeUnits)).u16(lastCode(font.codeUnits))  // usFirst/LastCharIndex
    .i16(ascent).i16(-descent).i16(lineGap)            // sTypoAscender/Descender/LineGap
    .u16(ascent).u16(descent)                          // usWinAscent, usWinDescent
    .u32(0).u32(0)                                      // ulCodePageRange 1-2
    .i16(Math.round(upm * 0.5)).i16(Math.round(upm * 0.7))   // sxHeight, sCapHeight
    .u16(32).u16(32).u16(2);                           // usDefaultChar, usBreakChar, usMaxContext
  const os2Table = os2.build();

  // --- name + post + head ---
  const nameTable = buildName(font.fontName, font.isBold, font.isItalic);
  const post = new Writer();
  post.u32(0x00030000).u32(0).i16(0).i16(0).u32(0).u32(0).u32(0).u32(0).u32(0);
  const postTable = post.build();

  const head = new Writer();
  head.u32(0x00010000).u32(0x00010000).u32(0) // version, fontRevision, checkSumAdjustment (patched later)
    .u32(0x5f0f3cf5).u16(0x000b).u16(upm)
    .u32(0).u32(0).u32(0).u32(0) // created/modified (zeros)
    .i16(fxMin).i16(fyMin).i16(fxMax).i16(fyMax)
    .u16((font.isBold ? 0x01 : 0) | (font.isItalic ? 0x02 : 0)).u16(8)
    .i16(2).i16(1).i16(0); // indexToLocFormat=1 (long), glyphDataFormat=0
  const headTable = head.build();

  return assemble([
    { tag: "OS/2", data: os2Table },
    { tag: "cmap", data: cmapTable },
    { tag: "glyf", data: glyfTable },
    { tag: "head", data: headTable },
    { tag: "hhea", data: hheaTable },
    { tag: "hmtx", data: hmtxTable },
    { tag: "loca", data: locaTable },
    { tag: "maxp", data: maxpTable },
    { tag: "name", data: nameTable },
    { tag: "post", data: postTable },
  ]);
}

function firstCode(codeUnits: number[]): number {
  return codeUnits.reduce((m, c) => Math.min(m, c), 0xffff);
}
function lastCode(codeUnits: number[]): number {
  return codeUnits.reduce((m, c) => Math.max(m, c), 0);
}

function buildCmap(codeUnits: number[]): Uint8Array {
  // char code -> glyph index. SWF glyph i lives at TTF gid i+1 (gid 0 = .notdef).
  const pairs = codeUnits
    .map((code, i) => ({ code, gid: i + 1 }))
    .filter((p) => p.code > 0 && p.code <= 0xffff)
    .sort((a, b) => a.code - b.code);

  interface Seg { start: number; end: number; delta: number }
  const segs: Seg[] = [];
  for (const p of pairs) {
    const last = segs[segs.length - 1];
    if (last && p.code === last.end + 1 && p.gid - p.code === last.delta) last.end = p.code;
    else segs.push({ start: p.code, end: p.code, delta: p.gid - p.code });
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 }); // required terminator

  const segCount = segs.length;
  const sub = new Writer();
  sub.u16(4).u16(0).u16(0); // format, length (patched), language
  sub.u16(segCount * 2);
  const sr = 2 ** Math.floor(Math.log2(segCount)) * 2;
  sub.u16(sr).u16(Math.floor(Math.log2(segCount))).u16(segCount * 2 - sr);
  for (const s of segs) sub.u16(s.end);
  sub.u16(0); // reservedPad
  for (const s of segs) sub.u16(s.start);
  for (const s of segs) sub.i16(s.start === 0xffff ? 1 : s.delta & 0xffff);
  for (let i = 0; i < segCount; i++) sub.u16(0); // idRangeOffset (all 0 → use idDelta)
  let subBytes = sub.build();
  // patch subtable length
  subBytes[2] = (subBytes.length >> 8) & 0xff;
  subBytes[3] = subBytes.length & 0xff;

  const out = new Writer();
  out.u16(0).u16(1); // version, numTables
  out.u16(3).u16(1).u32(12); // platform 3, enc 1, offset
  out.raw(subBytes);
  return out.build();
}

function buildName(family: string, bold: boolean, italic: boolean): Uint8Array {
  const sub = bold && italic ? "Bold Italic" : bold ? "Bold" : italic ? "Italic" : "Regular";
  const full = sub === "Regular" ? family : `${family} ${sub}`;
  const ps = full.replace(/\s+/g, "");
  const records = [
    [1, family],
    [2, sub],
    [4, full],
    [6, ps],
  ] as [number, string][];

  const header = new Writer();
  header.u16(0).u16(records.length).u16(6 + records.length * 12);
  const strings = new Writer();
  let offset = 0;
  for (const [nameId, value] of records) {
    const len = value.length * 2;
    header.u16(3).u16(1).u16(0x0409).u16(nameId).u16(len).u16(offset);
    strings.utf16be(value);
    offset += len;
  }
  return new Writer().raw(header.build()).raw(strings.build()).build();
}

interface Table {
  tag: string;
  data: Uint8Array;
}

function assemble(tables: Table[]): Uint8Array {
  const n = tables.length;
  const sr = 2 ** Math.floor(Math.log2(n)) * 16;
  const headerLen = 12 + n * 16;

  // Tables are padded to 4 bytes for layout + checksum, but the directory records
  // the real (unpadded) length — OTS (Chrome's sanitizer) requires it.
  const padded = tables.map((t) => pad4(t.data));
  let offset = headerLen;
  const offsets: number[] = [];
  for (const p of padded) {
    offsets.push(offset);
    offset += p.length;
  }

  const dir = new Writer();
  dir.u32(0x00010000).u16(n).u16(sr).u16(Math.floor(Math.log2(n))).u16(n * 16 - sr);
  tables.forEach((t, i) => {
    dir.tag(t.tag).u32(checksum(padded[i])).u32(offsets[i]).u32(t.data.length);
  });

  const font = new Uint8Array(offset);
  font.set(dir.build(), 0);
  padded.forEach((p, i) => font.set(p, offsets[i]));

  // head.checkSumAdjustment = 0xB1B0AFBA - checksum(wholeFont)
  const headIdx = tables.findIndex((t) => t.tag === "head");
  const adjustment = (0xb1b0afba - checksum(font)) >>> 0;
  const headOff = offsets[headIdx] + 8;
  font[headOff] = (adjustment >>> 24) & 0xff;
  font[headOff + 1] = (adjustment >>> 16) & 0xff;
  font[headOff + 2] = (adjustment >>> 8) & 0xff;
  font[headOff + 3] = adjustment & 0xff;
  return font;
}
