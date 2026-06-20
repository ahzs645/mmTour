// In-browser scene compiler: SWF bytes → a playable bundle (asset files +
// timeline.json) the GSAP player consumes with no server. Reuses the verified
// fs-free builders (swf-parser adapter + buildFrames) and the pure-TS asset
// converters; writes every asset into an in-memory file map keyed by the same
// scene-relative paths the player's pack source expects.

import { parseSwf, swf } from "swf-parser";
// @ts-ignore — pure-JS fs-free builders, reused verbatim from the Node pipeline
import { swfToFfdecModel } from "../../scripts/lib/swfParserAdapter.mjs";
// @ts-ignore
import { buildFrames, attachSpriteTimelines, discoverEntryFrame } from "../../scripts/lib/frames.mjs";
import {
  collectShapes, defineShapeToSvg,
  collectBitmaps, isJpegBitmap, mergeJpeg, decodeLossless,
  collectFonts, buildTtf,
  collectSounds, extractSound,
  collectButtons, composeButton,
  fontsById, reconstructText,
} from "./index.ts";
import { extractControl } from "./avm1Control.ts";

export interface CompileStats {
  shapes: number;
  images: number;
  fonts: number;
  sounds: number;
  buttons: number;
  texts: number;
  frames: number;
  sprites: number;
  stopFrames: number;
  assetBytes: number;
  ms: number;
}

export interface CompiledScene {
  scene: string;
  timeline: any;
  files: Map<string, { type: string; bytes: Uint8Array }>;
  stats: CompileStats;
  width: number;
  height: number;
}

const enc = new TextEncoder();

export async function compileScene(bytes: Uint8Array, scene: string): Promise<CompiledScene> {
  const t0 = performance.now();
  const movie = parseSwf(bytes);
  const { tags } = swfToFfdecModel(bytes);

  const files = new Map<string, { type: string; bytes: Uint8Array }>();
  const put = (path: string, type: string, data: Uint8Array | string) =>
    files.set(path, { type, bytes: typeof data === "string" ? enc.encode(data) : data });

  const assets: Record<string, any> = {};
  const stats: CompileStats = { shapes: 0, images: 0, fonts: 0, sounds: 0, buttons: 0, texts: 0, frames: 0, sprites: 0, stopFrames: 0, assetBytes: 0, ms: 0 };

  // --- shapes ---
  for (const { id, tag } of collectShapes(bytes).shapes) {
    try {
      const svg = defineShapeToSvg(tag).svg;
      put(`shapes/${id}.svg`, "image/svg+xml", svg);
      assets[String(id)] = { id, kind: "shape", src: `generated/${scene}/shapes/${id}.svg`, origin: svgOrigin(svg) };
      stats.shapes++;
    } catch { /* skip a bad shape */ }
  }

  // --- images ---
  const { bitmaps, jpegTables } = collectBitmaps(movie);
  for (const tag of bitmaps) {
    try {
      const { ext, mime, bytes: imgBytes } = await bitmapBytes(tag, jpegTables);
      put(`images/${tag.id}.${ext}`, mime, imgBytes);
      assets[String(tag.id)] ??= { id: tag.id, kind: "image", src: `generated/${scene}/images/${tag.id}.${ext}`, origin: zero() };
      stats.images++;
    } catch { /* skip */ }
  }

  // --- fonts ---
  for (const font of collectFonts(movie)) {
    try {
      const safe = (font.fontName || "Font").replace(/[^\w .-]/g, "");
      const path = `fonts/${font.id}_${safe}.ttf`;
      put(path, "font/ttf", buildTtf(font));
      assets[`font:${font.id}`] = { id: font.id, kind: "font", src: `generated/${scene}/${path}`, origin: zero() };
      stats.fonts++;
    } catch { /* skip */ }
  }

  // --- sounds ---
  for (const tag of collectSounds(movie)) {
    try {
      const s = extractSound(tag);
      const path = `sounds/${tag.id}.${s.ext}`;
      put(path, s.mime, s.bytes);
      assets[`sound:${tag.id}`] = { id: tag.id, kind: "sound", src: `generated/${scene}/${path}`, origin: zero() };
      stats.sounds++;
    } catch { /* skip */ }
  }

  // --- buttons ---
  const shapesById = new Map<number, any>();
  for (const t of movie.tags) if (t.type === swf.TagType.DefineShape) shapesById.set(t.id, t);
  for (const button of collectButtons(movie)) {
    try {
      const composed = composeButton(button, (cid) => shapesById.get(cid));
      const states: Record<string, any> = {};
      for (const [stateFile, svgStr] of Object.entries(composed.states)) {
        if (!/<path|<image|<use/.test(svgStr)) continue;
        const path = `buttons/${composed.dir}/${stateFile}.svg`;
        put(path, "image/svg+xml", svgStr);
        const stateName = stateFile.replace(/^\d+_/, "").replace("hittest", "hit");
        states[stateName] = { src: `generated/${scene}/${path}`, origin: svgOrigin(svgStr) };
      }
      if (Object.keys(states).length) {
        assets[`button:${button.id}`] = { id: button.id, kind: "button", origin: states.up?.origin ?? Object.values(states)[0].origin, states, src: states.up?.src };
        stats.buttons++;
      }
    } catch { /* skip */ }
  }

  // --- text (editText + static DefineText) ---
  const fonts = fontsById(movie);
  for (const t of movie.tags) {
    if (t.type === swf.TagType.DefineDynamicText) {
      const text = editTextStyle(t, scene);
      put(`texts/${t.id}.txt`, "text/plain", String(t.text ?? ""));
      assets[String(t.id)] = text;
      stats.texts++;
    } else if (t.type === swf.TagType.DefineText) {
      const content = reconstructText(t, fonts);
      if (!content) continue;
      put(`texts/${t.id}.txt`, "text/plain", content);
      const b = t.bounds;
      assets[String(t.id)] ??= {
        id: t.id, kind: "text", src: `generated/${scene}/texts/${t.id}.txt`,
        origin: b ? { x: b.xMin / 20, y: b.yMin / 20, width: (b.xMax - b.xMin) / 20, height: (b.yMax - b.yMin) / 20 } : zero(),
        text: { text: content, align: "center", x: b ? b.xMin / 20 : 0, y: 0 },
      };
      stats.texts++;
    }
  }

  // --- timeline (display list) ---
  const frames = buildFrames(tags);
  // sprite assets so attachSpriteTimelines can attach nested timelines
  for (const t of tags) {
    if (t.type === "DefineSpriteTag" && asArray(t.subTags?.item).some((s: any) => s?.type === "PlaceObject2Tag")) {
      assets[String(t.spriteId)] ??= { id: t.spriteId, kind: "sprite", origin: zero() };
    }
  }
  attachSpriteTimelines(assets, tags);
  stats.sprites = Object.values(assets).filter((a: any) => a.kind === "sprite").length;

  const labels = Object.fromEntries(frames.filter((f: any) => f.label).map((f: any) => [f.label, f.index]));
  const control = extractControl(movie);
  stats.frames = frames.length;
  stats.stopFrames = control.stopFrames.length;

  const fr = movie.header.frameSize;
  const width = Math.round((fr.xMax - fr.xMin) / 20);
  const height = Math.round((fr.yMax - fr.yMin) / 20);
  const fps = movie.header.frameRate?.epsilons ? movie.header.frameRate.epsilons / 256 : Number(movie.header.frameRate) || 15;

  const timeline = {
    scene,
    source: `${scene}.swf`,
    generatedFrom: "in-browser swf-parser converter",
    dimensions: { width, height },
    backgroundColor: backgroundColor(movie),
    fps,
    frameCount: frames.length,
    duration: frames.length / fps,
    labels,
    entryFrame: discoverEntryFrame(labels),
    control: {
      stopFrames: control.stopFrames,
      spriteStopFrames: control.spriteStopFrames,
      frameActions: [],
      globalDefaults: {},
    },
    frameSvgs: [],
    assets,
    frames,
  };

  put("timeline.json", "application/json", JSON.stringify(timeline));
  for (const f of files.values()) stats.assetBytes += f.bytes.length;
  stats.ms = Math.round(performance.now() - t0);

  return { scene, timeline, files, stats, width, height };
}

