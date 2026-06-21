import type { AssetTimeline } from "./timelineTypes";

type PackedFile = {
  path: string;
  type: string;
  offset: number;
  length: number;
};

type PackedHeader = {
  format: string;
  version: number;
  scene: string;
  files: PackedFile[];
};

type PackedScene = {
  scene: string;
  files: Map<string, { type: string; bytes: Uint8Array; url?: string }>;
  timeline: AssetTimeline | null;
};

export type AssetSource = "files" | "pack" | "bundle" | "archive" | "scene-pack";

type BundleScene = {
  timeline: AssetTimeline | null;
  shapes: Map<string, { svg: string; url?: string }>;
};

// A self-contained scene block (used by both "archive" and "scene-pack"): the
// decompressed timeline + shape SVGs, plus raw media sliced out of `body` lazily.
type SceneData = {
  timeline: AssetTimeline | null;
  shapes: Map<string, { svg: string; url?: string }>;
  media: Map<string, { offset: number; length: number; type: string; url?: string }>;
  body: Uint8Array;
  bodyStart: number;
};

let assetSource: AssetSource = "files";
let assetRevision = 0;
const packedScenes = new Map<string, PackedScene>();
const bundleScenes = new Map<string, BundleScene>();
const sceneData = new Map<string, SceneData>();

// Full URL of the single-file archive (assetSource === "archive").
let archiveUrl = "";
let archiveIndex: { blocksStart: number; scenes: Record<string, { offset: number; length: number }> } | null = null;

export function setArchiveUrl(url: string) {
  archiveUrl = url;
  archiveIndex = null;
}

// Base URL under which the converted `generated/` (and `generated-packed/`)
// scene assets are served. Empty string = origin root (`/generated/...`), which
// is how the dev lab serves them. A library consumer points this at wherever it
// hosts the assets, e.g. `setAssetsBaseUrl("/apps/xp-tour/gsap")`.
let assetsBaseUrl = "";

export function setAssetsBaseUrl(url: string) {
  assetsBaseUrl = url.replace(/\/+$/, "");
}

export function getAssetsBaseUrl(): string {
  return assetsBaseUrl;
}

export function getAssetSource(): AssetSource {
  return assetSource;
}

export function setAssetSource(source: AssetSource) {
  if (source === assetSource) return;
  assetSource = source;
  assetRevision += 1;
  clearPackedScenes();
  clearBundleScenes();
  clearSceneData();
}

function clearSceneData() {
  for (const scene of sceneData.values()) {
    for (const shape of scene.shapes.values()) if (shape.url) URL.revokeObjectURL(shape.url);
    for (const m of scene.media.values()) if (m.url) URL.revokeObjectURL(m.url);
  }
  sceneData.clear();
  archiveIndex = null;
}

/** Inflate a byte slice that may be gzip (raw bytes) or already-plain (a server
 *  that applied Content-Encoding). */
async function inflate(bytes: Uint8Array): Promise<string> {
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (isGzip && typeof DecompressionStream !== "undefined") {
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

/** Parse one self-contained scene block: [u32 headerLen][gzip header][raw media]. */
async function parseSceneBlock(block: Uint8Array): Promise<SceneData> {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(await inflate(block.slice(4, 4 + headerLen))) as {
    timeline?: AssetTimeline;
    shapes?: Record<string, string>;
    media?: Record<string, { offset: number; length: number; type: string }>;
  };
  const shapes = new Map<string, { svg: string; url?: string }>();
  for (const [ref, svg] of Object.entries(header.shapes ?? {})) shapes.set(ref, { svg });
  const media = new Map<string, { offset: number; length: number; type: string; url?: string }>();
  for (const [ref, m] of Object.entries(header.media ?? {})) media.set(ref, m);
  return { timeline: header.timeline ?? null, shapes, media, body: block, bodyStart: 4 + headerLen };
}

/** Fetch a byte range, tolerating servers that ignore Range and return the whole
 *  file (200): in that case slice the requested window out of the full body. */
async function rangeFetch(url: string, start: number, end: number): Promise<Uint8Array | null> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (res.status === 206) return buf;
  return buf.slice(start, end + 1);
}

async function loadArchiveIndex() {
  if (archiveIndex) return archiveIndex;
  const head = await rangeFetch(archiveUrl, 0, 65535);
  if (!head || head.byteLength < 4) return null;
  const indexLen = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0, true);
  const parsed = JSON.parse(await inflate(head.slice(4, 4 + indexLen))) as {
    scenes: Record<string, { offset: number; length: number }>;
  };
  archiveIndex = { blocksStart: 4 + indexLen, scenes: parsed.scenes };
  return archiveIndex;
}

