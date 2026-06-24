// Browser-native SWF bitmap decoder (Route B). Replaces FFDec's `image:png`
// export. SWF stores three image flavors, all surfaced by swf-parser as
// `DefineBitmap { width, height, mediaType, data }`:
//   - image/jpeg              → a complete JPEG (sometimes with an erroneous
//                               FF D9 FF D8 prefix that must be stripped)
//   - image/x-swf-partial-jpeg → a JPEG missing its tables; the shared
//                               DefineJpegTables stream supplies DQT/DHT
//   - image/x-swf-jpeg3/4     → [jpegLength:u32le][JPEG bytes][zlib alpha]
//   - image/x-swf-lossless / 2 → zlib-compressed palette or direct-color pixels
//
// JPEGs need no pixel decode here — we reconstruct standalone JPEG bytes and let
// the platform decoder (browser <img>/createImageBitmap) handle them. JPEG3/4
// with alpha and lossless images are unpacked to RGBA for PNG encoding.

import { swf } from "swf-parser";

export interface BitmapSet {
  bitmaps: any[];
  jpegTables?: Uint8Array;
}

/** Gather all DefineBitmap tags and the shared JPEG tables (if any). */
export function collectBitmaps(movie: any): BitmapSet {
  const bitmaps = movie.tags.filter((t: any) => t.type === swf.TagType.DefineBitmap);
  const jt = movie.tags.find((t: any) => t.type === swf.TagType.DefineJpegTables);
  return { bitmaps, jpegTables: jt?.data };
}

export function isJpegBitmap(tag: any): boolean {
  return tag.mediaType === "image/jpeg"
    || tag.mediaType === "image/x-swf-partial-jpeg"
    || tag.mediaType === "image/x-swf-jpeg3"
    || tag.mediaType === "image/x-swf-jpeg4";
}
export function isLosslessBitmap(tag: any): boolean {
  return typeof tag.mediaType === "string" && tag.mediaType.includes("lossless");
}

export function isAlphaJpegBitmap(tag: any): boolean {
  return tag.mediaType === "image/x-swf-jpeg3" || tag.mediaType === "image/x-swf-jpeg4";
}

export interface JpegAlphaParts {
  jpegData: Uint8Array;
  alphaData?: Uint8Array;
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

/** Split swf-parser's JPEG3/JPEG4 payload into JPEG bytes and optional zlib alpha bytes. */
export function splitJpegAlphaData(data: Uint8Array): JpegAlphaParts {
  if (data.length < 6) return { jpegData: data };
  const jpegLength = readU32LE(data, 0);
  const jpegStart = 4;
  const alphaStart = jpegStart + jpegLength;
  if (jpegLength <= 0 || alphaStart > data.length || data[jpegStart] !== 0xff || data[jpegStart + 1] !== 0xd8) {
    return { jpegData: data };
  }
  const alphaData = data.subarray(alphaStart);
  return {
    jpegData: data.subarray(jpegStart, alphaStart),
    alphaData: alphaData.length ? alphaData : undefined,
  };
}

function stripErroneousJpegPrefix(data: Uint8Array): Uint8Array {
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd9 && data[2] === 0xff && data[3] === 0xd8) {
    return data.subarray(4);
  }
  return data;
}

function markerHasSegmentLength(marker: number): boolean {
  return marker !== 0x01 && !(marker >= 0xd0 && marker <= 0xd9);
}

function jpegNeedsTables(data: Uint8Array): boolean {
  const img = stripErroneousJpegPrefix(data);
  if (img.length < 4 || img[0] !== 0xff || img[1] !== 0xd8) return false;

  let hasDqt = false;
  let hasDht = false;
  let i = 2;
  while (i + 3 < img.length) {
    if (img[i] !== 0xff) {
      i++;
      continue;
    }
    while (i < img.length && img[i] === 0xff) i++;
    const marker = img[i++];
    if (marker === 0xda) break; // Start of Scan: tables must appear before compressed data.
    if (marker === 0xdb) hasDqt = true;
    if (marker === 0xc4) hasDht = true;
    if (!markerHasSegmentLength(marker)) continue;
    if (i + 1 >= img.length) break;
    const length = (img[i] << 8) | img[i + 1];
    if (length < 2) break;
    i += length;
  }
  return !(hasDqt && hasDht);
}

/**
 * Reconstruct standalone JPEG bytes from a SWF bitmap.
 * - strips the legacy erroneous `FF D9 FF D8` prefix
 * - for partial JPEGs, splices the shared tables (DQT/DHT) in after the SOI
 */
export function mergeJpeg(data: Uint8Array, jpegTables?: Uint8Array): Uint8Array {
  const img = stripErroneousJpegPrefix(splitJpegAlphaData(data).jpegData);

  const hasTables = jpegTables && jpegTables.length > 2;
  if (!hasTables) return img.slice();

  // tables: SOI … EOI — drop the trailing EOI so it isn't mid-stream.
  let tab = jpegTables!;
  if (tab[tab.length - 2] === 0xff && tab[tab.length - 1] === 0xd9) tab = tab.subarray(0, tab.length - 2);
  // img provides its own SOI; drop it so the tables' SOI is the only one.
  let body = img;
  if (body[0] === 0xff && body[1] === 0xd8) body = body.subarray(2);

  const out = new Uint8Array(tab.length + body.length);
  out.set(tab, 0);
  out.set(body, tab.length);
  return out;
}

/** Inflate a zlib stream using the platform's DecompressionStream (browser + Node ≥18). */
export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface RawImage {
  id: number;
  width: number;
  height: number;
  /** Straight (non-premultiplied) RGBA, row-major. */
  rgba: Uint8Array;
}

