// In-browser scene compiler: SWF bytes → a playable bundle (asset files +
// timeline.json) the GSAP player consumes with no server. Reuses the verified
// fs-free builders (swf-parser adapter + buildFrames) and the pure-TS asset
// converters; writes every asset into an in-memory file map keyed by the same
// scene-relative paths the player's pack source expects.

import { parseSwf, swf } from "swf-parser";
import type { Matrix, Origin } from "../data/timelineTypes";
// @ts-ignore — pure-JS fs-free builders, reused verbatim from the Node pipeline
import { ffdecModelFromMovie } from "../../scripts/lib/swfParserAdapter.mjs";
// @ts-ignore
import { buildFrames, attachSpriteTimelines, discoverEntryFrame } from "../../scripts/lib/frames.mjs";
import {
  defineShapeToSvg,
  collectBitmaps, isJpegBitmap, mergeJpeg, decodeLossless,
  collectFonts, buildTtf,
  collectSounds, extractSound,
  collectButtons, composeButton,
  fontsById, reconstructText,
} from "./index.ts";
import { matrixFromButtonRecord } from "./buttonComposer.ts";
import { extractControl, detectDependencies, type ExtractedControl, type SwfDependency } from "./avm1Control.ts";
import { parseProgram } from "./avm1/parse.ts";
import { runInit } from "./avm1/interp.ts";

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
  /** Other SWFs this scene loadMovie's (a shell like A-tour needs these too). */
  dependencies: SwfDependency[];
}

const enc = new TextEncoder();