async function ensureArchiveScene(scene: string): Promise<SceneData | null> {
  const cached = sceneData.get(scene);
  if (cached) return cached;
  const index = await loadArchiveIndex();
  const meta = index?.scenes[scene];
  if (!index || !meta) return null;
  const start = index.blocksStart + meta.offset;
  const block = await rangeFetch(archiveUrl, start, start + meta.length - 1);
  if (!block) return null;
  const entry = await parseSceneBlock(block);
  sceneData.set(scene, entry);
  return entry;
}

async function ensureScenePack(scene: string): Promise<SceneData | null> {
  const cached = sceneData.get(scene);
  if (cached) return cached;
  const res = await fetch(`${assetsBaseUrl}/generated-packs/${scene}.scene?v=${Date.now()}`);
  if (!res.ok) return null;
  const entry = await parseSceneBlock(new Uint8Array(await res.arrayBuffer()));
  sceneData.set(scene, entry);
  return entry;
}

function clearBundleScenes() {
  for (const scene of bundleScenes.values()) {
    for (const shape of scene.shapes.values()) {
      if (shape.url) URL.revokeObjectURL(shape.url);
    }
  }
  bundleScenes.clear();
}

/** Load a scene's gzipped shape bundle. Some servers (e.g. the Vite dev server)
 *  serve `.gz` with `Content-Encoding: gzip` so the browser has already inflated
 *  the body; others serve the raw gzip bytes. We check the gzip magic bytes and
 *  only inflate when needed, so it works in both cases. */
async function loadBundleScene(scene: string): Promise<BundleScene | null> {
  const cached = bundleScenes.get(scene);
  if (cached) return cached;

  let json: string | null = null;
  try {
    const res = await fetch(`${assetsBaseUrl}/generated-bundles/${scene}.json.gz?v=${Date.now()}`);
    if (res.ok) json = await inflate(new Uint8Array(await res.arrayBuffer()));
  } catch {
    json = null;
  }
  if (json === null) return null;

  let parsed: { timeline?: AssetTimeline; shapes?: Record<string, string> };
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const shapes = new Map<string, { svg: string; url?: string }>();
  for (const [ref, svg] of Object.entries(parsed.shapes ?? {})) shapes.set(ref, { svg });
  const entry: BundleScene = { timeline: parsed.timeline ?? null, shapes };
  bundleScenes.set(scene, entry);
  return entry;
}

/**
 * Register an in-browser-compiled scene so the player serves its assets from
 * memory (blob URLs) with no server — used by the convert→play demo. `files`
 * maps scene-relative paths ("shapes/108.svg", "images/106.jpg", …) to bytes;
 * pass the parsed timeline so loadTimelineFromSource resolves it directly.
 */
export function registerPackedScene(
  scene: string,
  files: Map<string, { type: string; bytes: Uint8Array }>,
  timeline: AssetTimeline | null,
) {
  const existing = packedScenes.get(scene);
  if (existing) for (const f of existing.files.values()) if (f.url) URL.revokeObjectURL(f.url);
  packedScenes.set(scene, { scene, files: new Map(files), timeline });
  assetRevision += 1;
}

export function clearPackedScenes() {
  for (const scene of packedScenes.values()) {
    for (const file of scene.files.values()) {
      if (file.url) URL.revokeObjectURL(file.url);
    }
  }
  packedScenes.clear();
  assetRevision += 1;
}

export function unregisterPackedScene(scene: string) {
  const existing = packedScenes.get(scene);
  if (!existing) return;
  for (const file of existing.files.values()) {
    if (file.url) URL.revokeObjectURL(file.url);
  }
  packedScenes.delete(scene);
  assetRevision += 1;
}

export function cacheKeyForSource(key: string): string {
  return `${assetSource}:${assetRevision}:${key}`;
}

