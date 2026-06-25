// In-browser scene compiler: SWF bytes → a playable bundle (asset files +
// timeline.json) the GSAP player consumes with no server. Reuses the verified
// fs-free builders (swf-parser adapter + buildFrames) and the pure-TS asset
// converters; writes every asset into an in-memory file map keyed by the same
// scene-relative paths the player's pack source expects.

import { parseSwf, swf } from "swf-parser";
import type { ControlAction, FrameActionRecord, Matrix, Origin } from "../data/timelineTypes";
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
import type { BitmapFillImage } from "./svgEmit.ts";
import { extractControl, detectDependencies, detectExternalAssets, buttonEventsFromConditions, type ExtractedControl, type ExternalAssetRef, type SwfDependency } from "./avm1Control.ts";
import { parseProgram } from "./avm1/parse.ts";
import { addProgramCoverage, createAvm1Coverage } from "./avm1/coverage.ts";
import { runInit } from "./avm1/interp.ts";
import { enrichSoundMetadata } from "./soundMetadata.ts";
import { enrichControlWithTimelineData } from "./controlEnrichment.ts";

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
  /** External media/data files referenced by the SWF or companion data, for warnings only. */
  externalAssets: ExternalAssetRef[];
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
  const soundLibrary: Record<string, { id: number; name: string; src: string; durationMs?: number; aliases?: string[] }> = {};
  const { bitmaps, jpegTables } = collectBitmaps(movie);
  const bitmapFillImages = new Map<number, BitmapFillImage>();
  const bitmapFill = (id: number) => bitmapFillImages.get(id);

  // --- images ---
  for (const tag of bitmaps) {
    try {
      const { ext, mime, bytes: imgBytes } = await bitmapBytes(tag, jpegTables);
      put(`images/${tag.id}.${ext}`, mime, imgBytes);
      assets[String(tag.id)] ??= { id: tag.id, kind: "image", src: `generated/${scene}/images/${tag.id}.${ext}`, origin: zero() };
      bitmapFillImages.set(Number(tag.id), {
        width: Number(tag.width) || 0,
        height: Number(tag.height) || 0,
        // Keep the inline data URI for callers that need a self-contained SVG (e.g.
        // legacy bitmap-fill repair), but reference the extracted image file in the
        // emitted shape so the stored SVG carries no duplicated base64. The runtime
        // re-inlines the bytes when it builds the shape Blob (shapeBitmapInline.ts).
        href: `data:${mime};base64,${bytesToBase64(imgBytes)}`,
        ref: `generated/${scene}/images/${tag.id}.${ext}`,
      });
      stats.images++;
    } catch { /* skip */ }
  }

  // --- shapes ---
  for (const tag of movie.tags) {
    if (tag.type !== swf.TagType.DefineShape) continue;
    try {
      const svg = defineShapeToSvg(tag, { bitmapFill }).svg;
      put(`shapes/${tag.id}.svg`, "image/svg+xml", svg);
      assets[String(tag.id)] = { id: tag.id, kind: "shape", src: `generated/${scene}/shapes/${tag.id}.svg`, origin: svgOrigin(svg) };
      stats.shapes++;
    } catch { /* skip a bad shape */ }
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
        const lower = name.toLowerCase();
        const entry = {
          id: tag.id,
          name,
          src,
          durationMs: soundDurationMs(tag),
          ...(lower !== name ? { aliases: [lower] } : {}),
        };
        soundLibrary[name] = entry;
      }
      stats.sounds++;
    } catch { /* skip */ }
  }

  // --- control ---
  const control = extractControl(movie);
  enrichSoundMetadata(control, soundLibrary);
  const externalAssets = detectExternalAssets(movie);

  // --- buttons ---
  const dynamicTexts = dynamicTextInfo(movie);
  const controlDynamicTexts: Record<string, any> = {};
  const shapesById = new Map<number, any>();
  for (const t of movie.tags) if (t.type === swf.TagType.DefineShape) shapesById.set(t.id, t);
  for (const button of collectButtons(movie)) {
    try {
      const composed = composeButton(button, (cid) => shapesById.get(cid), { bitmapFill });
      const states: Record<string, any> = {};
      const hasButtonControl = Boolean(control.buttonActions?.[String(button.id)]);
      for (const [stateFile, svgStr] of Object.entries(composed.states)) {
        const origin = svgOrigin(svgStr);
        if (!/<path|<image|<use/.test(svgStr) && origin.width <= 0 && origin.height <= 0 && !hasButtonControl) continue;
        const path = `buttons/${composed.dir}/${stateFile}.svg`;
        put(path, "image/svg+xml", svgStr);
        const rawStateName = stateFile.replace(/^\d+_/, "");
        const stateName = rawStateName === "hittest" ? "hit" : rawStateName;
        const entry = { src: `generated/${scene}/${path}`, origin };
        states[stateName] = entry;
        if (rawStateName === "hittest") states.hittest = entry;
      }
      const textFields = buttonTextFields(button, dynamicTexts);
      const textOrigin = buttonTextOrigin(textFields, dynamicTexts);
      if (textOrigin) {
        ensureButtonStatePlaceholders(scene, composed.dir, states, textOrigin, put);
      }
      if (Object.keys(states).length || textFields.length) {
        const firstState = Object.values(states)[0] as any | undefined;
        const origin = states.up?.origin ?? firstState?.origin ?? textOrigin ?? zero();
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
      if (text.text.normalizedVariableName) controlDynamicTexts[String(t.id)] = { characterId: t.id, ...text.text };
      stats.texts++;
    } else if (t.type === swf.TagType.DefineText) {
      const content = reconstructText(t, fonts);
      if (!content) continue;
      put(`texts/${t.id}.txt`, "text/plain", content);
      const b = t.bounds;
      const text = staticTextStyle(t, content);
      assets[String(t.id)] ??= {
        id: t.id, kind: "text", src: `generated/${scene}/texts/${t.id}.txt`,
        origin: b ? { x: b.xMin / 20, y: b.yMin / 20, width: (b.xMax - b.xMin) / 20, height: (b.yMax - b.yMin) / 20 } : zero(),
        text,
      };
      stats.texts++;
    }
  }

  // --- timeline (display list) ---
  const frames = buildFrames(tags);
  const spriteTimelines = new Map<string, any[]>();

  // Sprite assets so the runtime can instantiate nested MovieClips. Some SWFs
  // use script-only sprites as timers/controllers: they have ShowFrame/DoAction
  // tags but no visual PlaceObject tags, so preserve their empty timelines too.
  for (const t of tags) {
    if (t.type !== "DefineSpriteTag" || !t.spriteId) continue;
    if (!asArray(t.subTags?.item).length) continue;
    const id = String(t.spriteId);
    const spriteFrames = buildFrames(asArray(t.subTags?.item));
    assets[id] ??= { id: Number(t.spriteId), kind: "sprite", origin: zero() };
    if (spriteFrames.length) spriteTimelines.set(id, spriteTimelineFrames(spriteFrames));
  }
  attachSpriteTimelines(assets, tags);
  for (const [id, spriteTimeline] of spriteTimelines) {
    const asset = assets[id];
    if (asset?.kind === "sprite" && !asset.timeline?.length) asset.timeline = spriteTimeline;
  }
  inferSpriteBoundsAndOverflow(assets, control.spriteStopFrames);
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
      const r = runInit(parseProgram(initBytes));
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
  const startupActions: ControlAction[] = [
    ...initLoads.map((l): ControlAction => ({ command: "loadMovieNum", swf: l.swf, level: l.level, executionContext: "timeline" })),
    ...(initCalls.length
      ? [{
          command: "callFunctions",
          functionCalls: initCalls.map((c) => ({ target: c.target, functionName: c.name, arguments: c.args ?? "" })),
          executionContext: "timeline",
        } satisfies ControlAction]
      : []),
  ];
  const deferredStartupActions: FrameActionRecord[] = startupActions.length
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
  const frameActions: FrameActionRecord[] = [...extractedFrameActions, ...deferredStartupActions];

  const fr = movie.header.frameSize;
  const width = Math.round((fr.xMax - fr.xMin) / 20);
  const height = Math.round((fr.yMax - fr.yMin) / 20);
  const fps = movie.header.frameRate?.epsilons ? movie.header.frameRate.epsilons / 256 : Number(movie.header.frameRate) || 15;

  const timelineControl = enrichControlWithTimelineData({
    stopFrames: control.stopFrames,
    spriteStopFrames: control.spriteStopFrames,
    spriteActions: control.spriteActions,
    frameActions,
    definedFunctions: control.definedFunctions,
    buttonActions: control.buttonActions,
    soundLibrary,
    spriteLocalDefaults: inferSpriteLocalDefaults(control.spriteActions),
    dynamicTexts: controlDynamicTexts,
    externalAssets,
    globalDefaults,
    avm1Coverage: buildAvm1Coverage(movie),
    initActions: control.initActions,
    frameBytecode: control.frameBytecode,
    registeredClasses: control.registeredClasses,
  }, assets, labels);

  // Symbol linkage (export name → id), computed once `assets` is fully built.
  // Feed the per-asset linkageNames the player's attachMovie() reads, so
  // studio-converted AS2 apps can attach their own library clips by name — and
  // keep the name→id map for the runtime VM host.
  const linkage = exportLinkage(movie);
  for (const [name, id] of Object.entries(linkage)) {
    const asset = (assets as Record<string, { linkageNames?: string[] }>)[String(id)];
    if (asset) (asset.linkageNames ??= []).push(name);
  }

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
    control: timelineControl,
    frameSvgs: [],
    bitmapFillShapeSrcs: bitmapFillShapeSrcs(scene, files),
    linkage,
    assets,
    frames,
  };

  put("timeline.json", "application/json", JSON.stringify(timeline));
  for (const f of files.values()) stats.assetBytes += f.bytes.length;
  stats.ms = Math.round(performance.now() - t0);

  return { scene, timeline, files, stats, width, height, dependencies: detectDependencies(movie), externalAssets };
}

