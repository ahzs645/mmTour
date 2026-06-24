// Build ONE self-contained archive for the whole tour, designed for on-demand
// (HTTP Range) loading so a single file doesn't force a full upfront download.
//
// Layout:
//   [4 bytes  ] uint32 LE = gzipped-index length L
//   [L bytes  ] gzip(JSON index): { scenes: { name: { offset, length } } }   offsets relative to the blocks region
//   [blocks   ] concatenated per-scene blocks, each:
//                 [4 bytes] uint32 LE = gzipped-header length H
//                 [H bytes] gzip(JSON { timeline, shapes:{ref:svg}, media:{ref:{offset,length,type}} })
//                 [media  ] raw media bytes (PNG/MP3/WAV/TTF/TXT), offsets relative to the block body
//
// Output (gitignored): public/generated-archive/xp-tour.pack
// Wired into the runtime via createTourPlayer({ assetSource: "archive" }).
//
// Run: node scripts/build-tour-archive.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { extname, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const genDir = join(root, "public/generated");
const outDir = join(root, "public/generated-archive");
const packsDir = join(root, "public/generated-packs"); // one self-contained file per scene
mkdirSync(outDir, { recursive: true });
mkdirSync(packsDir, { recursive: true });

const MEDIA_DIRS = ["images", "sounds", "fonts", "texts"];

function contentType(file) {
  switch (extname(file).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".ttf": return "font/ttf";
    case ".txt": return "text/plain";
    default: return "application/octet-stream";
  }
}

function collectSvgRefs(value, refs = new Set()) {
  if (typeof value === "string") {
    if (value.startsWith("generated/") && value.endsWith(".svg")) refs.add(value);
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSvgRefs(item, refs);
    return refs;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectSvgRefs(item, refs);
  }
  return refs;
}

const U32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
};

// loadVariables() reads loose `public/<name>.txt` files (`&key=value&…`). Bake them
// into the (gzipped) index so the archive is one self-contained file — otherwise an
// embed deployment would 404 on nav.txt/intro.txt and lose its dynamic headings.
function collectLoadVariableFiles() {
  const vars = {};
  const publicDir = join(root, "public");
  for (const name of readdirSync(publicDir)) {
    if (!name.endsWith(".txt")) continue;
    vars[name] = readFileSync(join(publicDir, name), "utf8");
  }
  return vars;
}

const blocks = [];
for (const scene of readdirSync(genDir)) {
  const timelinePath = join(genDir, scene, "timeline.json");
  if (!existsSync(timelinePath)) continue;

  const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));
  const shapes = {};
  for (const ref of collectSvgRefs(timeline)) {
    const file = join(root, "public", ref);
    if (existsSync(file)) shapes[ref] = readFileSync(file, "utf8");
  }

  const media = {};
  const mediaBuffers = [];
  let bodyOffset = 0;
  for (const dir of MEDIA_DIRS) {
    const mdir = join(genDir, scene, dir);
    if (!existsSync(mdir)) continue;
    for (const name of readdirSync(mdir)) {
      const file = join(mdir, name);
      if (!statSync(file).isFile()) continue;
      const bytes = readFileSync(file);
      media[`generated/${scene}/${dir}/${name}`] = { offset: bodyOffset, length: bytes.length, type: contentType(name) };
      mediaBuffers.push(bytes);
      bodyOffset += bytes.length;
    }
  }

  const headerGz = gzipSync(Buffer.from(JSON.stringify({ timeline, shapes, media })), { level: 9 });
  const block = Buffer.concat([U32(headerGz.length), headerGz, ...mediaBuffers]);
  // Per-scene self-contained file (same block format the archive concatenates).
  writeFileSync(join(packsDir, `${scene}.scene`), block);
  blocks.push({ scene, block, shapes: Object.keys(shapes).length, mediaCount: Object.keys(media).length });
}

// Index: scene -> { offset (relative to blocks region), length }.
const index = { format: "mmtour-archive", version: 1, scenes: {}, vars: collectLoadVariableFiles() };
let rel = 0;
for (const b of blocks) {
  index.scenes[b.scene] = { offset: rel, length: b.block.length };
  rel += b.block.length;
}

const indexGz = gzipSync(Buffer.from(JSON.stringify(index)), { level: 9 });
const archive = Buffer.concat([U32(indexGz.length), indexGz, ...blocks.map((b) => b.block)]);
writeFileSync(join(outDir, "xp-tour.pack"), archive);

for (const b of blocks) console.log(`  ${b.scene}: ${b.shapes} shapes, ${b.mediaCount} media, ${(b.block.length / 1048576).toFixed(2)}MB`);
console.log(`\nxp-tour.pack: ${blocks.length} scenes, ${(archive.length / 1048576).toFixed(1)}MB  (index ${indexGz.length}B)`);
