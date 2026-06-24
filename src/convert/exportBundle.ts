import type { CompiledScene } from "./compileScene.ts";
import { applyInheritedDefaultsGraph } from "./inheritedDefaults.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

type ArchiveIndex = {
  format: string;
  version: number;
  scenes: Record<string, { offset: number; length: number }>;
};

type ArchiveSceneHeader = {
  timeline: CompiledScene["timeline"];
  shapes?: Record<string, string>;
  media?: Record<string, { offset: number; length: number; type: string }>;
};

type LegacyBitmapImage = {
  width: number;
  height: number;
  href: string;
};

export function exportArchiveForScenes(scenes: CompiledScene[], vars?: Record<string, string>): Uint8Array {
  if (scenes[0]) applyInheritedDefaultsGraph(scenes[0], scenes);

  const blocks: Array<{ scene: string; bytes: Uint8Array }> = [];
  for (const scene of scenes) blocks.push({ scene: scene.scene, bytes: sceneBlock(scene) });

  // loadVariables() text (e.g. nav.txt) baked into the index so the exported pack is a
  // single self-contained file the embed player resolves with no extra requests.
  const index: { format: string; version: number; scenes: Record<string, { offset: number; length: number }>; vars?: Record<string, string> } = {
    format: "mmtour-archive",
    version: 1,
    scenes: {},
    ...(vars && Object.keys(vars).length ? { vars } : {}),
  };
  let offset = 0;
  for (const block of blocks) {
    index.scenes[block.scene] = { offset, length: block.bytes.byteLength };
    offset += block.bytes.byteLength;
  }

  const indexBytes = enc.encode(JSON.stringify(index));
  return concat([u32(indexBytes.byteLength), indexBytes, ...blocks.map((block) => block.bytes)]);
}