export async function loadTimelineFromSource(scene: string): Promise<AssetTimeline | null> {
  if (assetSource === "files") return loadTimelineFile(scene);
  if (assetSource === "bundle") return (await loadBundleScene(scene))?.timeline ?? null;
  if (assetSource === "archive") return (await ensureArchiveScene(scene))?.timeline ?? null;
  if (assetSource === "scene-pack") return (await ensureScenePack(scene))?.timeline ?? null;
  const packed = await loadPackedScene(scene);
  return packed?.timeline ?? null;
}

export function assetUrl(src: string): string {
  if (assetSource === "archive" || assetSource === "scene-pack") {
    const normalized = src.replace(/^\//, "");
    const scene = /^generated\/([^/]+)\//.exec(normalized)?.[1];
    const entry = scene ? sceneData.get(scene) : undefined;
    if (entry) {
      if (normalized.endsWith(".svg")) {
        const shape = entry.shapes.get(normalized);
        if (shape) {
          if (!shape.url) shape.url = URL.createObjectURL(new Blob([shape.svg], { type: "image/svg+xml" }));
          return shape.url;
        }
      } else {
        const m = entry.media.get(normalized);
        if (m) {
          if (!m.url) {
            const start = entry.bodyStart + m.offset;
            m.url = URL.createObjectURL(new Blob([entry.body.slice(start, start + m.length)], { type: m.type }));
          }
          return m.url;
        }
      }
    }
    return `${assetsBaseUrl}/${normalized}`;
  }
  if (assetSource === "bundle") {
    const normalized = src.replace(/^\//, "");
    // Shape/sprite/button SVGs come from the in-memory bundle; media (PNG/MP3/TTF)
    // is served externally from the same base URL.
    if (normalized.endsWith(".svg")) {
      const scene = /^generated\/([^/]+)\//.exec(normalized)?.[1];
      const shape = scene ? bundleScenes.get(scene)?.shapes.get(normalized) : undefined;
      if (shape) {
        if (!shape.url) shape.url = URL.createObjectURL(new Blob([shape.svg], { type: "image/svg+xml" }));
        return shape.url;
      }
    }
    return `${assetsBaseUrl}/${normalized}`;
  }
  if (assetSource === "pack") {
    const normalized = src.replace(/^\//, "");
    const match = /^generated\/([^/]+)\/(.+)$/.exec(normalized);
    if (match) {
      const packed = packedScenes.get(match[1]);
      const file = packed?.files.get(match[2]);
      if (file) {
        if (!file.url) file.url = URL.createObjectURL(new Blob([file.bytes.slice().buffer], { type: file.type }));
        return file.url;
      }
    }
  }
  return `${assetsBaseUrl}/${src.replace(/^\//, "")}`;
}

async function loadTimelineFile(scene: string): Promise<AssetTimeline | null> {
  const response = await fetch(`${assetsBaseUrl}/generated/${scene}/timeline.json?v=${Date.now()}`);
  if (!response.ok) return null;
  try {
    return (await response.json()) as AssetTimeline;
  } catch {
    return null;
  }
}

async function loadPackedScene(scene: string): Promise<PackedScene | null> {
  const cached = packedScenes.get(scene);
  if (cached) return cached;

  const response = await fetch(`${assetsBaseUrl}/generated-packed/${scene}/${scene}.pack?v=${Date.now()}`);
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 4) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0, true);
  const headerEnd = 4 + headerLength;
  if (headerEnd > bytes.byteLength) return null;

  let header: PackedHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.slice(4, headerEnd))) as PackedHeader;
  } catch {
    return null;
  }
  if (header.format !== "mmtour-generated-pack" || header.scene !== scene) return null;

  const files = new Map<string, { type: string; bytes: Uint8Array; url?: string }>();
  for (const file of header.files) {
    const start = headerEnd + file.offset;
    const end = start + file.length;
    if (start < headerEnd || end > bytes.byteLength) continue;
    files.set(file.path, { type: file.type, bytes: bytes.slice(start, end) });
  }

  const timelineBytes = files.get("timeline.json")?.bytes;
  let timeline: AssetTimeline | null = null;
  if (timelineBytes) {
    try {
      timeline = JSON.parse(new TextDecoder().decode(timelineBytes)) as AssetTimeline;
    } catch {
      timeline = null;
    }
  }

  const packed = { scene, files, timeline };
  packedScenes.set(scene, packed);
  return packed;
}
