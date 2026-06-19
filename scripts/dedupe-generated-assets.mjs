import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const generatedRoot = join(root, "public/generated");
const assetDirs = ["shapes", "sprites", "images", "texts", "frames", "buttons", "fonts", "sounds"];
const jsonFiles = ["timeline.json", "control-flow.json"];

const dropRootFrames = process.argv.includes("--drop-root-frames");
const dropBakedSprites = process.argv.includes("--drop-baked-sprites");
const dropDebugArtifacts = process.argv.includes("--drop-debug-artifacts");
const compactJson = process.argv.includes("--compact-json");
const minifySvg = process.argv.includes("--minify-svg");
const requestedScenes = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const scenes = requestedScenes.length
  ? requestedScenes
  : readdirSync(generatedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((scene) => existsSync(join(generatedRoot, scene, "timeline.json")))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

let totalFilesRemoved = 0;
let totalBytesRemoved = 0;
let totalJsonRewrites = 0;

for (const scene of scenes) {
  const sceneDir = join(generatedRoot, scene);
  if (!existsSync(sceneDir)) {
    console.warn(`${scene}: missing ${sceneDir}`);
    continue;
  }

  const duplicateMap = new Map();
  let sceneFilesRemoved = 0;
  let sceneBytesRemoved = 0;
  let sceneBytesRewritten = 0;
  const spriteDirsToRemove = new Set();

  if (dropDebugArtifacts) {
    const scriptsDir = join(sceneDir, "scripts");
    if (existsSync(scriptsDir)) {
      const scriptsSize = directorySize(scriptsDir);
      const scriptsCount = walkFiles(scriptsDir).length;
      rmSync(scriptsDir, { recursive: true, force: true });
      sceneFilesRemoved += scriptsCount;
      sceneBytesRemoved += scriptsSize;
    }
    for (const file of ["swf-parser-report.json"]) {
      const debugPath = join(sceneDir, file);
      if (!existsSync(debugPath)) continue;
      sceneFilesRemoved += 1;
      sceneBytesRemoved += statSync(debugPath).size;
      rmSync(debugPath);
    }
  }

  if (dropRootFrames) {
    const framesDir = join(sceneDir, "frames");
    if (existsSync(framesDir)) {
      const framesSize = directorySize(framesDir);
      const framesCount = walkFiles(framesDir).length;
      rmSync(framesDir, { recursive: true, force: true });
      sceneFilesRemoved += framesCount;
      sceneBytesRemoved += framesSize;
    }
  }

  if (dropBakedSprites) {
    const timelinePath = join(sceneDir, "timeline.json");
    if (existsSync(timelinePath)) {
      const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));
      for (const asset of Object.values(timeline.assets ?? {})) {
        if (asset?.kind !== "sprite" || !asset.timeline?.length || !asset.frames?.length) continue;
        for (const ref of asset.frames) {
          const parts = ref.split("/");
          const spritesIndex = parts.indexOf("sprites");
          if (spritesIndex >= 0 && parts[spritesIndex + 1]) spriteDirsToRemove.add(join(sceneDir, "sprites", parts[spritesIndex + 1]));
        }
      }
    }
    for (const dir of [...spriteDirsToRemove].sort(comparePaths)) {
      if (!existsSync(dir)) continue;
      const spriteSize = directorySize(dir);
      const spriteCount = walkFiles(dir).length;
      rmSync(dir, { recursive: true, force: true });
      sceneFilesRemoved += spriteCount;
      sceneBytesRemoved += spriteSize;
    }
  }

  for (const dirName of assetDirs) {
    const dir = join(sceneDir, dirName);
    if (!existsSync(dir)) continue;

    const groups = hashFiles(walkFiles(dir));
    for (const group of groups.values()) {
      if (group.files.length < 2) continue;
      group.files.sort(comparePaths);
      const canonical = group.files[0];
      const canonicalRef = generatedRef(scene, canonical);
      for (const duplicate of group.files.slice(1)) {
        duplicateMap.set(generatedRef(scene, duplicate), canonicalRef);
        rmSync(duplicate);
        sceneFilesRemoved += 1;
        sceneBytesRemoved += group.size;
      }
    }
  }

  if (minifySvg) {
    for (const file of walkFiles(sceneDir).filter((path) => path.endsWith(".svg"))) {
      const before = readFileSync(file, "utf8");
      const after = minifySvgText(before);
      if (after !== before) {
        writeFileSync(file, after);
        sceneBytesRewritten += Buffer.byteLength(before) - Buffer.byteLength(after);
      }
    }
  }

  let sceneJsonRewrites = 0;
  for (const file of jsonFiles) {
    const jsonPath = join(sceneDir, file);
    if (!existsSync(jsonPath)) continue;
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    let forceWrite = false;
    if (dropRootFrames && file === "timeline.json") {
      if (Array.isArray(parsed.frameSvgs)) sceneJsonRewrites += parsed.frameSvgs.length;
      delete parsed.frameSvgs;
      parsed.frameSvgsOmitted = true;
      forceWrite = true;
    }
    if (dropBakedSprites && file === "timeline.json") {
      const removed = removeBakedSpriteFrameRefs(parsed);
      if (removed > 0) {
        sceneJsonRewrites += removed;
        parsed.bakedSpriteFramesOmitted = true;
        forceWrite = true;
      }
    }
    const { value, rewrites } = rewriteGeneratedRefs(parsed, duplicateMap);
    if (rewrites > 0 || forceWrite || compactJson) {
      const beforeSize = statSync(jsonPath).size;
      const json = compactJson || file === "timeline.json"
        ? JSON.stringify(value)
        : JSON.stringify(value, null, 2);
      writeFileSync(jsonPath, `${json}\n`);
      sceneBytesRewritten += beforeSize - statSync(jsonPath).size;
      sceneJsonRewrites += rewrites;
    }
  }

  removeEmptyDirs(sceneDir);
  totalFilesRemoved += sceneFilesRemoved;
  totalBytesRemoved += sceneBytesRemoved;
  totalJsonRewrites += sceneJsonRewrites;
  const rewritten = sceneBytesRewritten ? `, compacted ${formatBytes(sceneBytesRewritten)}` : "";
  console.log(`${scene}: removed ${sceneFilesRemoved} files (${formatBytes(sceneBytesRemoved)}), rewrote ${sceneJsonRewrites} refs${rewritten}`);
}