export function downloadBytes(bytes: Uint8Array, filename: string, type = "application/octet-stream") {
  const blob = new Blob([bytes.slice().buffer], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importArchiveScenes(bytes: Uint8Array): Promise<CompiledScene[]> {
  if (bytes.byteLength < 4) throw new Error("Pack is too small");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const indexLength = view.getUint32(0, true);
  const blocksStart = 4 + indexLength;
  if (indexLength <= 0 || blocksStart > bytes.byteLength) throw new Error("Pack index is invalid");

  const index = await decodeJson<ArchiveIndex>(bytes.slice(4, blocksStart));
  if (index.format !== "mmtour-archive" || !index.scenes) throw new Error("Not an mmTour archive");

  const scenes: CompiledScene[] = [];
  for (const [scene, loc] of Object.entries(index.scenes)) {
    const blockStart = blocksStart + loc.offset;
    const blockEnd = blockStart + loc.length;
    if (blockStart < blocksStart || blockEnd > bytes.byteLength) continue;
    const block = bytes.slice(blockStart, blockEnd);
    const compiled = await importSceneBlock(scene, block);
    if (compiled) scenes.push(compiled);
  }
  if (scenes[0]) applyInheritedDefaultsGraph(scenes[0], scenes);
  return scenes;
}

function sceneBlock(scene: CompiledScene): Uint8Array {
  const shapes: Record<string, string> = {};
  const media: Record<string, { offset: number; length: number; type: string }> = {};
  const mediaBytes: Uint8Array[] = [];
  let mediaOffset = 0;

  for (const [path, file] of scene.files) {
    if (path === "timeline.json") continue;
    const generatedPath = `generated/${scene.scene}/${path}`;
    if (path.endsWith(".svg")) {
      shapes[generatedPath] = dec.decode(file.bytes);
      continue;
    }
    media[generatedPath] = {
      offset: mediaOffset,
      length: file.bytes.byteLength,
      type: file.type,
    };
    mediaBytes.push(file.bytes);
    mediaOffset += file.bytes.byteLength;
  }

  const header = enc.encode(JSON.stringify({ timeline: scene.timeline, shapes, media }));
  return concat([u32(header.byteLength), header, ...mediaBytes]);
}

async function importSceneBlock(scene: string, block: Uint8Array): Promise<CompiledScene | null> {
  if (block.byteLength < 4) return null;
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const headerLength = view.getUint32(0, true);
  const bodyStart = 4 + headerLength;
  if (headerLength <= 0 || bodyStart > block.byteLength) return null;

  const header = await decodeJson<ArchiveSceneHeader>(block.slice(4, bodyStart));
  if (!header.timeline) return null;

  const files = new Map<string, { type: string; bytes: Uint8Array }>();
  files.set("timeline.json", { type: "application/json", bytes: enc.encode(JSON.stringify(header.timeline)) });

  const mediaFiles = new Map<string, { type: string; bytes: Uint8Array }>();
  const legacyBitmapImages = new Map<number, LegacyBitmapImage>();
  for (const [ref, media] of Object.entries(header.media ?? {})) {
    const start = bodyStart + media.offset;
    const end = start + media.length;
    if (start < bodyStart || end > block.byteLength) continue;
    const mediaBytes = block.slice(start, end);
    mediaFiles.set(ref, { type: media.type, bytes: mediaBytes });
    const bitmapId = bitmapIdFromMediaRef(ref);
    const size = bitmapId === undefined ? undefined : imageDimensions(media.type, mediaBytes);
    if (bitmapId !== undefined && size) {
      legacyBitmapImages.set(bitmapId, {
        ...size,
        href: `data:${media.type};base64,${bytesToBase64(mediaBytes)}`,
      });
    }
  }

  for (const [ref, svg] of Object.entries(header.shapes ?? {})) {
    const upgraded = repairLegacyBitmapFillSvg(svg, legacyBitmapImages);
    files.set(sceneRelativePath(scene, ref), { type: "image/svg+xml", bytes: enc.encode(upgraded) });
  }
  for (const [ref, file] of mediaFiles) {
    files.set(sceneRelativePath(scene, ref), file);
  }

  const timeline = header.timeline;
  const width = Math.round(timeline.dimensions?.width ?? 0);
  const height = Math.round(timeline.dimensions?.height ?? 0);
  return {
    scene,
    timeline,
    files,
    stats: statsFromTimeline(timeline, files),
    width,
    height,
    dependencies: dependenciesFromTimeline(timeline),
  };
}

async function decodeJson<T>(bytes: Uint8Array): Promise<T> {
  const text = await inflateMaybe(bytes);
  return JSON.parse(text) as T;
}

async function inflateMaybe(bytes: Uint8Array): Promise<string> {
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (isGzip) {
    if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot decompress this pack");
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }
  return dec.decode(bytes);
}

function sceneRelativePath(scene: string, ref: string): string {
  const normalized = ref.replace(/^\//, "");
  const prefix = `generated/${scene}/`;
  if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  return normalized.replace(/^generated\/[^/]+\//, "");
}

function statsFromTimeline(timeline: CompiledScene["timeline"], files: Map<string, { bytes: Uint8Array }>): CompiledScene["stats"] {
  const assets = Object.values(timeline.assets ?? {}) as Array<{ kind?: string }>;
  const count = (kind: string) => assets.filter((asset) => asset?.kind === kind).length;
  return {
    shapes: count("shape"),
    images: count("image"),
    fonts: count("font"),
    sounds: count("sound"),
    buttons: count("button"),
    texts: count("text"),
    frames: timeline.frameCount ?? timeline.frames?.length ?? 0,
    sprites: count("sprite"),
    stopFrames: timeline.control?.stopFrames?.length ?? 0,
    assetBytes: [...files.values()].reduce((sum, file) => sum + file.bytes.byteLength, 0),
    ms: 0,
  };
}

function dependenciesFromTimeline(timeline: CompiledScene["timeline"]): CompiledScene["dependencies"] {
  const seen = new Map<string, { swf: string; level?: number }>();
  const add = (swf: unknown, level: unknown) => {
    if (typeof swf !== "string" || !/\.swf$/i.test(swf)) return;
    const key = canonicalSwf(swf);
    if (key === canonicalSwf(timeline.source ?? timeline.scene)) return;
    if (!seen.has(key)) seen.set(key, { swf, ...(typeof level === "number" ? { level } : {}) });
  };
  const visit = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    add(record.swf, record.level);
    visit(record.loads);
    for (const item of Object.values(record)) visit(item);
  };
  visit(timeline.control);
  return [...seen.values()];
}

function canonicalSwf(name: string): string {
  return name.replace(/\.swf$/i, "").replace(/[^\w.-]+/g, "-").toLowerCase();
}

function bitmapIdFromMediaRef(ref: string): number | undefined {
  const id = ref.match(/\/images\/(\d+)\.[a-z0-9]+$/i)?.[1];
  return id ? Number(id) : undefined;
}

function repairLegacyBitmapFillSvg(svg: string, images: Map<number, LegacyBitmapImage>): string {
  if (!svg.includes("data-bitmap-fill")) return svg;
  const defs: string[] = [];
  let index = 0;
  const repaired = svg.replace(/<path\b([^>]*?)\bdata-bitmap-fill="(\d+)"([^>]*)\/?>/g, (match, before: string, idRaw: string, after: string) => {
    const bitmap = images.get(Number(idRaw));
    const d = attrValue(`${before} ${after}`, "d");
    const bounds = d ? pathBounds(d) : undefined;
    if (!bitmap || !d || !bounds) return match;
    const patternId = `LegacyBitmapFill_${idRaw}_${index++}`;
    defs.push(legacyPatternDef(patternId, bitmap, bounds));
    const fillRule = attrValue(`${before} ${after}`, "fill-rule") ?? "evenodd";
    return `<path d="${escapeAttr(d)}" fill="url(#${patternId})" fill-rule="${escapeAttr(fillRule)}" stroke="none"/>`;
  });
  if (!defs.length) return repaired;
  const defsBlock = `<defs>${defs.join("")}</defs>`;
  if (repaired.includes("<defs>")) return repaired.replace("<defs>", `<defs>${defs.join("")}`);
  return repaired.replace(/(<svg\b[^>]*>)/, `$1${defsBlock}`);
}

function legacyPatternDef(id: string, image: LegacyBitmapImage, bounds: { x: number; y: number; width: number; height: number }): string {
  let scaleX = image.width ? bounds.width / image.width : 1;
  let scaleY = image.height ? bounds.height / image.height : 1;
  const larger = Math.max(Math.abs(scaleX), Math.abs(scaleY));
  if (larger > 0 && Math.abs(scaleX - scaleY) / larger < 0.03) {
    scaleX = larger;
    scaleY = larger;
  }
  return (
    `<pattern id="${escapeAttr(id)}" patternUnits="userSpaceOnUse" overflow="visible" ` +
    `viewBox="0 0 ${num(image.width)} ${num(image.height)}" width="${num(image.width)}" height="${num(image.height)}" ` +
    `patternTransform="matrix(${num(scaleX)} 0 0 ${num(scaleY)} ${num(bounds.x)} ${num(bounds.y)})">` +
    `<image width="${num(image.width)}" height="${num(image.height)}" style="image-rendering:optimizeQuality" xlink:href="${escapeAttr(image.href)}"/>` +
    `</pattern>`
  );
}

function imageDimensions(type: string, bytes: Uint8Array): { width: number; height: number } | undefined {
  if (type.includes("png") && bytes.byteLength >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }
  if (type.includes("jpeg") || type.includes("jpg")) {
    return jpegDimensions(bytes);
  }
  return undefined;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.byteLength) return undefined;
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof && length >= 7) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return undefined;
}

function attrValue(attrs: string, name: string): string | undefined {
  return attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function pathBounds(d: string): { x: number; y: number; width: number; height: number } | undefined {
  const values = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (values.length < 2) return undefined;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < values.length; i += 2) {
    const x = values[i];
    const y = values[i + 1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : undefined;
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

function num(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
