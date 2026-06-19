import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const generatedRoot = join(root, "public/generated");
const outRoot = join(root, "public/generated-packed");
const requestedScenes = process.argv.slice(2);
const scenes = requestedScenes.length
  ? requestedScenes
  : readdirSync(generatedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((scene) => existsSync(join(generatedRoot, scene, "timeline.json")))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

const report = {
  generatedFrom: "public/generated",
  generatedAt: new Date().toISOString(),
  compression: "per-scene binary pack + gzip-9 + brotli-q8",
  scenes: [],
  totals: emptySizes(),
};

for (const scene of scenes) {
  const sceneDir = join(generatedRoot, scene);
  const sceneOut = join(outRoot, scene);
  mkdirSync(sceneOut, { recursive: true });

  const pack = buildBinaryPack(scene, sceneDir);
  const packPath = join(sceneOut, `${scene}.pack`);
  const gzip = gzipSync(pack.buffer, { level: 9 });
  const brotli = brotliCompressSync(pack.buffer, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 8 },
  });
  writeFileSync(packPath, pack.buffer);
  writeFileSync(`${packPath}.gz`, gzip);
  writeFileSync(`${packPath}.br`, brotli);

  const shapePrototype = buildShapeDictionaryPrototype(scene, sceneDir);
  const shapePath = join(sceneOut, `${scene}.shape-dict.json`);
  const shapeJson = `${JSON.stringify(shapePrototype.value)}\n`;
  const shapeGzip = gzipSync(shapeJson, { level: 9 });
  const shapeBrotli = brotliCompressSync(shapeJson, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 8 },
  });
  writeFileSync(shapePath, shapeJson);
  writeFileSync(`${shapePath}.gz`, shapeGzip);
  writeFileSync(`${shapePath}.br`, shapeBrotli);

  const entry = {
    scene,
    files: pack.files.length,
    binaryPack: {
      raw: pack.buffer.length,
      gzip: gzip.length,
      brotli: brotli.length,
    },
    shapeDictionaryPrototype: {
      svgFiles: shapePrototype.svgFiles,
      rawSvgBytes: shapePrototype.rawSvgBytes,
      raw: Buffer.byteLength(shapeJson),
      gzip: shapeGzip.length,
      brotli: shapeBrotli.length,
    },
  };
  report.scenes.push(entry);
  addSizes(report.totals.binaryPack, entry.binaryPack);
  addSizes(report.totals.shapeDictionaryPrototype, entry.shapeDictionaryPrototype);
  console.log(`${scene}: pack ${format(entry.binaryPack.raw)} raw, ${format(entry.binaryPack.brotli)} br; shape-dict ${format(entry.shapeDictionaryPrototype.raw)} raw, ${format(entry.shapeDictionaryPrototype.brotli)} br`);
}