// --- helpers ---
const zero = () => ({ x: 0, y: 0, width: 0, height: 0 });

const sharedDecoder = new TextDecoder();
/** Scene-relative srcs of SVGs that reference an external extracted image (their
 *  bitmap fills were emitted as `generated/.../images/<id>` refs, not base64). The
 *  runtime pre-inlines these when media isn't in memory (files/bundle modes). */
function bitmapFillShapeSrcs(scene: string, files: Map<string, { bytes: Uint8Array }>): string[] {
  const out: string[] = [];
  for (const [path, file] of files) {
    if (!path.endsWith(".svg")) continue;
    const svg = sharedDecoder.decode(file.bytes);
    if (svg.includes('href="generated/') && svg.includes("/images/")) out.push(`generated/${scene}/${path}`);
  }
  return out;
}

function buildAvm1Coverage(movie: any) {
  const coverage = createAvm1Coverage();
  scanAvm1CoverageTimeline(coverage, movie.tags ?? [], "root", undefined);
  return coverage;
}

function scanAvm1CoverageTimeline(
  coverage: ReturnType<typeof createAvm1Coverage>,
  tags: any[],
  scope: "root" | "sprite",
  spriteId?: number,
) {
  let frame = 0;
  for (const tag of tags ?? []) {
    if (tag.type === swf.TagType.DoAction) {
      addParsedCoverage(coverage, tag.actions, {
        source: scope === "sprite" ? "spriteFrame" : "rootFrame",
        scope,
        spriteId,
        frame,
        path: scope === "sprite"
          ? `DefineSprite_${spriteId}/frame_${frame + 1}/DoAction`
          : `root/frame_${frame + 1}/DoAction`,
      });
      continue;
    }
    if (tag.type === swf.TagType.DefineSprite) {
      scanAvm1CoverageTimeline(coverage, tag.tags ?? [], "sprite", tag.id);
      continue;
    }
    if (tag.type === swf.TagType.DefineButton) {
      for (let index = 0; index < (tag.actions ?? []).length; index += 1) {
        const action = tag.actions[index];
        addParsedCoverage(coverage, action.actions, {
          source: "buttonAction",
          scope: "button",
          buttonId: tag.id,
          events: buttonEventsFromConditions(action.conditions ?? {}),
          path: `DefineButton_${tag.id}/action_${index + 1}`,
        });
      }
      continue;
    }
    if (tag.type === swf.TagType.ShowFrame) frame += 1;
  }
}

