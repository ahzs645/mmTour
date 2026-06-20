// Main-thread client for the compile worker. Keeps a single worker and resolves
// each compile by message id. Falls back to in-thread compileScene if Workers
// are unavailable. Returns the same shape as compileScene's CompiledScene.

import type { CompiledScene } from "./compileScene.ts";

type Pending = { resolve: (c: CompiledScene) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  worker = new Worker(new URL("./compileWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<any>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) {
      const { scene, timeline, files, stats, width, height, dependencies } = e.data;
      p.resolve({ scene, timeline, files, stats, width, height, dependencies });
    } else {
      p.reject(new Error(e.data.error ?? "compile failed"));
    }
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || "worker error");
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  return worker;
}

/** Compile a SWF off the main thread (worker), or in-thread if no Worker. */
export async function compileSceneAsync(bytes: Uint8Array, scene: string): Promise<CompiledScene> {
  const w = ensureWorker();
  if (!w) {
    const { compileScene } = await import("./compileScene.ts");
    return compileScene(bytes, scene);
  }
  const id = nextId++;
  return new Promise<CompiledScene>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // copy the input so the caller can still use `bytes` (e.g. to save the SWF blob)
    w.postMessage({ id, bytes: bytes.slice(), scene });
  });
}
