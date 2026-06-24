// Phase 1 of the shape-packing work (see docs/generated-size-and-packing.md):
// shapes reference their bitmap fills by external path (generated/<scene>/images/<id>.<ext>)
// instead of embedding a base64 copy that duplicates images/. ~72% of the raw shape
// SVG bytes were such duplicated base64.
//
// An SVG loaded via <img src=blob> is sandboxed (it cannot fetch external <image>
// hrefs), so when the runtime builds a shape's Blob URL it re-inlines the referenced
// bytes as a data URI here. The rendered output is byte-identical to the old embedded
// form; only the *stored* representation shrank.

export type InlineMedia = { bytes: Uint8Array; type: string };

/** Resolve a `generated/<scene>/images/<id>.<ext>` reference to its bytes + mime,
 *  or undefined if the asset source doesn't have it (then the ref is left as-is). */
export type InlineMediaResolver = (ref: string) => InlineMedia | undefined;

// Matches an <image> href that points at an extracted image file (not an existing
// data: URI, which is left untouched). Covers both `xlink:href` and plain `href`.
const IMAGE_REF = /\b(xlink:href|href)="(generated\/[^"]*?\/images\/[^"]+?)"/g;

/** True if `svg` references at least one external extracted image (needs inlining). */
export function shapeHasExternalBitmap(svg: string): boolean {
  IMAGE_REF.lastIndex = 0;
  return IMAGE_REF.test(svg);
}

/** Replace external image refs in `svg` with inline `data:` URIs from `resolve`.
 *  Idempotent and lossless: unresolved refs and pre-existing data URIs are preserved. */
export function inlineShapeBitmaps(svg: string, resolve: InlineMediaResolver): string {
  if (!svg.includes("/images/")) return svg;
  return svg.replace(IMAGE_REF, (match, attr: string, ref: string) => {
    const media = resolve(ref);
    if (!media) return match;
    return `${attr}="data:${media.type};base64,${bytesToBase64(media.bytes)}"`;
  });
}

/** Async variant for asset sources whose media is not in memory (files/bundle):
 *  `resolve` fetches the referenced bytes. Refs are resolved once each (deduped). */
export async function inlineShapeBitmapsAsync(
  svg: string,
  resolve: (ref: string) => Promise<InlineMedia | undefined>,
): Promise<string> {
  if (!svg.includes("/images/")) return svg;
  IMAGE_REF.lastIndex = 0;
  const refs = new Set<string>();
  for (const match of svg.matchAll(IMAGE_REF)) refs.add(match[2]);
  if (!refs.size) return svg;
  const resolved = new Map<string, InlineMedia>();
  await Promise.all([...refs].map(async (ref) => {
    const media = await resolve(ref);
    if (media) resolved.set(ref, media);
  }));
  return inlineShapeBitmaps(svg, (ref) => resolved.get(ref));
}

export function bytesToBase64(bytes: Uint8Array): string {
  const nodeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (nodeBuffer) return nodeBuffer.from(bytes).toString("base64");
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Strip the `generated/<scene>/` prefix from a media ref → scene-relative path
 *  (`images/<id>.<ext>`), the key used by the in-memory pack file map. */
export function sceneRelativeImagePath(ref: string): string {
  return ref.replace(/^\/?generated\/[^/]+\//, "");
}
