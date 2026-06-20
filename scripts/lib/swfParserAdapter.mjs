// swf-parser → FFDec-XML-model adapter. The timeline/asset extractor
// (build-asset-timeline.mjs and its lib/) was written against FFDec's `-swf2xml`
// output (tag objects with FFDec field names, parsed by fast-xml-parser). This
// adapter produces the SAME `{ swf, tags }` shape directly from the open-flash
// swf-parser tag tree — so the whole downstream pipeline runs Java-free, with no
// change to buildFrames/discoverAssets/geom.
//
// The conversions that matter:
//   matrix  scaleX/scaleY/rotate = Sfixed16P16 (epsilons/65536) → decimal;
//           translate stays in twips (matrixFromTag divides by 20)
//   cxform  *Mult = Sfixed8P8 whose epsilons IS FFDec's 256-based *MultTerm;
//           *Add  = signed int = FFDec's *AddTerm
//   fonts/sounds/fills are not needed here (assets come from the converters +
//   listDir); only the tags buildFrames/discoverAssets read are mapped.

import { parseSwf, swf } from "swf-parser";

const TT = swf.TagType;

const sfixed16 = (v) => (v && typeof v === "object" && "epsilons" in v ? v.epsilons / 65536 : Number(v) || 0);
const term256 = (v) => (v && typeof v === "object" && "epsilons" in v ? v.epsilons : Math.round((Number(v) || 0) * 256));
const intVal = (v) => (v && typeof v === "object" && "epsilons" in v ? Math.round(v.epsilons) : Number(v) || 0);
const bool = (v) => (v ? "true" : "false");

/** Parse SWF bytes into the FFDec-shaped `{ swf, tags }` the extractor expects. */
export function swfToFfdecModel(bytes) {
  const movie = parseSwf(bytes);
  const fs = movie.header.frameSize;
  const tags = movie.tags.map(adaptTag).filter(Boolean);
  const swfModel = {
    displayRect: { Xmin: fs.xMin, Xmax: fs.xMax, Ymin: fs.yMin, Ymax: fs.yMax },
    frameRate: sfixed16IsFps(movie.header.frameRate),
    tags: { item: tags },
  };
  return { movie, swf: swfModel, tags };
}

// frameRate is Ufixed8P8 (epsilons/256), not 16.16.
function sfixed16IsFps(v) {
  return v && typeof v === "object" && "epsilons" in v ? v.epsilons / 256 : Number(v) || 15;
}

function adaptMatrix(m) {
  if (!m) return undefined;
  return {
    hasScale: bool(true),
    hasRotate: bool(true),
    scaleX: sfixed16(m.scaleX),
    scaleY: sfixed16(m.scaleY),
    rotateSkew0: sfixed16(m.rotateSkew0),
    rotateSkew1: sfixed16(m.rotateSkew1),
    translateX: m.translateX ?? 0,
    translateY: m.translateY ?? 0,
  };
}

function adaptCxform(c) {
  if (!c) return undefined;
  const o = {};
  if (c.redMult !== undefined) o.redMultTerm = term256(c.redMult);
  if (c.greenMult !== undefined) o.greenMultTerm = term256(c.greenMult);
  if (c.blueMult !== undefined) o.blueMultTerm = term256(c.blueMult);
  if (c.alphaMult !== undefined) o.alphaMultTerm = term256(c.alphaMult);
  if (c.redAdd !== undefined) o.redAddTerm = intVal(c.redAdd);
  if (c.greenAdd !== undefined) o.greenAddTerm = intVal(c.greenAdd);
  if (c.blueAdd !== undefined) o.blueAddTerm = intVal(c.blueAdd);
  if (c.alphaAdd !== undefined) o.alphaAddTerm = intVal(c.alphaAdd);
  return o;
}

const adaptRect = (r) => (r ? { Xmin: r.xMin, Xmax: r.xMax, Ymin: r.yMin, Ymax: r.yMax } : undefined);
const adaptColor = (c) => (c ? { red: c.r, green: c.g, blue: c.b } : undefined);

function adaptTextRecords(records) {
  // discoverAssets only needs the first styled record (font/height/color).
  return (records ?? []).map((r) => ({
    styleFlagsHasFont: bool(r.fontId !== undefined),
    fontId: r.fontId,
    textHeight: r.fontSize,
    textColor: adaptColor(r.color),
  }));
}

function adaptEditText(t) {
  return {
    type: "DefineEditTextTag",
    characterID: t.id,
    bounds: adaptRect(t.bounds),
    fontId: t.fontId,
    fontHeight: t.fontSize,
    leading: t.leading,
    textColor: adaptColor(t.color),
    align: t.align,
    multiline: bool(t.multiline),
    wordWrap: bool(t.wordWrap),
    html: bool(t.html),
    initialText: t.text,
    variableName: t.variableName,
  };
}

function adaptTag(t) {
  switch (t.type) {
    case TT.PlaceObject:
      return {
        type: "PlaceObject2Tag",
        depth: t.depth,
        characterId: t.characterId ?? "",
        clipDepth: t.clipDepth,
        name: t.name,
        matrix: adaptMatrix(t.matrix),
        colorTransform: adaptCxform(t.colorTransform),
      };
    case TT.RemoveObject:
      return { type: "RemoveObject2Tag", depth: t.depth };
    case TT.ShowFrame:
      return { type: "ShowFrameTag" };
    case TT.FrameLabel:
      return { type: "FrameLabelTag", name: t.name };
    case TT.DefineSprite:
      return { type: "DefineSpriteTag", spriteId: t.id, subTags: { item: t.tags.map(adaptTag).filter(Boolean) } };
    case TT.DefineShape:
      return { type: "DefineShapeTag", shapeId: t.id };
    case TT.DefineText:
      return { type: "DefineTextTag", characterID: t.id, textBounds: adaptRect(t.bounds), textRecords: { item: adaptTextRecords(t.records) } };
    case TT.DefineDynamicText:
      return adaptEditText(t);
    case TT.DefineSound:
      return { type: "DefineSoundTag", soundId: t.id };
    case TT.DefineFont:
      return { type: "DefineFont2Tag", fontId: t.id };
    case TT.SetBackgroundColor:
      return { type: "SetBackgroundColorTag", backgroundColor: adaptColor(t.color) };
    default:
      return null; // tags the extractor doesn't read (DoAction, DefineButton, etc.)
  }
}
