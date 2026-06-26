import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";
import {
  resolveSound, groupButtonEvents, discoverCallableFunctionNames, markCallableFunctionActionsSupported, runtimeCanExecuteCallableFunctionAction, discoverFunctionAssignments, discoverFunctionBodyCalls, discoverFunctionCallActions, frameVariableActions, chooseExitNavigationTarget,
} from "./lib/asActions.mjs";
import {
  buildFrames, attachSpriteTimelines, markOverflowingSprites, discoverEntryFrame,
} from "./lib/frames.mjs";
import {
  collectNamedUses, iterSpriteFrameUses, parseSvgAttributes, buttonDynamicTextField, reflowSvgTextGroup, groupGlyphRows, svgTextReplacement, inlineSvgAsset, dataUri, registrationShift,
} from "./lib/svgText.mjs";
import {
  stripActionScriptStrings, discoverFunctionCalls, findTellTargetContexts, tellTargetAt, findFunctionContexts, findBranchContexts, findMatchingBrace, matchParenFrom, skipNoiseFrom, findStatementEnd, parseStatements, contextAt, actionContextAt, contextLabel, withActionContext, stringLiteral, resolveFrameExpression, parseActionScriptLiteral, normalizeGeneratedGlobalName, runtimeCanExecuteBranchCommand,
} from "./lib/asParse.mjs";
import {
  number, hex, rectSize, asArray, compactObject, escapeRegExp, roundSvgNumber,
  escapeXmlAttribute, escapeXmlText, decodeXmlEntities, safeDecodeURIComponent,
  normalizeVariableName, normalizeName, normalizeLoadedText, comparableText,
  textAlignFromTag, htmlTextAlign, actionBytesStartWith,
} from "./lib/util.mjs";
import {
  identityMatrix, matrixFromTag, matrixFromSvgTransform, multiplyMatrices,
  opacityFromTag, colorTransformFromTag, colorFromTag,
} from "./lib/geom.mjs";
import { ctx } from "./lib/extractContext.mjs";
import { discoverDefinedFunctions, discoverRegisteredClasses } from "./lib/actionscript.mjs";
import { discoverAssets, normalizeFrameSvgs, replaceStaticVariableText, stripBakedDynamicText, stripButtonStateText } from "./lib/assets.mjs";
import { discoverButtonEvents, discoverControlFlow, discoverFrameActions, discoverNestedSectionTargets, discoverSpriteActions, discoverSpriteLocalDefaults, discoverSpriteStopFrames } from "./lib/controlFlow.mjs";
import { copyIfExists, listDir, preserveGeneratedReports, restoreGeneratedReports } from "./lib/fileUtils.mjs";
import { discoverGlobalDefaults, loadSceneVariables } from "./lib/sceneVars.mjs";
import { discoverRootSoundLibrary, discoverSoundLibrary } from "./lib/sound.mjs";
import { swfToFfdecModel } from "./lib/swfParserAdapter.mjs";

ctx.root = resolve(new URL("..", import.meta.url).pathname);
// Accept "segment4", "segment4.swf", or a path (e.g. "public/segment4.swf") — same as build-control-flow.
ctx.scene = basename(process.argv[2] ?? "segment4", ".swf");
ctx.extractedDir = join(ctx.root, "extracted", ctx.scene);
ctx.xmlPath = join(ctx.extractedDir, `${ctx.scene}.xml`);
ctx.publicDir = join(ctx.root, "public/generated", ctx.scene);
ctx.secondaryDir = join(ctx.publicDir, "secondary");
ctx.parserReportPath = join(ctx.publicDir, "swf-parser-report.json");

// Tag source: FFDec `-swf2xml` (default) OR the pure-JS swf-parser adapter
// (NATIVE_PARSE=1, or automatically when no FFDec XML is present). The adapter
// produces the identical tag model — verified frame-for-frame against the FFDec
// output by scripts/verify-adapter-timeline.mjs — so the downstream extractor is
// unchanged. NATIVE_PARSE removes the Java dependency for the timeline/asset metadata.
const useNativeParse = process.env.NATIVE_PARSE === "1" || !existsSync(ctx.xmlPath);