writeFileSync(join(outRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${join(outRoot, "report.json")}`);

function buildBinaryPack(scene, sceneDir) {
  const files = walkFiles(sceneDir)
    .filter((file) => !file.endsWith(".DS_Store"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const chunks = [];
  let offset = 0;
  const entries = [];
  for (const file of files) {
    const data = readFileSync(file);
    const path = relative(sceneDir, file).replaceAll("\\", "/");
    entries.push({ path, type: contentType(file), offset, length: data.length });
    chunks.push(data);
    offset += data.length;
  }
  const header = Buffer.from(JSON.stringify({
    format: "mmtour-generated-pack",
    version: 1,
    scene,
    files: entries,
  }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(header.length, 0);
  return { files: entries, buffer: Buffer.concat([prefix, header, ...chunks]) };
}

function buildShapeDictionaryPrototype(scene, sceneDir) {
  const timeline = JSON.parse(readFileSync(join(sceneDir, "timeline.json"), "utf8"));
  const controlFlow = JSON.parse(readFileSync(join(sceneDir, "control-flow.json"), "utf8"));
  const svgRefs = collectSvgRefs(timeline);
  const shapes = {};
  let rawSvgBytes = 0;
  for (const ref of svgRefs) {
    const file = join(root, "public", ref);
    if (!existsSync(file)) continue;
    const svg = readFileSync(file, "utf8");
    rawSvgBytes += Buffer.byteLength(svg);
    shapes[ref] = packSvg(svg);
  }
  return {
    svgFiles: Object.keys(shapes).length,
    rawSvgBytes,
    value: {
      format: "mmtour-shape-dictionary-prototype",
      version: 1,
      scene,
      timeline: packTimeline(timeline),
      controlFlow,
      shapes,
    },
  };
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

function packTimeline(timeline) {
  return {
    s: timeline.scene,
    d: [timeline.dimensions.width, timeline.dimensions.height],
    bg: timeline.backgroundColor,
    fps: timeline.fps,
    fc: timeline.frameCount,
    l: timeline.labels,
    e: timeline.entryFrame,
    fo: timeline.frameSvgsOmitted ? 1 : 0,
    bo: timeline.bakedSpriteFramesOmitted ? 1 : 0,
    a: Object.values(timeline.assets ?? {}).map(packAsset),
    f: packFrames(timeline.frames ?? []),
    c: timeline.control,
  };
}

function packAsset(asset) {
  const out = [asset.id, asset.kind, packOrigin(asset.origin)];
  if (asset.src) out.push(asset.src);
  if (asset.states) {
    out.push(Object.fromEntries(Object.entries(asset.states).map(([key, state]) => [
      key,
      [state.src, packOrigin(state.origin)],
    ])));
  }
  if (asset.text) {
    out.push({
      v: asset.text.normalizedVariableName ?? asset.text.variableName,
      t: asset.text.text,
      f: asset.text.fontId,
      h: asset.text.fontHeight,
      c: asset.text.color,
      x: asset.text.x,
      y: asset.text.y,
      w: asset.text.width,
      hh: asset.text.height,
      a: asset.text.align,
    });
  }
  if (asset.textFields) out.push({ tf: asset.textFields });
  if (asset.timeline?.length) out.push({ tl: packFrames(asset.timeline) });
  if (asset.overflowsBounds) out.push({ ob: 1 });
  return out;
}

function packFrames(frames) {
  return frames.map((frame) => [
    frame.index,
    frame.label ?? 0,
    (frame.instances ?? []).map((instance) => {
      const out = [
        instance.depth,
        instance.characterId,
        instance.placedFrame,
        packMatrix(instance.matrix),
        instance.opacity,
        instance.name || 0,
        instance.clipDepth || 0,
      ];
      if (instance.colorTransform) out.push(packColorTransform(instance.colorTransform));
      return out;
    }),
  ]);
}

function packSvg(svg) {
  const svgAttrs = parseAttrs(svg.match(/<svg\b[^>]*>/)?.[0] ?? "");
  const defs = [];
  const commands = [];
  const tagPattern = /<(g|path|image|pattern|linearGradient|radialGradient|stop)\b[^>]*\/?>/g;
  for (const match of svg.matchAll(tagPattern)) {
    const tag = match[1];
    const attrs = parseAttrs(match[0]);
    if (tag === "g") commands.push(["g", attrs.transform]);
    else if (tag === "path") commands.push(["p", attrs.d, attrs.fill, attrs.stroke, attrs["fill-rule"], attrs.style]);
    else if (tag === "image") commands.push(["i", attrs.width, attrs.height, attrs["xlink:href"] ?? attrs.href, attrs.transform, attrs.x, attrs.y, attrs.style]);
    else if (tag === "pattern") defs.push(["pt", attrs.id, attrs.width, attrs.height, attrs.patternTransform, attrs.patternUnits, attrs.viewBox]);
    else if (tag === "linearGradient") defs.push(["lg", attrs.id, attrs.x1, attrs.y1, attrs.x2, attrs.y2, attrs.gradientTransform, attrs.gradientUnits]);
    else if (tag === "radialGradient") defs.push(["rg", attrs.id, attrs.cx, attrs.cy, attrs.r, attrs.fx, attrs.fy, attrs.gradientTransform, attrs.gradientUnits]);
    else if (tag === "stop") defs.push(["s", attrs.offset, attrs["stop-color"], attrs["stop-opacity"], attrs.style]);
  }
  return {
    w: svgAttrs.width,
    h: svgAttrs.height,
    defs,
    commands,
  };
}

function parseAttrs(tag) {
  const out = {};
  for (const match of tag.matchAll(/([:\w-]+)="([^"]*)"/g)) out[match[1]] = match[2];
  return out;
}

function packOrigin(origin) {
  return [origin.x, origin.y, origin.width, origin.height];
}

function packMatrix(matrix) {
  return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty];
}

function packColorTransform(transform) {
  return [transform.rm, transform.gm, transform.bm, transform.am, transform.ra, transform.ga, transform.ba, transform.aa].map((value) => value ?? 0);
}

function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function contentType(file) {
  switch (extname(file).toLowerCase()) {
    case ".json": return "application/json";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".ttf": return "font/ttf";
    case ".txt": return "text/plain";
    default: return "application/octet-stream";
  }
}

function emptySizes() {
  return {
    binaryPack: { raw: 0, gzip: 0, brotli: 0 },
    shapeDictionaryPrototype: { raw: 0, gzip: 0, brotli: 0 },
  };
}

function addSizes(target, source) {
  target.raw += source.raw;
  target.gzip += source.gzip;
  target.brotli += source.brotli;
}

function format(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