function addParsedCoverage(
  coverage: ReturnType<typeof createAvm1Coverage>,
  bytes: Uint8Array,
  location: Parameters<typeof addProgramCoverage>[2],
) {
  try {
    addProgramCoverage(coverage, parseProgram(bytes), location);
  } catch {
    // Keep browser conversion best-effort: malformed action blocks should not
    // prevent assets/timelines from being produced.
  }
}

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

function bytesToBase64(bytes: Uint8Array): string {
  const nodeBuffer = (globalThis as any).Buffer;
  if (nodeBuffer) return nodeBuffer.from(bytes).toString("base64");
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
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

function staticTextStyle(t: any, content: string) {
  const b = t.bounds;
  const firstRecord = (t.records ?? []).find((record: any) => record.fontId !== undefined || record.fontSize !== undefined || record.color);
  const width = b ? (b.xMax - b.xMin) / 20 : 0;
  const height = b ? (b.yMax - b.yMin) / 20 : 0;
  return {
    fontId: firstRecord?.fontId,
    fontHeight: firstRecord?.fontSize ? firstRecord.fontSize / 20 : 12,
    color: firstRecord?.color ? `#${hx(firstRecord.color.r)}${hx(firstRecord.color.g)}${hx(firstRecord.color.b)}` : undefined,
    align: "center",
    x: b ? b.xMin / 20 : 0,
    // FFDec positions static DefineText at the tag registration and keeps vertical
    // alignment in the glyph records; matching that avoids pushing section titles down.
    y: 0,
    width: width || undefined,
    height: height || undefined,
    wordWrap: false,
    multiline: false,
    text: content,
  };
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

/** Linkage/export name → character id, for runtime attachMovie("symbolName").
 *  Covers every ExportAssets/SymbolClass entry (clips, not just sounds). */
function exportLinkage(movie: any): Record<string, number> {
  const out: Record<string, number> = {};
  const exportAssets = (swf.TagType as any).ExportAssets ?? 35;
  const symbolClass = (swf.TagType as any).SymbolClass ?? 76;
  for (const tag of movie.tags) {
    if (tag.type !== exportAssets && tag.type !== symbolClass) continue;
    for (const asset of tag.assets ?? tag.symbols ?? []) {
      const name = asset.name ?? asset.className;
      if (typeof asset.id !== "number" || !name) continue;
      out[String(name)] = asset.id;
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

function ensureButtonStatePlaceholders(
  scene: string,
  dir: string,
  states: Record<string, any>,
  origin: Origin,
  put: (path: string, type: string, data: Uint8Array | string) => void,
) {
  const files = [
    { file: "1_up", keys: ["up"] },
    { file: "2_over", keys: ["over"] },
    { file: "3_down", keys: ["down"] },
    { file: "4_hittest", keys: ["hit", "hittest"] },
  ];
  for (const { file, keys } of files) {
    if (keys.every((key) => states[key]?.src)) continue;
    const path = `buttons/${dir}/${file}.svg`;
    const entry = { src: `generated/${scene}/${path}`, origin };
    put(path, "image/svg+xml", blankButtonStateSvg(origin));
    for (const key of keys) states[key] ??= entry;
  }
}

function blankButtonStateSvg(origin: Origin): string {
  return `<svg xmlns:xlink="http://www.w3.org/1999/xlink" height="${svgNum(origin.height)}px" width="${svgNum(origin.width)}px" xmlns="http://www.w3.org/2000/svg"><g transform="matrix(1.0, 0.0, 0.0, 1.0, ${svgNum(origin.x)}, ${svgNum(origin.y)})"/></svg>`;
}

function svgNum(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function inferSpriteLocalDefaults(spriteActions: Array<{ spriteId?: number; actions?: any[] }>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const record of spriteActions ?? []) {
    if (typeof record.spriteId !== "number") continue;
    const key = String(record.spriteId);
    for (const action of record.actions ?? []) {
      if (action.command !== "setVariable" || action.executionContext === "branch") continue;
      if (!isSimpleLocalName(action.target) || out[key]?.[action.target] !== undefined) continue;
      const value = action.value ?? literalFromRaw(action.rawValue);
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
      out[key] ??= {};
      out[key][action.target] = value;
    }
  }
  return Object.fromEntries(Object.entries(out).filter(([, values]) => Object.keys(values).length));
}

function literalFromRaw(raw: unknown): string | number | boolean | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

function isSimpleLocalName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z_$][\w$]*$/.test(name) && !/^(true|false|null|undefined|this|_root|_global|_parent|_level\d+)$/.test(name);
}

function inferSpriteBoundsAndOverflow(assets: Record<string, any>, spriteStopFrames: Record<string, number[]> = {}) {
  const visiting = new Set<number>();
  const boundsForSprite = (asset: any): Origin | undefined => {
    if (!asset || asset.kind !== "sprite" || !asset.timeline?.length) return asset?.origin;
    if (asset.__boundsReady) return asset.origin;
    if (visiting.has(asset.id)) return asset.origin;
    visiting.add(asset.id);
    const frameBoxes = asset.timeline
      .map((frame: any) => frameBounds(frame, assets, boundsForSprite))
      .filter(Boolean) as Origin[];
    const first = frameBoxes[0];
    const all = unionBounds(frameBoxes);
    visiting.delete(asset.id);
    if (first) asset.origin = first;
    if (first && all && !hasClipMask(asset.timeline) && (overflows(first, all) || hasSignificantBoundsMotion(frameBoxes))) {
      asset.overflowsBounds = true;
    }
    Object.defineProperty(asset, "__boundsReady", { value: true, enumerable: false, configurable: true });
    return asset.origin;
  };

  for (const asset of Object.values(assets)) boundsForSprite(asset);
  propagateOverflowFlags(assets, spriteStopFrames);
  for (const asset of Object.values(assets)) delete asset.__boundsReady;
}

function propagateOverflowFlags(assets: Record<string, any>, spriteStopFrames: Record<string, number[]>) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const asset of Object.values(assets)) {
      if (asset?.kind !== "sprite" || asset.overflowsBounds || !asset.timeline?.length || hasClipMask(asset.timeline)) continue;
      if (!hasOverflowingChild(asset, assets) && !hasDeferredHoverTimeline(asset.timeline, spriteStopFrames[String(asset.id)] ?? [])) continue;
      asset.overflowsBounds = true;
      changed = true;
    }
  }
}