// --- helpers ---
const zero = () => ({ x: 0, y: 0, width: 0, height: 0 });

function svgOrigin(svg: string) {
  const width = parseFloat(svg.match(/\bwidth="([\d.]+)px"/)?.[1] ?? "0");
  const height = parseFloat(svg.match(/\bheight="([\d.]+)px"/)?.[1] ?? "0");
  const transform = svg.match(/<g[^>]+transform="matrix\(([^)]+)\)"/)?.[1];
  const parts = transform ? transform.split(",").map((p) => parseFloat(p.trim())) : [];
  return { x: parts[4] || 0, y: parts[5] || 0, width, height };
}

async function bitmapBytes(tag: any, jpegTables?: Uint8Array): Promise<{ ext: string; mime: string; bytes: Uint8Array }> {
  if (isJpegBitmap(tag)) {
    const bytes = mergeJpeg(tag.data, tag.mediaType === "image/x-swf-partial-jpeg" ? jpegTables : undefined);
    return { ext: "jpg", mime: "image/jpeg", bytes };
  }
  const img = await decodeLossless(tag);
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { ext: "png", mime: "image/png", bytes: new Uint8Array(await blob.arrayBuffer()) };
}

const ALIGN = ["left", "right", "center", "justify"];
function editTextStyle(t: any, scene: string) {
  const b = t.bounds;
  const w = b ? (b.xMax - b.xMin) / 20 : 0;
  const h = b ? (b.yMax - b.yMin) / 20 : 0;
  const text = {
    fontId: t.fontId,
    fontHeight: t.fontSize ? t.fontSize / 20 : undefined,
    leading: t.leading ? t.leading / 20 : undefined,
    color: t.color ? `#${hx(t.color.r)}${hx(t.color.g)}${hx(t.color.b)}` : undefined,
    align: typeof t.align === "number" ? ALIGN[t.align] : "left",
    x: b ? b.xMin / 20 : 0,
    y: b ? b.yMin / 20 : 0,
    width: w || undefined,
    height: h || undefined,
    multiline: !!t.multiline,
    wordWrap: !!t.wordWrap,
    html: !!t.html,
    text: t.text ? String(t.text) : undefined,
    variableName: t.variableName || undefined,
  };
  return { id: t.id, kind: "text", src: `generated/${scene}/texts/${t.id}.txt`, origin: { x: text.x, y: text.y, width: w, height: h }, text };
}

function backgroundColor(movie: any): string {
  const bg = movie.tags.find((t: any) => t.type === swf.TagType.SetBackgroundColor)?.color;
  return bg ? `#${hx(bg.r)}${hx(bg.g)}${hx(bg.b)}` : "#ffffff";
}

const hx = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");
function asArray(v: any): any[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}