if (useNativeParse) {
  const swfPath = ["", "public/"].map((p) => join(ctx.root, p, `${ctx.scene}.swf`)).find((p) => existsSync(p));
  if (!swfPath) {
    throw new Error(`No FFDec XML at ${ctx.xmlPath} and no ${ctx.scene}.swf to parse natively.`);
  }
  const { swf } = swfToFfdecModel(new Uint8Array(readFileSync(swfPath)));
  ctx.swf = swf;
  ctx.tags = asArray(ctx.swf.tags?.item);
} else {
  ctx.parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    isArray: (name) => name === "item",
  });
  ctx.swf = ctx.parser.parse(readFileSync(ctx.xmlPath, "utf8")).swf;
  ctx.tags = asArray(ctx.swf.tags?.item);
}
ctx.width = rectSize(ctx.swf.displayRect?.Xmax, ctx.swf.displayRect?.Xmin);
ctx.height = rectSize(ctx.swf.displayRect?.Ymax, ctx.swf.displayRect?.Ymin);
ctx.fps = Number.parseFloat(ctx.swf.frameRate) || 15;
const backgroundColor = colorFromTag(ctx.tags.find((tag) => tag.type === "SetBackgroundColorTag")?.backgroundColor);
ctx.loadedVariables = loadSceneVariables(ctx.scene);
ctx.soundLibrary = discoverSoundLibrary();
ctx.rootSoundLibrary = discoverRootSoundLibrary();
ctx.globalDefaults = discoverGlobalDefaults();

applyFontOverrides();

ctx.assets = discoverAssets(ctx.tags);
ctx.frames = buildFrames(ctx.tags);
attachSpriteTimelines(ctx.assets, ctx.tags);
markOverflowingSprites(ctx.assets);
ctx.labels = Object.fromEntries(ctx.frames.filter((frame) => frame.label).map((frame) => [frame.label, frame.index]));
const entryFrame = discoverEntryFrame(ctx.labels);
ctx.spriteStopFrames = discoverSpriteStopFrames();
ctx.spriteLocalDefaults = discoverSpriteLocalDefaults();
const buttonEvents = discoverButtonEvents(ctx.labels);
const groupedButtonEvents = groupButtonEvents(buttonEvents);
const rawFrameActions = discoverFrameActions(ctx.labels);
const rawSpriteActions = discoverSpriteActions(ctx.labels);
const callableFunctionNames = discoverCallableFunctionNames(groupedButtonEvents, rawFrameActions, rawSpriteActions);
ctx.frameActions = markCallableFunctionActionsSupported(rawFrameActions, callableFunctionNames);
ctx.spriteActions = markCallableFunctionActionsSupported(rawSpriteActions, callableFunctionNames);
ctx.definedFunctions = discoverDefinedFunctions();
ctx.registeredClasses = discoverRegisteredClasses();
ctx.nestedSectionTargets = discoverNestedSectionTargets(groupedButtonEvents);
const control = discoverControlFlow(ctx.tags, ctx.labels, groupedButtonEvents);
control.registeredClasses = ctx.registeredClasses;

const generatedBackup = preserveGeneratedReports();
rmSync(ctx.publicDir, { recursive: true, force: true });
mkdirSync(ctx.publicDir, { recursive: true });
restoreGeneratedReports(generatedBackup);
copyIfExists("shapes");
copyIfExists("sprites");
copyIfExists("images");
copyIfExists("texts");
stripBakedDynamicText(ctx.assets);
copyIfExists("frames");
copyIfExists("scripts");
copyIfExists("buttons");
stripButtonStateText(ctx.assets);
copyIfExists("fonts");
copyIfExists("sounds");
normalizeFrameSvgs(ctx.frames, ctx.assets);
replaceStaticVariableText(ctx.tags);

// Phase 1 (docs/generated-size-and-packing.md): FFDec embeds each bitmap fill as a
// base64 copy inside the shape/button SVG — byte-identical to the extracted images/
// file. Replace those data URIs with a reference to the image file (lossless dedupe;
// ~72% of raw shape SVG bytes). The runtime re-inlines the bytes when it builds the
// shape Blob (src/data/shapeBitmapInline.ts), so rendered output is unchanged.
const bitmapFillShapeSrcs = dereferenceBitmapFills(ctx);

const frameSvgs = listDir("frames")
  .filter((file) => file.endsWith(".svg"))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
  .map((file) => `generated/${ctx.scene}/frames/${file}`);

const output = {
  scene: ctx.scene,
  source: `${ctx.scene}.swf`,
  generatedFrom: "FFDec XML + exported SWF assets",
  dimensions: { width: ctx.width, height: ctx.height },
  backgroundColor,
  fps: ctx.fps,
  frameCount: ctx.frames.length,
  duration: ctx.frames.length / ctx.fps,
  labels: ctx.labels,
  entryFrame,
  control,
  frameSvgs,
  bitmapFillShapeSrcs,
  assets: ctx.assets,
  frames: ctx.frames,
};

