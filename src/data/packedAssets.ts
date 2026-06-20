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

export type AssetSource = "files" | "pack";

let assetSource: AssetSource = "files";
const packedScenes = new Map<string, PackedScene>();

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
  clearPackedScenes();
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
}

export function clearPackedScenes() {
  for (const scene of packedScenes.values()) {
    for (const file of scene.files.values()) {
      if (file.url) URL.revokeObjectURL(file.url);
    }
  }
  packedScenes.clear();
}

export function cacheKeyForSource(key: string): string {
  return `${assetSource}:${key}`;
}

export async function loadTimelineFromSource(scene: string): Promise<AssetTimeline | null> {
  if (assetSource === "files") return loadTimelineFile(scene);
  const packed = await loadPackedScene(scene);
  return packed?.timeline ?? null;
}

export function assetUrl(src: string): string {
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
