// Verify the swf-parser→FFDec adapter reproduces FFDec's timeline parsing.
//
//   node scripts/verify-adapter-timeline.mjs [scene ...]
//
// Runs the EXISTING buildFrames + attachSpriteTimelines (the FFDec-XML extractor
// code) on the adapter output, then deep-compares the resulting root display
// list and sprite sub-timelines against the committed FFDec-derived
// public/generated/<scene>/timeline.json. A match proves the Java swf2xml step
// is replaceable by swf-parser for the timeline backbone.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { swfToFfdecModel } from "./lib/swfParserAdapter.mjs";
import { buildFrames, attachSpriteTimelines } from "./lib/frames.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const scenes = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["A-tour", "intro", "nav", "segment1", "segment2", "segment3", "segment4", "segment5"];

const EPS = 1e-3;
let grandFrames = 0, grandFrameMiss = 0, grandSprites = 0, grandSpriteMiss = 0, sceneFail = 0;

for (const scene of scenes) {
  const bytes = new Uint8Array(readFileSync(join(root, "public", `${scene}.swf`)));
  const gold = JSON.parse(readFileSync(join(root, "public/generated", scene, "timeline.json"), "utf8"));

  const { tags } = swfToFfdecModel(bytes);
  const frames = buildFrames(tags);

  // Build minimal sprite asset defs (kind:sprite) so attachSpriteTimelines runs;
  // it only needs the asset to exist and be kind "sprite".
  const assetDefs = {};
  for (const t of tags) if (t.type === "DefineSpriteTag") assetDefs[String(t.spriteId)] = { id: t.spriteId, kind: "sprite" };
  attachSpriteTimelines(assetDefs, tags);

  // --- root frames ---
  let frameMiss = 0;
  const goldFrames = gold.frames ?? [];
  if (frames.length !== goldFrames.length) frameMiss++;
  const n = Math.min(frames.length, goldFrames.length);
  for (let i = 0; i < n; i++) {
    if (!sameInstances(frames[i].instances, goldFrames[i].instances)) frameMiss++;
  }

  // --- sprite sub-timelines ---
  let spriteTotal = 0, spriteMiss = 0;
  for (const [id, asset] of Object.entries(assetDefs)) {
    const goldAsset = gold.assets?.[id];
    if (!goldAsset || !goldAsset.timeline) continue;
    spriteTotal++;
    if (!sameTimeline(asset.timeline ?? [], goldAsset.timeline)) spriteMiss++;
  }

  grandFrames += frames.length;
  grandFrameMiss += frameMiss;
  grandSprites += spriteTotal;
  grandSpriteMiss += spriteMiss;
  const ok = frameMiss === 0 && spriteMiss === 0;
  if (!ok) sceneFail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${scene.padEnd(9)} ` +
      `frames ${frames.length}/${goldFrames.length} (${frameMiss} mismatched)  ` +
      `sprite-timelines ${spriteTotal - spriteMiss}/${spriteTotal} match`,
  );
}

console.log(
  `\n${sceneFail === 0 ? "ALL PASS" : `${sceneFail} scene(s) FAILED`}  ·  ` +
    `root frames: ${grandFrames - grandFrameMiss}/${grandFrames} match  ·  ` +
    `sprite timelines: ${grandSprites - grandSpriteMiss}/${grandSprites} match`,
);
process.exit(sceneFail === 0 ? 0 : 1);

function sameInstances(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.depth !== y.depth || Number(x.characterId) !== Number(y.characterId)) return false;
    if ((x.name ?? "") !== (y.name ?? "")) return false;
    if (Math.abs((x.opacity ?? 1) - (y.opacity ?? 1)) > EPS) return false;
    if ((x.clipDepth ?? null) !== (y.clipDepth ?? null)) return false;
    if (!sameMatrix(x.matrix, y.matrix)) return false;
    if (!sameColor(x.colorTransform, y.colorTransform)) return false;
  }
  return true;
}

function sameMatrix(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return ["a", "b", "c", "d", "tx", "ty"].every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) <= Math.max(EPS, Math.abs(b[k] ?? 0) * 1e-4));
}

function sameColor(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return ["rm", "gm", "bm", "ra", "ga", "ba"].every((k) => Math.abs((a[k] ?? (k.length === 2 && k[1] === "m" ? 1 : 0)) - (b[k] ?? (k[1] === "m" ? 1 : 0))) <= 2e-3);
}

function sameTimeline(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameInstances(a[i].instances ?? [], b[i].instances ?? [])) return false;
  }
  return true;
}
