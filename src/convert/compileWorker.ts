// Web Worker that runs the SWF → playable-bundle compile off the main thread, so
// the UI stays responsive during conversion (shape rasterizing, image decoding
// via OffscreenCanvas, font building, the AVM1 init scan). The worker posts back
// the asset file map + timeline; the main thread registers + plays them.

import { compileScene } from "./compileScene.ts";

interface CompileRequest {
  id: number;
  bytes: Uint8Array;
  scene: string;
}

self.onmessage = async (e: MessageEvent<CompileRequest>) => {
  const { id, bytes, scene } = e.data;
  try {
    const c = await compileScene(bytes, scene);
    // The files Map (string → {type, bytes}) and the plain timeline object are
    // structured-cloneable (clone preserves shared buffers, so it stays cheap).
    // We don't transfer the buffers: some asset bytes are subarray views of the
    // same SWF buffer, and transferring one ArrayBuffer twice throws.
    (self as any).postMessage({ id, ok: true, scene: c.scene, timeline: c.timeline, files: c.files, stats: c.stats, width: c.width, height: c.height, dependencies: c.dependencies, externalAssets: c.externalAssets });
  } catch (err) {
    (self as any).postMessage({ id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
};