console.log(`Total: removed ${totalFilesRemoved} duplicate files (${formatBytes(totalBytesRemoved)}), rewrote ${totalJsonRewrites} refs`);

function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function hashFiles(files) {
  const groups = new Map();
  for (const file of files) {
    const size = statSync(file).size;
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    const key = `${size}:${hash}`;
    if (!groups.has(key)) groups.set(key, { size, files: [] });
    groups.get(key).files.push(file);
  }
  return groups;
}

function directorySize(dir) {
  return walkFiles(dir).reduce((sum, file) => sum + statSync(file).size, 0);
}

function removeEmptyDirs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    removeEmptyDirs(child);
    if (readdirSync(child).length === 0) rmSync(child, { recursive: true, force: true });
  }
}

function removeBakedSpriteFrameRefs(timeline) {
  let removed = 0;
  for (const asset of Object.values(timeline.assets ?? {})) {
    if (asset?.kind !== "sprite" || !asset.timeline?.length || !asset.frames?.length) continue;
    removed += asset.frames.length;
    delete asset.frames;
  }
  return removed;
}

function minifySvgText(svg) {
  return svg
    .replace(/^\uFEFF?/, "")
    .replace(/^<\?xml[^>]*>\s*/i, "")
    .replace(/\s+xmlns:ffdec="[^"]*"/g, "")
    .replace(/\s+ffdec:[A-Za-z0-9_-]+="[^"]*"/g, "")
    .replace(/>\s+</g, "><")
    .trim();
}

function generatedRef(scene, file) {
  return `generated/${scene}/${relative(join(generatedRoot, scene), file).replaceAll("\\", "/")}`;
}

function comparePaths(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

function rewriteGeneratedRefs(value, duplicateMap) {
  if (typeof value === "string") {
    const rewritten = duplicateMap.get(value);
    return rewritten ? { value: rewritten, rewrites: 1 } : { value, rewrites: 0 };
  }
  if (Array.isArray(value)) {
    let rewrites = 0;
    const next = value.map((item) => {
      const result = rewriteGeneratedRefs(item, duplicateMap);
      rewrites += result.rewrites;
      return result.value;
    });
    return { value: next, rewrites };
  }
  if (value && typeof value === "object") {
    let rewrites = 0;
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      const result = rewriteGeneratedRefs(item, duplicateMap);
      rewrites += result.rewrites;
      next[key] = result.value;
    }
    return { value: next, rewrites };
  }
  return { value, rewrites: 0 };
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