writeFileSync(join(ctx.publicDir, "timeline.json"), `${JSON.stringify(output)}\n`);

const controlFlow = {
  scene: ctx.scene,
  source: `${ctx.scene}.swf`,
  generatedFrom: "FFDec XML DoAction tags + exported ActionScript",
  frameRate: ctx.fps,
  frameCount: ctx.frames.length,
  entryFrame,
  labels: ctx.labels,
  stopFrames: control.stopFrames,
  frameActions: ctx.frameActions,
  spriteActions: ctx.spriteActions,
  definedFunctions: ctx.definedFunctions,
  registeredClasses: ctx.registeredClasses,
  spriteStopFrames: ctx.spriteStopFrames,
  spriteLocalDefaults: ctx.spriteLocalDefaults,
  soundLibrary: ctx.soundLibrary,
  globalDefaults: ctx.globalDefaults,
  nestedSectionTargets: ctx.nestedSectionTargets,
  dynamicTexts: control.dynamicTexts,
  buttonActions: control.buttonActions,
  buttons: buttonEvents,
};

writeFileSync(join(ctx.publicDir, "control-flow.json"), `${JSON.stringify(controlFlow, null, 2)}\n`);
console.log(`Wrote ${join(ctx.publicDir, "timeline.json")} and control-flow.json with ${Object.keys(ctx.assets).length} assets and ${ctx.frames.length} frames.`);

/** The level a nav section button loads its segment into — `loadMovieNum(strTarget, intMovieTargLevel)`
 *  in the nav's doRelease(); intMovieTargLevel is a nav-wide constant (4). Resolve it from source so
 *  the runtime loads the clicked segment into the content level instead of guessing. */
/**
 * Replace base64 bitmap-fill data URIs in shape/button SVGs with a reference to the
 * matching extracted images/ file (matched by exact content), then return the srcs
 * of the rewritten SVGs. Lossless: only data URIs whose bytes are byte-identical to
 * an extracted image are dereferenced; anything unmatched is left embedded.
 */
/**
 * Copy committed font overrides (tools/font-overrides/<scene>/*.ttf) over the
 * FFDec-extracted fonts BEFORE asset discovery. Some SWF fonts decompile to a TTF
 * whose cmap is malformed (browser "Failed to decode" → Arial fallback, and the
 * build flags fontLoadable:false) — e.g. bnl's font 35. The override is a repaired
 * copy with a clean cmap; placing it in the extracted dir lets the same metrics
 * drive both fontLoadable detection and the copied public output. The filename must
 * match the FFDec export exactly. See tools/font-overrides/README.md.
 */
function applyFontOverrides() {
  const overrideDir = join(ctx.root, "tools/font-overrides", ctx.scene);
  if (!existsSync(overrideDir)) return;
  const fontsDir = join(ctx.extractedDir, "fonts");
  mkdirSync(fontsDir, { recursive: true });
  for (const file of readdirSync(overrideDir)) {
    if (!file.toLowerCase().endsWith(".ttf")) continue;
    cpSync(join(overrideDir, file), join(fontsDir, file));
    console.log(`Applied font override: ${ctx.scene}/fonts/${file}`);
  }
}

function dereferenceBitmapFills(ctx) {
  const imagesDir = join(ctx.publicDir, "images");
  if (!existsSync(imagesDir)) return [];
  const byBase64 = new Map();
  for (const name of readdirSync(imagesDir)) {
    const file = join(imagesDir, name);
    if (!statSync(file).isFile()) continue;
    byBase64.set(readFileSync(file).toString("base64"), `generated/${ctx.scene}/images/${name}`);
  }
  if (!byBase64.size) return [];

  const changed = new Set();
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.name.endsWith(".svg") ? [path] : [];
  });
  for (const sub of ["shapes", "buttons"]) {
    const dir = join(ctx.publicDir, sub);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const svg = readFileSync(file, "utf8");
      if (!svg.includes(";base64,")) continue;
      let touched = false;
      const rewritten = svg.replace(/(xlink:href|href)="data:[^"]*?;base64,([A-Za-z0-9+/=]+)"/g, (match, attr, base64) => {
        const ref = byBase64.get(base64);
        if (!ref) return match;
        touched = true;
        return `${attr}="${ref}"`;
      });
      if (touched) {
        writeFileSync(file, rewritten);
        changed.add(`generated/${ctx.scene}/${relative(ctx.publicDir, file).replaceAll("\\", "/")}`);
      }
    }
  }
  return [...changed].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