function frameBounds(frame: any, assets: Record<string, any>, spriteBounds: (asset: any) => Origin | undefined): Origin | undefined {
  const bounds: Origin[] = [];
  for (const instance of frame?.instances ?? []) {
    const child = assets[String(instance.characterId)] ?? assets[`button:${instance.characterId}`];
    const origin = child?.kind === "sprite" ? spriteBounds(child) : child?.origin;
    if (!origin || (!origin.width && !origin.height)) continue;
    bounds.push(transformedBounds(origin, instance.matrix ?? { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }));
  }
  return unionBounds(bounds);
}

function transformedBounds(origin: Origin, matrix: Matrix): Origin {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of [
    [origin.x, origin.y],
    [origin.x + origin.width, origin.y],
    [origin.x, origin.y + origin.height],
    [origin.x + origin.width, origin.y + origin.height],
  ]) {
    const px = matrix.a * x + matrix.c * y + matrix.tx;
    const py = matrix.b * x + matrix.d * y + matrix.ty;
    minX = Math.min(minX, px); minY = Math.min(minY, py);
    maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function unionBounds(bounds: Origin[]): Origin | undefined {
  if (!bounds.length) return undefined;
  const minX = Math.min(...bounds.map((b) => b.x));
  const minY = Math.min(...bounds.map((b) => b.y));
  const maxX = Math.max(...bounds.map((b) => b.x + b.width));
  const maxY = Math.max(...bounds.map((b) => b.y + b.height));
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : undefined;
}

function hasClipMask(frames: any[]): boolean {
  return (frames ?? []).some((frame) => (frame.instances ?? []).some((instance: any) => instance.clipDepth));
}

function hasOverflowingChild(asset: any, assets: Record<string, any>): boolean {
  return (asset.timeline ?? []).some((frame: any) => (frame.instances ?? []).some((instance: any) => {
    const child = assets[String(instance.characterId)] ?? assets[`button:${instance.characterId}`];
    return child?.kind === "sprite" && child.overflowsBounds;
  }));
}

function hasDeferredHoverTimeline(frames: any[], stopFrames: number[]): boolean {
  const overFrame = frames.findIndex((frame) => frame.label === "over");
  const outFrame = frames.findIndex((frame) => frame.label === "out");
  return overFrame > 0 && outFrame > overFrame && stopFrames.includes(0) && stopFrames.length >= 3;
}

function overflows(base: Origin, all: Origin): boolean {
  const tolerance = 20;
  return all.x < base.x - tolerance
    || all.y < base.y - tolerance
    || all.x + all.width > base.x + base.width + tolerance
    || all.y + all.height > base.y + base.height + tolerance;
}

function hasSignificantBoundsMotion(bounds: Origin[]): boolean {
  if (bounds.length <= 2) return false;
  const tolerance = 20;
  const xs = bounds.map((b) => b.x);
  const ys = bounds.map((b) => b.y);
  const rights = bounds.map((b) => b.x + b.width);
  const bottoms = bounds.map((b) => b.y + b.height);
  const widths = bounds.map((b) => b.width);
  const heights = bounds.map((b) => b.height);
  return span(xs) > tolerance
    || span(ys) > tolerance
    || span(rights) > tolerance
    || span(bottoms) > tolerance
    || span(widths) > tolerance
    || span(heights) > tolerance;
}

function span(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) - Math.min(...finite) : 0;
}

function normalizeBindingName(name: string): string {
  return String(name).replace(/^_root\./, "").split(".").pop() ?? String(name);
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
