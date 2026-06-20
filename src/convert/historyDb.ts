// IndexedDB-backed history of converts (via Dexie). Stores the original SWF
// bytes (so a scene can be re-compiled and replayed) plus the extraction stats
// and a thumbnail, keyed by an auto id.

import Dexie, { type Table } from "dexie";
import type { CompileStats } from "./compileScene.ts";

export interface ConvertRecord {
  id?: number;
  name: string;
  swf: Blob;
  stats: CompileStats;
  width: number;
  height: number;
  thumb?: string; // data URL of the first rendered frame
  createdAt: number;
}

class ConvertDB extends Dexie {
  converts!: Table<ConvertRecord, number>;
  constructor() {
    super("mmtour-converts");
    this.version(1).stores({ converts: "++id, name, createdAt" });
  }
}

const db = new ConvertDB();

export async function saveConvert(rec: Omit<ConvertRecord, "id">): Promise<number> {
  return db.converts.add(rec as ConvertRecord);
}

export async function listConverts(): Promise<ConvertRecord[]> {
  return (await db.converts.orderBy("createdAt").reverse().toArray());
}

export async function getConvert(id: number): Promise<ConvertRecord | undefined> {
  return db.converts.get(id);
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
