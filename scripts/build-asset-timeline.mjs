import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
import { discoverDefinedFunctions } from "./lib/actionscript.mjs";
import { discoverAssets, normalizeFrameSvgs, replaceStaticVariableText, stripBakedDynamicText, stripButtonStateText } from "./lib/assets.mjs";
import { discoverButtonEvents, discoverControlFlow, discoverFrameActions, discoverNestedSectionTargets, discoverSpriteActions, discoverSpriteLocalDefaults, discoverSpriteStopFrames } from "./lib/controlFlow.mjs";
import { copyIfExists, listDir, preserveGeneratedReports, restoreGeneratedReports } from "./lib/fileUtils.mjs";
import { discoverGlobalDefaults, loadSceneVariables } from "./lib/sceneVars.mjs";
import { discoverRootSoundLibrary, discoverSoundLibrary } from "./lib/sound.mjs";

ctx.root = resolve(new URL("..", import.meta.url).pathname);
// Accept "segment4", "segment4.swf", or a path (e.g. "public/segment4.swf") — same as build-control-flow.
ctx.scene = basename(process.argv[2] ?? "segment4", ".swf");
ctx.extractedDir = join(ctx.root, "extracted", ctx.scene);
ctx.xmlPath = join(ctx.extractedDir, `${ctx.scene}.xml`);
ctx.publicDir = join(ctx.root, "public/generated", ctx.scene);
ctx.secondaryDir = join(ctx.publicDir, "secondary");
ctx.parserReportPath = join(ctx.publicDir, "swf-parser-report.json");

if (!existsSync(ctx.xmlPath)) {
  throw new Error(`Missing FFDec XML at ${ctx.xmlPath}. Run: node scripts/export-ffdec.mjs ${ctx.scene}.swf`);
}

ctx.parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => name === "item",
});

/** Timeline commands on `self` — handled by the frameActions path, not the function body. */

ctx.swf = ctx.parser.parse(readFileSync(ctx.xmlPath, "utf8")).swf;
ctx.tags = asArray(ctx.swf.tags?.item);
ctx.width = rectSize(ctx.swf.displayRect?.Xmax, ctx.swf.displayRect?.Xmin);
ctx.height = rectSize(ctx.swf.displayRect?.Ymax, ctx.swf.displayRect?.Ymin);
ctx.fps = Number.parseFloat(ctx.swf.frameRate) || 15;
const backgroundColor = colorFromTag(ctx.tags.find((tag) => tag.type === "SetBackgroundColorTag")?.backgroundColor);
ctx.loadedVariables = loadSceneVariables(ctx.scene);
ctx.soundLibrary = discoverSoundLibrary();
ctx.rootSoundLibrary = discoverRootSoundLibrary();
ctx.globalDefaults = discoverGlobalDefaults();

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
ctx.nestedSectionTargets = discoverNestedSectionTargets(groupedButtonEvents);
const control = discoverControlFlow(ctx.tags, ctx.labels, groupedButtonEvents);

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