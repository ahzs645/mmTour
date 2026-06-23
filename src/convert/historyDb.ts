// IndexedDB-backed history of converts (via Dexie). Stores the original source
// bytes (SWF converts, or imported mmTour packs) plus the extraction stats and
// a thumbnail, keyed by an auto id.

import Dexie, { type Table } from "dexie";
import type { CompileStats } from "./compileScene.ts";

export const COMPILED_CACHE_VERSION = 6;

export interface StoredCompiledFile {
  path: string;
  type: string;
  bytes: Uint8Array;
}

export interface StoredCompiledScene {
  version?: number;
  scene: string;
  timeline: any;
  files: StoredCompiledFile[];
  stats: CompileStats;
  width: number;
  height: number;
  dependencies: { swf: string; level?: number }[];
}

export interface ConvertRecord {
  id?: number;
  scene?: string;
  name: string;
  sourceType?: "swf" | "pack";
  swf: Blob;
  stats: CompileStats;
  width: number;
  height: number;
  thumb?: string; // data URL of the first rendered frame
  compiled?: StoredCompiledScene;
  createdAt: number;
}

class ConvertDB extends Dexie {
  converts!: Table<ConvertRecord, number>;
  constructor() {
    super("mmtour-converts");
    this.version(1).stores({ converts: "++id, name, createdAt" });
    this.version(2)
      .stores({ converts: "++id, scene, name, createdAt" })
      .upgrade((tx) =>
        tx.table("converts").toCollection().modify((rec: ConvertRecord) => {
          rec.scene ??= sceneKey(rec.name);
        }),
      );
  }
}

const db = new ConvertDB();

export async function saveConvert(rec: Omit<ConvertRecord, "id">): Promise<number> {
  const row: ConvertRecord = { ...rec, scene: rec.scene ?? sceneKey(rec.name) };
  return db.converts.add(row);
}

export async function listConverts(): Promise<ConvertRecord[]> {
  return (await db.converts.orderBy("createdAt").reverse().toArray());
}

export async function getConvert(id: number): Promise<ConvertRecord | undefined> {
  return db.converts.get(id);
}

export async function updateConvert(id: number, changes: Partial<Omit<ConvertRecord, "id">>): Promise<void> {
  await db.converts.update(id, changes);
}

export async function deleteConvert(id: number): Promise<void> {
  await db.converts.delete(id);
}

export async function setThumb(id: number, thumb: string): Promise<void> {
  await db.converts.update(id, { thumb });
}

export async function clearHistory(): Promise<void> {
  await db.converts.clear();
}

function sceneKey(name: string): string {
  return name.replace(/\.swf$/i, "").replace(/[^\w.-]+/g, "-");
}
