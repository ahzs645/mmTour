#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const scene = process.argv[2];
if (!scene) {
  console.error("usage: node scripts/convert-external-swfs.mjs <scene>");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname;
const publicDir = join(root, "public");
const generatedDir = join(publicDir, "generated", scene);

const refs = collectExternalSwfs(scene, publicDir, generatedDir)
  .filter((ref) => basename(ref).toLowerCase() !== `${scene.toLowerCase()}.swf`);
const present = refs.filter((ref) => existsSync(join(publicDir, ref)));
const missing = refs.filter((ref) => !existsSync(join(publicDir, ref)));

console.log(`${scene}`);
console.log(`  external SWF refs: ${refs.length}`);
console.log(`  present under public/: ${present.length}`);
console.log(`  missing under public/: ${missing.length}`);

if (missing.length) {
  console.log("\nmissing:");
  for (const ref of missing) console.log(`  - ${ref}`);
}

if (!present.length) {
  console.log("\nNo present external SWFs to convert.");
  process.exit(0);
}

console.log("\nconverting:");
for (const ref of present) {
  const swfPath = join("public", ref);
  const generatedScene = basename(ref, ".swf");
  console.log(`  - ${ref} -> public/generated/${generatedScene}/`);
  run("node", ["scripts/export-ffdec.mjs", swfPath]);
  run("node", ["scripts/build-asset-timeline.mjs", swfPath]);
  run("node", ["scripts/build-control-flow.mjs", swfPath]);
}

function collectExternalSwfs(sceneName, publicPath, generatedPath) {
  const sources = [];
  for (const candidate of [
    join(publicPath, "xml", `${sceneName}_en.xml`),
    join(publicPath, "xml", `${sceneName}.xml`),
    join(generatedPath, "control-flow.json"),
  ]) {
    if (existsSync(candidate)) sources.push(readFileSync(candidate, "utf8"));
  }

  const refs = new Set();
  const patterns = [
    /(?:src|href|value|rawValue|arguments)"?\s*[:=]\s*"?([^"'<>\s]+\.swf)/gi,
    /["']([^"']+\.swf)["']/gi,
  ];
  for (const text of sources) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        const normalized = normalizeAssetRef(match[1]);
        if (normalized) refs.add(normalized);
      }
    }
  }
  return [...refs].sort();
}

function normalizeAssetRef(ref) {
  const clean = String(ref ?? "")
    .trim()
    .replace(/\\\//g, "/")
    .replace(/^https?:\/\/[^/]+\//i, "")
    .replace(/^\/+/, "");
  if (!clean || clean.startsWith("public/") || clean.startsWith("generated/")) return "";
  return clean;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}