async function decodeJpegToRgba(id: number, jpegBytes: Uint8Array): Promise<RawImage> {
  if (typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") {
    throw new Error("JPEG3/JPEG4 alpha composition needs createImageBitmap + OffscreenCanvas");
  }
  const blob = new Blob([jpegBytes as BlobPart], { type: "image/jpeg" });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return { id, width: canvas.width, height: canvas.height, rgba: new Uint8Array(pixels) };
}

export async function decodeJpegAlpha(tag: any, jpegTables?: Uint8Array): Promise<RawImage | undefined> {
  const parts = splitJpegAlphaData(tag.data);
  if (!parts.alphaData) return undefined;

  const jpegBytes = mergeJpeg(parts.jpegData, jpegTables && jpegNeedsTables(parts.jpegData) ? jpegTables : undefined);
  const img = await decodeJpegToRgba(tag.id, jpegBytes);
  const alpha = await inflate(parts.alphaData);
  const pixelCount = img.width * img.height;
  if (alpha.length < pixelCount) {
    throw new Error(`JPEG alpha data too short for bitmap ${tag.id}: ${alpha.length} < ${pixelCount}`);
  }
  for (let i = 0, o = 3; i < pixelCount; i++, o += 4) img.rgba[o] = alpha[i];
  return img;
}

/**
 * Decode a DefineBitsLossless / Lossless2 bitmap to straight RGBA.
 * Body layout (from swf-parser `data`):
 *   [format:u8][width:u16le][height:u16le][colorTableSize:u8 (format 3 only)][zlib…]
 * format 3 = palette (8-bit indices), 4 = 15-bit direct, 5 = 24/32-bit direct.
 */
export async function decodeLossless(tag: any): Promise<RawImage> {
  const d: Uint8Array = tag.data;
  const format = d[0];
  const width = d[1] | (d[2] << 8);
  const height = d[3] | (d[4] << 8);
  const hasAlpha = tag.mediaType.includes("lossless2");
  const rgba = new Uint8Array(width * height * 4);

  if (format === 3) {
    const colorCount = d[5] + 1;
    const raw = await inflate(d.subarray(6));
    const entry = hasAlpha ? 4 : 3; // palette entry size
    const palette = raw.subarray(0, colorCount * entry);
    const pix = colorCount * entry;
    const stride = (width + 3) & ~3; // index rows padded to 32 bits
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = raw[pix + y * stride + x] * entry;
        const o = (y * width + x) * 4;
        rgba[o] = palette[p];
        rgba[o + 1] = palette[p + 1];
        rgba[o + 2] = palette[p + 2];
        rgba[o + 3] = hasAlpha ? palette[p + 3] : 255;
      }
    }
    return { id: tag.id, width, height, rgba };
  }

  if (format === 5) {
    // 32-bit direct color. Lossless2 stores premultiplied (A,R,G,B); un-premultiply.
    const raw = await inflate(d.subarray(5));
    const stride = width * 4; // 4 bytes/pixel is already 32-bit aligned
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const s = y * stride + x * 4;
        const a = hasAlpha ? raw[s] : 255;
        const o = (y * width + x) * 4;
        const un = (v: number) => (a === 0 ? 0 : Math.min(255, Math.round((v * 255) / a)));
        rgba[o] = hasAlpha ? un(raw[s + 1]) : raw[s + 1];
        rgba[o + 1] = hasAlpha ? un(raw[s + 2]) : raw[s + 2];
        rgba[o + 2] = hasAlpha ? un(raw[s + 3]) : raw[s + 3];
        rgba[o + 3] = a;
      }
    }
    return { id: tag.id, width, height, rgba };
  }

  throw new Error(`lossless format ${format} not supported (id ${tag.id})`);
}

function bytesToBase64(bytes: Uint8Array): string {
  const nodeBuffer = (globalThis as any).Buffer;
  if (nodeBuffer) return nodeBuffer.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export interface DecodedImage {
  id: number;
  width: number;
  height: number;
  mime: string;
  dataUrl: string;
}

/**
 * High-level: SWF bitmap → a data URL ready for <img>/SVG <image>.
 * JPEGs become `data:image/jpeg` directly; lossless images are unpacked to RGBA
 * and PNG-encoded via OffscreenCanvas (browser). Pass a custom `encodeRgba` to
 * run outside a browser (e.g. the Node test harness encodes with pngjs).
 */
export async function bitmapToDataUrl(
  tag: any,
  jpegTables?: Uint8Array,
  encodeRgba?: (img: RawImage) => Promise<string> | string,
): Promise<DecodedImage> {
  if (isJpegBitmap(tag)) {
    if (isAlphaJpegBitmap(tag)) {
      const img = await decodeJpegAlpha(tag, jpegTables);
      if (img) {
        const dataUrl = encodeRgba ? await encodeRgba(img) : await rgbaToPngDataUrl(img);
        return { id: tag.id, width: img.width, height: img.height, mime: "image/png", dataUrl };
      }
    }
    const bytes = mergeJpeg(tag.data, tag.mediaType === "image/x-swf-partial-jpeg" ? jpegTables : undefined);
    return { id: tag.id, width: tag.width, height: tag.height, mime: "image/jpeg", dataUrl: `data:image/jpeg;base64,${bytesToBase64(bytes)}` };
  }
  const img = await decodeLossless(tag);
  const dataUrl = encodeRgba ? await encodeRgba(img) : await rgbaToPngDataUrl(img);
  return { id: tag.id, width: img.width, height: img.height, mime: "image/png", dataUrl };
}

/** Browser-only RGBA → PNG data URL via OffscreenCanvas. */
async function rgbaToPngDataUrl(img: RawImage): Promise<string> {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("rgbaToPngDataUrl needs OffscreenCanvas; pass encodeRgba in non-browser environments");
  }
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return `data:image/png;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
}