export async function compileScene(bytes: Uint8Array, scene: string): Promise<CompiledScene> {
  const t0 = performance.now();
  // Parse the SWF ONCE — parseSwf is expensive on big movies (~49s for segment5),
  // so reuse `movie` for the adapter + every converter instead of re-parsing.
  const movie = parseSwf(bytes);
  const { tags } = ffdecModelFromMovie(movie);

  const files = new Map<string, { type: string; bytes: Uint8Array }>();
  const put = (path: string, type: string, data: Uint8Array | string) =>
    files.set(path, { type, bytes: typeof data === "string" ? enc.encode(data) : data });

  const assets: Record<string, any> = {};
  const stats: CompileStats = { shapes: 0, images: 0, fonts: 0, sounds: 0, buttons: 0, texts: 0, frames: 0, sprites: 0, stopFrames: 0, assetBytes: 0, ms: 0 };
  const soundNames = soundExportNames(movie);
  const soundLibrary: Record<string, { id: number; name: string; src: string; durationMs?: number }> = {};

  // --- shapes ---
  for (const tag of movie.tags) {
    if (tag.type !== swf.TagType.DefineShape) continue;
    try {
      const svg = defineShapeToSvg(tag).svg;
      put(`shapes/${tag.id}.svg`, "image/svg+xml", svg);
      assets[String(tag.id)] = { id: tag.id, kind: "shape", src: `generated/${scene}/shapes/${tag.id}.svg`, origin: svgOrigin(svg) };
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
      const src = `generated/${scene}/${path}`;
      assets[`sound:${tag.id}`] = { id: tag.id, kind: "sound", src, origin: zero() };
      const name = soundNames.get(Number(tag.id));
      if (name) {
        const entry = { id: tag.id, name, src, durationMs: soundDurationMs(tag) };
        soundLibrary[name] = entry;
        soundLibrary[name.toLowerCase()] = entry;
      }
      stats.sounds++;
    } catch { /* skip */ }
  }

  // --- buttons ---
  const dynamicTexts = dynamicTextInfo(movie);
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
      const textFields = buttonTextFields(button, dynamicTexts);
      if (Object.keys(states).length || textFields.length) {
        const firstState = Object.values(states)[0] as any | undefined;
        const origin = states.up?.origin ?? firstState?.origin ?? buttonTextOrigin(textFields, dynamicTexts) ?? zero();
        assets[`button:${button.id}`] = {
          id: button.id,
          kind: "button",
          origin,
          states,
          src: states.up?.src,
          ...(textFields.length ? { textFields } : {}),
        };
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
  const control = extractControl(movie);
  const controlledSprites = controlledSpriteIds(control);
  const spriteTimelines = new Map<string, any[]>();

  // Sprite assets so the runtime can instantiate nested MovieClips. Some SWFs
  // use script-only sprites as timers/controllers: they have ShowFrame/DoAction
  // tags but no visual PlaceObject tags, so preserve their empty timelines too.
  for (const t of tags) {
    if (t.type !== "DefineSpriteTag" || !t.spriteId) continue;
    const id = String(t.spriteId);
    const spriteFrames = buildFrames(asArray(t.subTags?.item));
    const hasDisplayList = spriteFrames.some((frame: any) => frame.instances?.length);
    if (!hasDisplayList && !controlledSprites.has(id)) continue;
    assets[id] ??= { id: Number(t.spriteId), kind: "sprite", origin: zero() };
    if (spriteFrames.length) spriteTimelines.set(id, spriteTimelineFrames(spriteFrames));
  }
  attachSpriteTimelines(assets, tags);
  for (const [id, spriteTimeline] of spriteTimelines) {
    const asset = assets[id];
    if (asset?.kind === "sprite" && !asset.timeline?.length) asset.timeline = spriteTimeline;
  }
  stats.sprites = Object.values(assets).filter((a: any) => a.kind === "sprite").length;

  const labels = Object.fromEntries(frames.filter((f: any) => f.label).map((f: any) => [f.label, f.index]));
  stats.frames = frames.length;
  stats.stopFrames = control.stopFrames.length;

  // Execute the frame-1 init (function defs + startup calls) to discover what a
  // shell brings on stage at startup — level loads, queued cross-level calls,
  // and the seeded variable store. This is what lets A-tour self-drive its
  // initial state without scene-specific startup code.
  const initBytes = firstFrameDoAction(movie);
  let initLoads: { swf: string; level?: number }[] = [];
  let initCalls: { target: string; name: string; args?: string }[] = [];
  let globalDefaults: Record<string, any> = {};
  if (initBytes) {
    try {
      const r = runInit(parseProgram(initBytes), { osVersion: "Pro" });
      globalDefaults = r.globals;
      initLoads = r.loads.filter((l) => l.level !== undefined);
      initCalls = r.calls;
    } catch { /* init scan is best-effort */ }
  }
  // Fire startup loads/calls on the first PLAYBACK tick (frame after entry), not
  // at frame 0 — frame 0's scripts run during the player's construction
  // (buildRoot), before the level system + playback are ready, so a load there
  // races. Defer to the next frame the root actually enters (capped before the
  // first stop).
  const entry = discoverEntryFrame(labels);
  const firstStop = control.stopFrames.find((f: number) => f > entry);
  const loadFrame = frames.length > 1 ? Math.min(entry + 1, firstStop ?? frames.length - 1) : 0;
  const startupActions = [
    ...initLoads.map((l) => ({ command: "loadMovieNum", swf: l.swf, level: l.level, executionContext: "timeline" })),
    ...(initCalls.length
      ? [{
          command: "callFunctions",
          functionCalls: initCalls.map((c) => ({ target: c.target, functionName: c.name, arguments: c.args ?? "" })),
          executionContext: "timeline",
        }]
      : []),
  ];
  const deferredStartupActions = startupActions.length
    ? [{ frame: loadFrame, actions: startupActions }]
    : [];
  const extractedFrameActions = control.frameActions
    .map((record) => ({
      ...record,
      actions: (record.actions ?? []).filter((action: any) =>
        // Root frame-1 navigation can run during Player construction before the
        // controller has finished registering the level. Keep those startup
        // loads on the deferred runInit path above; later navigation stays data-driven.
        !(record.frame === 0 && (action.command === "loadMovie" || action.command === "loadMovieNum")),
      ),
    }))
    .filter((record) => record.actions.length);
  const frameActions = [...extractedFrameActions, ...deferredStartupActions];

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
      spriteActions: control.spriteActions,
      frameActions,
      definedFunctions: control.definedFunctions,
      buttonActions: control.buttonActions,
      soundLibrary,
      globalDefaults,
    },
    frameSvgs: [],
    assets,
    frames,
  };

  put("timeline.json", "application/json", JSON.stringify(timeline));
  for (const f of files.values()) stats.assetBytes += f.bytes.length;
  stats.ms = Math.round(performance.now() - t0);

  return { scene, timeline, files, stats, width, height, dependencies: detectDependencies(movie) };
}

// --- helpers ---
const zero = () => ({ x: 0, y: 0, width: 0, height: 0 });

type DynamicTextInfo = {
  origin: Origin;
  normalizedVariableName?: string;
};

/** The first root DoAction (frame 1's init script), where a shell defines its
 *  functions and kicks off its startup loads. */
function firstFrameDoAction(movie: any): Uint8Array | undefined {
  for (const t of movie.tags) {
    if (t.type === swf.TagType.DoAction) return t.actions;
    if (t.type === swf.TagType.ShowFrame) return undefined;
  }
  return undefined;
}

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
    normalizedVariableName: t.variableName ? normalizeBindingName(t.variableName) : undefined,
  };
  return { id: t.id, kind: "text", src: `generated/${scene}/texts/${t.id}.txt`, origin: { x: text.x, y: text.y, width: w, height: h }, text };
}

function dynamicTextInfo(movie: any): Map<number, DynamicTextInfo> {
  const out = new Map<number, DynamicTextInfo>();
  for (const t of movie.tags) {
    if (t.type !== swf.TagType.DefineDynamicText || !t.id) continue;
    const b = t.bounds;
    out.set(Number(t.id), {
      origin: b
        ? { x: b.xMin / 20, y: b.yMin / 20, width: (b.xMax - b.xMin) / 20, height: (b.yMax - b.yMin) / 20 }
        : zero(),
      normalizedVariableName: t.variableName ? normalizeBindingName(t.variableName) : undefined,
    });
  }
  return out;
}

function soundExportNames(movie: any): Map<number, string> {
  const out = new Map<number, string>();
  const exportAssets = (swf.TagType as any).ExportAssets ?? 35;
  for (const tag of movie.tags) {
    if (tag.type !== exportAssets) continue;
    for (const asset of tag.assets ?? []) {
      if (typeof asset.id !== "number" || !asset.name) continue;
      out.set(asset.id, String(asset.name));
    }
  }
  return out;
}

function soundDurationMs(tag: any): number | undefined {
  const samples = Number(tag.sampleCount);
  const rate = swfSoundRate(tag.soundRate);
  return Number.isFinite(samples) && samples > 0 && rate > 0 ? (samples / rate) * 1000 : undefined;
}

function swfSoundRate(soundRate: number): number {
  const rates = [5512, 11025, 22050, 44100];
  return soundRate <= 3 ? rates[soundRate] : Number(soundRate) || 0;
}

function buttonTextFields(button: any, dynamicTexts: Map<number, DynamicTextInfo>): { id: number; matrix: Matrix }[] {
  const fields: { id: number; matrix: Matrix }[] = [];
  const seen = new Set<string>();
  for (const rec of button.records ?? []) {
    if (!rec.stateUp) continue;
    const id = Number(rec.characterId);
    const info = dynamicTexts.get(id);
    if (!info?.normalizedVariableName) continue;
    const matrix = matrixFromButtonRecord(rec.matrix);
    const key = `${id}:${matrix.a},${matrix.b},${matrix.c},${matrix.d},${matrix.tx},${matrix.ty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push({ id, matrix });
  }
  return fields;
}

function buttonTextOrigin(fields: { id: number; matrix: Matrix }[], dynamicTexts: Map<number, DynamicTextInfo>): Origin | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const field of fields) {
    const origin = dynamicTexts.get(field.id)?.origin;
    if (!origin) continue;
    const { x, y, width, height } = origin;
    for (const [px, py] of [[x, y], [x + width, y], [x, y + height], [x + width, y + height]]) {
      const bx = field.matrix.a * px + field.matrix.c * py + field.matrix.tx;
      const by = field.matrix.b * px + field.matrix.d * py + field.matrix.ty;
      minX = Math.min(minX, bx); minY = Math.min(minY, by);
      maxX = Math.max(maxX, bx); maxY = Math.max(maxY, by);
    }
  }
  return Number.isFinite(minX) ? { x: -minX, y: -minY, width: maxX - minX, height: maxY - minY } : undefined;
}

function normalizeBindingName(name: string): string {
  return String(name).replace(/^_root\./, "").split(".").pop() ?? String(name);
}

function controlledSpriteIds(control: ExtractedControl): Set<string> {
  const ids = new Set<string>(Object.keys(control.spriteStopFrames ?? {}));
  for (const record of control.spriteActions ?? []) {
    if (typeof record.spriteId === "number") ids.add(String(record.spriteId));
  }
  for (const def of Object.values(control.definedFunctions ?? {})) {
    if (def.scope === "sprite" && def.spriteId !== undefined) ids.add(String(def.spriteId));
  }
  return ids;
}

function spriteTimelineFrames(frames: any[]): any[] {
  return frames.map((frame) => ({
    index: frame.index,
    ...(frame.label ? { label: frame.label } : {}),
    instances: frame.instances ?? [],
  }));
}

function backgroundColor(movie: any): string {
  const bg = movie.tags.find((t: any) => t.type === swf.TagType.SetBackgroundColor)?.color;
  return bg ? `#${hx(bg.r)}${hx(bg.g)}${hx(bg.b)}` : "#ffffff";
}

const hx = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");
function asArray(v: any): any[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}
