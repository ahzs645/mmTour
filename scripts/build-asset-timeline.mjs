import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";

const root = resolve(new URL("..", import.meta.url).pathname);
const scene = process.argv[2] ?? "segment4";
const extractedDir = join(root, "extracted", scene);
const xmlPath = join(extractedDir, `${scene}.xml`);
const publicDir = join(root, "public/generated", scene);
const secondaryDir = join(publicDir, "secondary");
const parserReportPath = join(publicDir, "swf-parser-report.json");

if (!existsSync(xmlPath)) {
  throw new Error(`Missing FFDec XML at ${xmlPath}. Run: node scripts/export-ffdec.mjs ${scene}.swf`);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => name === "item",
});

/** Timeline commands on `self` — handled by the frameActions path, not the function body. */
const SELF_TIMELINE_COMMANDS = new Set(["gotoAndPlay", "gotoAndStop", "play", "stop", "nextFrame", "prevFrame", "stopAllSounds"]);

const swf = parser.parse(readFileSync(xmlPath, "utf8")).swf;
const tags = asArray(swf.tags?.item);
const width = rectSize(swf.displayRect?.Xmax, swf.displayRect?.Xmin);
const height = rectSize(swf.displayRect?.Ymax, swf.displayRect?.Ymin);
const fps = Number.parseFloat(swf.frameRate) || 15;
const backgroundColor = colorFromTag(tags.find((tag) => tag.type === "SetBackgroundColorTag")?.backgroundColor);
const loadedVariables = loadSceneVariables(scene);
const soundLibrary = discoverSoundLibrary();
const rootSoundLibrary = discoverRootSoundLibrary();
const globalDefaults = discoverGlobalDefaults();

const assets = discoverAssets(tags);
const frames = buildFrames(tags);
attachSpriteTimelines(assets, tags);
markOverflowingSprites(assets);
const labels = Object.fromEntries(frames.filter((frame) => frame.label).map((frame) => [frame.label, frame.index]));
const entryFrame = discoverEntryFrame(labels);
const spriteStopFrames = discoverSpriteStopFrames();
const spriteLocalDefaults = discoverSpriteLocalDefaults();
const buttonEvents = discoverButtonEvents(labels);
const groupedButtonEvents = groupButtonEvents(buttonEvents);
const rawFrameActions = discoverFrameActions(labels);
const rawSpriteActions = discoverSpriteActions(labels);
const callableFunctionNames = discoverCallableFunctionNames(groupedButtonEvents, rawFrameActions, rawSpriteActions);
const frameActions = markCallableFunctionActionsSupported(rawFrameActions, callableFunctionNames);
const spriteActions = markCallableFunctionActionsSupported(rawSpriteActions, callableFunctionNames);
const definedFunctions = discoverDefinedFunctions();
const nestedSectionTargets = discoverNestedSectionTargets(groupedButtonEvents);
const control = discoverControlFlow(tags, labels, groupedButtonEvents);

const generatedBackup = preserveGeneratedReports();
rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });
restoreGeneratedReports(generatedBackup);
copyIfExists("shapes");
copyIfExists("sprites");
copyIfExists("images");
copyIfExists("texts");
stripBakedDynamicText(assets);
copyIfExists("frames");
copyIfExists("scripts");
copyIfExists("buttons");
copyIfExists("fonts");
copyIfExists("sounds");
normalizeFrameSvgs(frames, assets);
replaceStaticVariableText(tags);

const frameSvgs = listDir("frames")
  .filter((file) => file.endsWith(".svg"))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
  .map((file) => `generated/${scene}/frames/${file}`);

const output = {
  scene,
  source: `${scene}.swf`,
  generatedFrom: "FFDec XML + exported SWF assets",
  dimensions: { width, height },
  backgroundColor,
  fps,
  frameCount: frames.length,
  duration: frames.length / fps,
  labels,
  entryFrame,
  control,
  frameSvgs,
  assets,
  frames,
};

writeFileSync(join(publicDir, "timeline.json"), `${JSON.stringify(output)}\n`);

const controlFlow = {
  scene,
  source: `${scene}.swf`,
  generatedFrom: "FFDec XML DoAction tags + exported ActionScript",
  frameRate: fps,
  frameCount: frames.length,
  entryFrame,
  labels,
  stopFrames: control.stopFrames,
  frameActions,
  spriteActions,
  definedFunctions,
  spriteStopFrames,
  spriteLocalDefaults,
  soundLibrary,
  globalDefaults,
  nestedSectionTargets,
  dynamicTexts: control.dynamicTexts,
  buttonActions: control.buttonActions,
  buttons: buttonEvents,
};

writeFileSync(join(publicDir, "control-flow.json"), `${JSON.stringify(controlFlow, null, 2)}\n`);
console.log(`Wrote ${join(publicDir, "timeline.json")} and control-flow.json with ${Object.keys(assets).length} assets and ${frames.length} frames.`);

function discoverAssets(allTags) {
  const defs = {};

  for (const tag of allTags) {
    if (!tag?.type) continue;

    if (tag.type.startsWith("DefineShape") && tag.shapeId) {
      const id = String(tag.shapeId);
      const src = `generated/${scene}/shapes/${id}.svg`;
      defs[id] = {
        id: Number(id),
        kind: "shape",
        src,
        origin: svgOrigin(join(extractedDir, "shapes", `${id}.svg`)),
      };
    }

    if (tag.type === "DefineSpriteTag" && tag.spriteId) {
      const id = String(tag.spriteId);
      const dirName = findSpriteDir(id);
      if (dirName) {
        const files = readdirSync(join(extractedDir, "sprites", dirName))
          .filter((file) => file.endsWith(".svg"))
          .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
        defs[id] = {
          id: Number(id),
          kind: "sprite",
          frames: files.map((file) => `generated/${scene}/sprites/${dirName}/${file}`),
          origin: svgOrigin(join(extractedDir, "sprites", dirName, files[0])),
        };
      }
    }

    if (tag.type.startsWith("DefineText") && tag.characterID) {
      const id = String(tag.characterID);
      defs[id] = {
        id: Number(id),
        kind: "text",
        src: `generated/${scene}/texts/${id}.txt`,
        origin: { x: 0, y: 0, width: 0, height: 0 },
      };
    }

    // DefineEditText fields carry their own styling (font, size, color, box).
    // Capture it for every field — not just the variable-loaded ones — so the
    // player can render them in the original typeface.
    if (tag.type === "DefineEditTextTag" && tag.characterID) {
      const id = String(tag.characterID);
      const bounds = tag.bounds;
      const width = bounds ? (number(bounds.Xmax, 0) - number(bounds.Xmin, 0)) / 20 : 0;
      const height = bounds ? (number(bounds.Ymax, 0) - number(bounds.Ymin, 0)) / 20 : 0;
      const style = compactObject({
        fontId: number(tag.fontId, 0) || undefined,
        fontHeight: number(tag.fontHeight, 0) / 20,
        leading: number(tag.leading, 0) / 20,
        color: colorFromTag(tag.textColor),
        align: htmlTextAlign(tag, tag.initialText),
        x: bounds ? number(bounds.Xmin, 0) / 20 : undefined,
        y: bounds ? number(bounds.Ymin, 0) / 20 : undefined,
        width: width || undefined,
        height: height || undefined,
        multiline: tag.multiline === "true",
        wordWrap: tag.wordWrap === "true",
        html: tag.html === "true",
        text: normalizeLoadedText(String(tag.initialText ?? "")) || undefined,
        // Variable binding (e.g. `_root.skipIntro`) so the runtime can fill the
        // field from loadVariables() — these fields are baked empty in sprites.
        variableName: tag.variableName || undefined,
        normalizedVariableName: tag.variableName ? normalizeVariableName(tag.variableName) : undefined,
      });
      defs[id] = {
        id: Number(id),
        kind: "text",
        src: `generated/${scene}/texts/${id}.txt`,
        origin: { x: style.x ?? 0, y: style.y ?? 0, width: width, height: height },
        text: style,
      };
    }
  }

  for (const file of listDir("texts")) {
    const id = basename(file, ".txt");
    defs[id] ??= {
      id: Number(id),
      kind: "text",
      src: `generated/${scene}/texts/${file}`,
      origin: { x: 0, y: 0, width: 0, height: 0 },
    };
  }

  for (const file of listDir("images")) {
    const id = basename(file, ".png");
    defs[id] ??= {
      id: Number(id),
      kind: "image",
      src: `generated/${scene}/images/${file}`,
      origin: { x: 0, y: 0, width: 0, height: 0 },
    };
  }

  const buttonsDir = join(extractedDir, "buttons");
  for (const path of existsSync(buttonsDir) ? walkFiles(buttonsDir) : []) {
    if (!path.endsWith(".svg")) continue;
    const relative = path.slice(buttonsDir.length + 1).replaceAll("\\", "/");
    const id = relative.match(/DefineButton2?_(\d+)/)?.[1] ?? basename(path, ".svg").match(/\d+/)?.[0] ?? basename(path, ".svg");
    const state = basename(path, ".svg").replace(/^\d+_/, "");
    const key = `button:${id}`;
    const stateEntry = {
      src: `generated/${scene}/buttons/${relative}`,
      origin: svgOrigin(path),
    };
    defs[key] ??= {
      id: Number(id),
      kind: "button",
      origin: stateEntry.origin,
      states: {},
    };
    defs[key].states[state] = stateEntry;
    if (!defs[key].src && state !== "hittest") defs[key].src = stateEntry.src;
    // A button wrapping a bound editText (e.g. the nav "Skip Intro" button): record
    // the field's button-record placement so the runtime can overlay the live
    // loadVariables() value with the field's own bounds. FFDec bakes it at the field
    // registration (mispositioned) and leaves the composited sprite frame empty.
    if (state === "up") {
      const field = buttonDynamicTextField(
        path,
        (cid) => defs[String(cid)]?.kind === "text" && Boolean(defs[String(cid)]?.text?.normalizedVariableName),
      );
      if (field) defs[key].textFields = [field];
    }
  }

  for (const file of listDir("fonts")) {
    const id = basename(file).match(/\d+/)?.[0] ?? basename(file);
    defs[`font:${id}`] = {
      id: Number(id),
      kind: "font",
      src: `generated/${scene}/fonts/${file}`,
      origin: { x: 0, y: 0, width: 0, height: 0 },
    };
  }

  for (const file of listDir("sounds")) {
    const id = basename(file).match(/\d+/)?.[0] ?? basename(file);
    defs[`sound:${id}`] = {
      id: Number(id),
      kind: "sound",
      src: `generated/${scene}/sounds/${file}`,
      origin: { x: 0, y: 0, width: 0, height: 0 },
    };
  }

  return defs;
}

function discoverSoundLibrary() {
  const sounds = {};
  for (const file of listDir("sounds")) {
    if (!/\.(mp3|wav|flv)$/i.test(file)) continue;
    const name = basename(file).replace(/^[+-]?\d+_/, "").replace(/\.[^.]+$/, "");
    if (!name || name === "-1") continue;
    sounds[name] = {
      name,
      src: `generated/${scene}/sounds/${file}`,
    };
  }
  return sounds;
}

function discoverRootSoundLibrary() {
  const sounds = {};
  const rootSoundsDir = join(root, "extracted", "A-tour", "sounds");
  if (!existsSync(rootSoundsDir)) return sounds;

  for (const filePath of walkFiles(rootSoundsDir)) {
    if (!/\.(mp3|wav|flv)$/i.test(filePath)) continue;
    const file = basename(filePath);
    const name = file.replace(/^[+-]?\d+_/, "").replace(/\.[^.]+$/, "");
    if (!name || name === "-1") continue;
    sounds[name] = {
      name,
      src: `generated/A-tour/sounds/${file}`,
    };
  }
  return sounds;
}

function resolveSound(library, requestedName) {
  if (!requestedName) return undefined;
  if (library[requestedName]) return library[requestedName];

  const normalized = requestedName.toLowerCase();
  return Object.values(library).find((sound) => sound.name.toLowerCase() === normalized);
}

function buildFrames(allTags) {
  const displayList = new Map();
  const snapshots = [];
  let label = "";

  for (const tag of allTags) {
    if (!tag?.type) continue;

    if (tag.type === "FrameLabelTag") {
      label = tag.name ?? label;
      continue;
    }

    if (tag.type === "RemoveObject2Tag") {
      displayList.delete(Number(tag.depth));
      continue;
    }

    if (tag.type === "PlaceObject2Tag") {
      const depth = Number(tag.depth);
      const existing = displayList.get(depth) ?? { depth, characterId: 0, matrix: identityMatrix(), opacity: 1, name: "" };
      const characterId = Number(tag.characterId);
      const hasNewCharacter = characterId > 0;
      const clipDepth = Number(tag.clipDepth) || 0;
      const next = {
        ...existing,
        depth,
        characterId: hasNewCharacter ? characterId : existing.characterId,
        placedFrame: hasNewCharacter ? snapshots.length : existing.placedFrame ?? snapshots.length,
        name: tag.name ?? existing.name,
        matrix: tag.matrix ? matrixFromTag(tag.matrix) : existing.matrix,
        opacity: tag.colorTransform ? opacityFromTag(tag.colorTransform) : existing.opacity,
        // Colour tint (RGB mult+add) lives on the placement, separate from alpha.
        colorTransform: tag.colorTransform ? colorTransformFromTag(tag.colorTransform) : existing.colorTransform,
        // A PlaceObject2 with clipDepth > 0 is a mask clipping depths (depth, clipDepth].
        clipDepth: clipDepth > 0 ? clipDepth : hasNewCharacter ? undefined : existing.clipDepth,
      };
      displayList.set(depth, next);
      continue;
    }

    if (tag.type === "ShowFrameTag") {
      snapshots.push({
        index: snapshots.length,
        label,
        instances: [...displayList.values()]
          .filter((instance) => instance.characterId > 0)
          .sort((a, b) => a.depth - b.depth),
      });
      label = "";
    }
  }

  return snapshots;
}

/**
 * Extract each DefineSprite's internal display-list timeline (the same way the
 * root timeline is built) and attach it to the sprite asset. This preserves the
 * nested MovieClip structure FFDec otherwise flattens into baked per-frame SVGs,
 * giving the runtime the data it needs to drive nested playheads and _parent/
 * _root navigation. Baked `frames[]` SVGs are kept for leaf rendering.
 */
function attachSpriteTimelines(assetDefs, allTags) {
  for (const tag of allTags) {
    if (tag?.type !== "DefineSpriteTag" || !tag.spriteId) continue;
    const id = String(tag.spriteId);
    const asset = assetDefs[id];
    if (!asset || asset.kind !== "sprite") continue;

    const subTags = asArray(tag.subTags?.item);
    const spriteFrames = buildFrames(subTags);
    // Only attach when there is an actual nested display list (placed children),
    // so trivial single-shape sprites don't bloat the timeline JSON.
    if (!spriteFrames.some((frame) => frame.instances.length)) continue;

    asset.timeline = spriteFrames.map((frame) => compactObject({
      index: frame.index,
      label: frame.label || undefined,
      instances: frame.instances,
    }));
  }
}

/**
 * Flag sprites whose animated content slides OUTSIDE their own bounds — FFDec bakes each
 * frame clipped to the sprite bounds, so moving content (e.g. the nav cascade buttons
 * sliding vertically through their ~28px-tall *ProAnim sprites) gets dropped from the baked
 * frame, making it flicker. The runtime renders these from the display-list tree instead
 * (the instances persist there, unclipped). Skip sprites that use a clip-mask (clipDepth) —
 * those rely on the baked composite, which the tree can't reproduce.
 */
function markOverflowingSprites(assetDefs) {
  for (const asset of Object.values(assetDefs)) {
    if (asset?.kind !== "sprite" || !asset.timeline?.length || !asset.frames?.length) continue;
    const b = asset.origin;
    if (!b || !b.width || !b.height) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, hasMask = false, any = false;
    for (const frame of asset.timeline) {
      for (const ins of frame.instances ?? []) {
        if (ins.clipDepth) hasMask = true;
        const child = assetDefs[String(ins.characterId)] ?? assetDefs[`button:${ins.characterId}`];
        const o = child?.origin;
        if (!o || (!o.width && !o.height)) continue;
        const m = ins.matrix ?? { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
        for (const [cx, cy] of [[o.x, o.y], [o.x + o.width, o.y], [o.x, o.y + o.height], [o.x + o.width, o.y + o.height]]) {
          const x = m.a * cx + m.c * cy + m.tx;
          const y = m.b * cx + m.d * cy + m.ty;
          minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); any = true;
        }
      }
    }
    if (!any || hasMask) continue;
    const T = 20; // tolerance for minor/rounding overflow
    if (minX < b.x - T || minY < b.y - T || maxX > b.x + b.width + T || maxY > b.y + b.height + T) {
      asset.overflowsBounds = true;
    }
  }
}

function discoverEntryFrame(frameLabels) {
  for (const label of ["noKiosk", "segStart", "desktop", "Code Setup"]) {
    if (label in frameLabels) return frameLabels[label];
  }
  return 0;
}

function discoverControlFlow(allTags, frameLabels, groupedEvents) {
  const stopFrames = [];
  let frameIndex = 0;

  for (const tag of allTags) {
    if (!tag?.type) continue;

    if (tag.type === "DoActionTag" && actionBytesStartWith(tag.actionBytes, "07")) {
      stopFrames.push(frameIndex);
    }

    if (tag.type === "ShowFrameTag") {
      frameIndex += 1;
    }
  }

  return {
    stopFrames: [...new Set(stopFrames)].filter((index) => index >= 0 && index < frames.length).sort((a, b) => a - b),
    spriteStopFrames,
    spriteLocalDefaults,
    frameActions,
    spriteActions,
    definedFunctions,
    soundLibrary,
    globalDefaults,
    nestedSectionTargets,
    dynamicTexts: discoverDynamicTexts(allTags),
    buttonActions: Object.fromEntries(
      Object.entries(groupedEvents)
        .filter(([, event]) => event.release?.supported
          || event.release?.functionCalls?.length
          || event.rollOver?.functionCalls?.length
          || event.rollOut?.functionCalls?.length
          || nestedSectionTargets[event.release?.target])
        .map(([characterId, event]) => [
          characterId,
          compactObject({
            ownerSpriteIds: discoverButtonOwnerSprites(characterId),
            release: compactObject({
              target: event.release.target,
              command: event.release.command,
              label: event.release.label,
              frame: event.release.frame,
              frameExpression: event.release.frameExpression,
              swf: event.release.swf,
              exitNavigation: event.release.exitNavigation,
              rootFunctionNavigation: event.release.rootFunctionNavigation,
              functionCalls: event.release.functionCalls,
              nestedSection: nestedSectionTargets[event.release.target],
              source: event.release.source,
            }),
            rollOver: event.rollOver
              ? compactObject({
                  command: event.rollOver.command,
                  label: event.rollOver.label,
                  frame: event.rollOver.frame,
                  frameExpression: event.rollOver.frameExpression,
                  swf: event.rollOver.swf,
                  functionCalls: event.rollOver.functionCalls,
                  source: event.rollOver.source,
                })
              : undefined,
            rollOut: event.rollOut
              ? compactObject({
                  command: event.rollOut.command,
                  label: event.rollOut.label,
                  frame: event.rollOut.frame,
                  frameExpression: event.rollOut.frameExpression,
                  swf: event.rollOut.swf,
                  functionCalls: event.rollOut.functionCalls,
                  source: event.rollOut.source,
                })
              : undefined,
          }),
        ]),
    ),
  };
}

function discoverGlobalDefaults() {
  const sourcePath = join(root, "extracted", "A-tour", "scripts", "frame_1", "DoAction.as");
  if (!existsSync(sourcePath)) return {};

  const source = readFileSync(sourcePath, "utf8");
  const defaults = {};
  for (const match of source.matchAll(/\bbkgd\.([A-Za-z_$][\w$]*)\s*=\s*("[^"]*"|'[^']*'|[-]?\d+(?:\.\d+)?|true|false)\s*;/g)) {
    defaults[`bkgd.${match[1]}`] = parseActionScriptLiteral(match[2]);
  }
  return defaults;
}

function parseActionScriptLiteral(value) {
  const trimmed = String(value).trim();
  const stringMatch = trimmed.match(/^"([^"]*)"$/) ?? trimmed.match(/^'([^']*)'$/);
  if (stringMatch) return stringMatch[1];
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const numericValue = Number(trimmed);
  return Number.isFinite(numericValue) ? numericValue : trimmed;
}

function discoverNestedSectionTargets(groupedEvents) {
  const targets = {};
  const normalizedLabels = new Map(Object.entries(labels).map(([label, frame]) => [normalizeName(label), { label, frame }]));

  for (const event of Object.values(groupedEvents)) {
    const release = event.release;
    if (!release?.target || release.target === "_root" || release.target === "self" || release.target === "_parent") continue;

    const normalizedTarget = normalizeName(release.target);
    const direct = normalizedLabels.get(normalizedTarget);
    if (direct) {
      targets[release.target] = direct;
      continue;
    }

    if (normalizedTarget.startsWith("mc")) {
      const withoutPrefix = normalizedTarget.slice(2);
      const match = normalizedLabels.get(withoutPrefix);
      if (match) targets[release.target] = match;
    }
  }

  return targets;
}

function discoverDynamicTexts(allTags) {
  const dynamicTexts = {};

  for (const tag of allTags) {
    if (!tag?.characterID || !tag.variableName) continue;

    const variableName = normalizeVariableName(tag.variableName);
    const loadedText = loadedVariables[variableName];
    if (!loadedText) continue;

    const initialText = normalizeLoadedText(String(tag.initialText ?? ""));
    if (comparableText(initialText) === comparableText(loadedText)) continue;

    const id = String(tag.characterID);
    const bounds = tag.bounds;
    const boundsWidth = bounds ? (number(bounds.Xmax, 0) - number(bounds.Xmin, 0)) / 20 : 0;
    const boundsHeight = bounds ? (number(bounds.Ymax, 0) - number(bounds.Ymin, 0)) / 20 : 0;
    dynamicTexts[id] = compactObject({
      characterId: Number(id),
      variableName: tag.variableName,
      normalizedVariableName: variableName,
      text: loadedText,
      fontId: number(tag.fontId, 0) || undefined,
      fontHeight: number(tag.fontHeight, 0) / 20,
      leading: number(tag.leading, 0) / 20,
      color: colorFromTag(tag.textColor),
      align: htmlTextAlign(tag, loadedText),
      x: bounds ? number(bounds.Xmin, 0) / 20 : undefined,
      y: bounds ? number(bounds.Ymin, 0) / 20 : undefined,
      width: boundsWidth || undefined,
      height: boundsHeight || undefined,
      multiline: tag.multiline === "true",
      wordWrap: tag.wordWrap === "true",
      html: tag.html === "true",
    });
  }

  return dynamicTexts;
}

function groupButtonEvents(events) {
  const grouped = {};
  for (const event of events) {
    const group = grouped[event.characterId] ?? { characterId: event.characterId, events: [] };
    group.events = [...new Set([...group.events, ...event.events])];
    if (event.release) group.release = event.release;
    if (event.rollOver) group.rollOver = event.rollOver;
    if (event.rollOut) group.rollOut = event.rollOut;
    grouped[event.characterId] = group;
  }
  return grouped;
}

function discoverCallableFunctionNames(groupedEvents, ...actionEntryGroups) {
  const names = new Set();
  for (const group of Object.values(groupedEvents)) {
    for (const eventName of ["release", "rollOver", "rollOut"]) {
      for (const call of group[eventName]?.functionCalls ?? []) {
        if (call.functionName) names.add(call.functionName);
      }
    }
  }
  for (const entries of actionEntryGroups) {
    for (const entry of entries ?? []) {
      for (const action of entry.actions ?? []) {
        for (const call of action.functionCalls ?? []) {
          if (call.functionName) names.add(call.functionName);
        }
      }
    }
  }
  return names;
}

function markCallableFunctionActionsSupported(entries, callableNames) {
  if (!callableNames.size) return entries;

  return entries.map((entry) => ({
    ...entry,
    actions: (entry.actions ?? []).map((action) => {
      if (action.executionContext !== "function" || !callableNames.has(action.functionName)) return action;
      if (!runtimeCanExecuteCallableFunctionAction(action)) return action;

      const { reason, ...supportedAction } = action;
      return {
        ...supportedAction,
        supported: true,
        invokedByButtonFunction: true,
      };
    }),
  }));
}

function runtimeCanExecuteCallableFunctionAction(action) {
  if ((action.command === "gotoAndPlay" || action.command === "gotoAndStop") && action.target === "self") {
    return typeof action.frame === "number" || typeof action.frameExpression === "string" || typeof action.label === "string";
  }
  if ((action.command === "gotoAndPlay" || action.command === "gotoAndStop") && action.target && !/^_level\d+/i.test(action.target)) {
    return typeof action.frame === "number" || typeof action.frameExpression === "string" || typeof action.label === "string";
  }

  if (action.command === "callFunctions") return Boolean(action.functionCalls?.length);
  if (action.command === "stopSound") return true;
  return (action.command === "playVO" || action.command === "attachSound") && Boolean(action.soundSrc);
}

function discoverDefinedFunctions() {
  const scriptsDir = join(extractedDir, "scripts");
  if (!existsSync(scriptsDir)) return [];

  const functions = [];
  const seen = new Set();
  for (const filePath of walkFiles(scriptsDir).filter((path) => path.endsWith(".as"))) {
    const source = readFileSync(filePath, "utf8");
    const sourcePath = relativeExtractedPath(filePath);
    for (const match of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)) {
      const sprite = sourcePath.match(/^scripts\/DefineSprite_(\d+)(?:_|\/)/);
      const key = `${sourcePath}:${match[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bodyStart = (match.index ?? 0) + match[0].length - 1;
      const bodyEnd = findMatchingBrace(source, bodyStart);
      const body = source.slice(bodyStart + 1, bodyEnd);
      const assignments = discoverFunctionAssignments(body);
      const calls = discoverFunctionBodyCalls(body);
      // Branch-aware body: ordered assignments + method-calls, each with the if/else
      // guard it runs under (so e.g. showSceneMenu only fires the active section's button).
      const statements = parseStatements(body);
      functions.push(compactObject({
        functionName: match[1],
        parameters: match[2].split(",").map((param) => param.trim()).filter(Boolean),
        scope: sprite ? "sprite" : "root",
        ...(sprite ? { spriteId: Number(sprite[1]) } : {}),
        ...(assignments.length ? { assignments } : {}),
        ...(calls.length ? { calls } : {}),
        ...(statements.length ? { body: statements } : {}),
        source: sourcePath,
      }));
    }
  }

  return functions.sort((a, b) => (
    a.source.localeCompare(b.source) || a.functionName.localeCompare(b.functionName)
  ));
}

function discoverFunctionAssignments(body) {
  const source = stripActionScriptStrings(body);
  const assignments = [];
  for (const match of source.matchAll(/(?:^|[\s;{}])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*([^;\n]+)\s*;/g)) {
    const target = match[1];
    if (target === "var") continue;
    assignments.push(compactObject({
      target,
      value: parseActionScriptLiteral(match[2]),
      rawValue: match[2].trim(),
    }));
  }
  return assignments;
}

function discoverFunctionBodyCalls(body) {
  const source = body;
  const calls = [];
  for (const match of source.matchAll(/([A-Za-z0-9_.$]+)\.([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?/g)) {
    calls.push({
      target: match[1],
      functionName: match[2],
      arguments: match[3].trim(),
    });
  }
  for (const match of source.matchAll(/(?:^|[\s;{}])([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?/g)) {
    if (["if", "while", "for", "switch", "return", "function", "trace", "int", "getTimer", "getSndTime"].includes(match[1])) continue;
    calls.push({
      target: "self",
      functionName: match[1],
      arguments: match[2].trim(),
    });
  }
  return calls;
}

function stripActionScriptStrings(source) {
  return source.replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, (literal) => literal[0] === "'" ? "''" : '""');
}

function discoverButtonOwnerSprites(characterId) {
  const marker = `ffdec:characterId="${characterId}"`;
  return Object.values(assets)
    .filter((asset) => asset.kind === "sprite" && asset.frames?.length)
    .filter((asset) =>
      asset.frames.some((src) => {
        const relative = src.split(`generated/${scene}/`).pop();
        return relative ? readFileSync(join(extractedDir, relative), "utf8").includes(marker) : false;
      }),
    )
    .map((asset) => asset.id)
    .sort((a, b) => a - b);
}

function discoverButtonEvents(frameLabels) {
  const scriptsDir = join(extractedDir, "scripts");
  if (!existsSync(scriptsDir)) return [];

  const events = [];
  for (const file of walkFiles(scriptsDir).filter((path) => path.endsWith(".as") && path.includes("DefineButton2_"))) {
    const normalized = file.replaceAll("\\", "/");
    const eventMatch = normalized.match(/BUTTONCONDACTION on\(([^)]+)\)\.as$/);
    if (!eventMatch) continue;

    const buttonId = normalized.match(/DefineButton2_(\d+)\//)?.[1];
    if (!buttonId) continue;

    const sourcePath = `scripts/${normalized.split("/scripts/").pop()}`;
    const source = readFileSync(file, "utf8");
    const eventNames = eventMatch[1].split(",").map((event) => event.trim());
    const eventName = eventNames.includes("release")
      ? "release"
      : eventNames.includes("rollOver")
        ? "rollOver"
        : eventNames.includes("rollOut")
          ? "rollOut"
          : eventNames[0] ?? "unknown";
    const parsedAction = parseActionScript(source, frameLabels, sourcePath);

    events.push({
      characterId: buttonId,
      event: eventName,
      events: eventNames,
      [eventName]: parsedAction,
    });
  }

  return events.sort((a, b) => Number(a.characterId) - Number(b.characterId) || a.event.localeCompare(b.event));
}

function parseActionScript(source, frameLabels, sourcePath) {
  const rootGoto = source.match(/_root\.gotoAnd(Play|Stop)\(([^)]+)\)/);
  const clipGoto = source.match(/([A-Za-z0-9_.$]+)\.gotoAnd(Play|Stop)\(([^)]+)\)/);
  const localGoto = source.match(/(?:^|[\s;])gotoAnd(Play|Stop)\(([^)]+)\)/);
  const doRelease = source.match(/(?:_level0\.)?doRelease\("([^"]+\.swf)"\)/);
  const loadMovie = source.match(/loadMovieNum\("([^"]+\.swf)"/);
  const swf = doRelease?.[1] ?? loadMovie?.[1];
  const exitNavigation = inferExitNavigation(source, frameLabels);
  const functionCalls = discoverFunctionCalls(source);

  if (exitNavigation) {
    return {
      target: "_root",
      command: "gotoAndPlay",
      label: exitNavigation.exitLabel,
      frame: exitNavigation.exitFrame,
      swf: exitNavigation.swf,
      exitNavigation,
      ...(functionCalls.length ? { functionCalls } : {}),
      source: sourcePath,
      supported: true,
    };
  }

  if (rootGoto) {
    const expression = rootGoto[2].trim();
    const label = stringLiteral(expression);
    const frame = resolveFrameExpression(expression, frameLabels);
    return {
      target: "_root",
      command: `gotoAnd${rootGoto[1]}`,
      ...(label ? { label } : { frameExpression: expression }),
      ...(frame >= 0 ? { frame } : {}),
      swf,
      ...(functionCalls.length ? { functionCalls } : {}),
      source: sourcePath,
      supported: frame >= 0 || Boolean(swf),
      ...(frame >= 0 || swf ? {} : { reason: "Root goto target could not be resolved from exported frame labels." }),
    };
  }

  if (localGoto) {
    const expression = localGoto[2].trim();
    const label = stringLiteral(expression);
    const frame = resolveFrameExpression(expression, frameLabels);
    return {
      target: "self",
      command: `gotoAnd${localGoto[1]}`,
      ...(label ? { label } : { frameExpression: expression }),
      ...(frame >= 0 ? { frame } : {}),
      swf,
      ...(functionCalls.length ? { functionCalls } : {}),
      source: sourcePath,
      supported: Boolean(swf),
      ...(swf ? {} : { reason: "Clip-local goto actions are extracted but not compiled into the frame-SVG runtime yet." }),
    };
  }

  if (clipGoto) {
    const target = clipGoto[1];
    const frameExpression = clipGoto[3].trim();
    const parentLabel = stringLiteral(frameExpression);
    const frame = resolveFrameExpression(frameExpression, frameLabels);
    const parentMapsToRoot = target === "_parent" && frame >= 0;
    return {
      target: parentMapsToRoot ? "_root" : target,
      command: `gotoAnd${clipGoto[2]}`,
      ...(parentLabel ? { label: parentLabel } : { frameExpression }),
      ...(parentMapsToRoot ? { frame } : {}),
      swf,
      ...(functionCalls.length ? { functionCalls } : {}),
      source: sourcePath,
      supported: parentMapsToRoot || Boolean(swf),
      ...(parentMapsToRoot || swf ? {} : { reason: "Nested MovieClip actions are extracted but not compiled into the frame-SVG runtime yet." }),
    };
  }

  if (swf) {
    return {
      swf,
      source: sourcePath,
      supported: true,
    };
  }

  const rootFunctionNavigation = inferRootFunctionNavigation(functionCalls);
  if (rootFunctionNavigation?.swf) {
    return {
      swf: rootFunctionNavigation.swf,
      rootFunctionNavigation,
      functionCalls,
      source: sourcePath,
      supported: true,
    };
  }

  if (functionCalls.length) {
    return {
      command: "callFunctions",
      functionCalls,
      swf,
      source: sourcePath,
      supported: true,
    };
  }

  return {
    source: sourcePath,
    swf,
    supported: Boolean(swf),
    ...(swf ? {} : { reason: "No supported root timeline or SWF navigation action found." }),
  };
}

function discoverFunctionCalls(source) {
  const calls = [];
  for (const match of source.matchAll(/([A-Za-z0-9_.$]+)\.([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?/g)) {
    const functionName = match[2];
    if (functionName.startsWith("gotoAnd") || ["attachSound", "doRelease", "loadMovie", "loadMovieNum", "loadVariables"].includes(functionName)) continue;
    const target = match[1];
    if (target.endsWith(".s1") || target.endsWith(".s2")) continue;
    calls.push({
      target,
      functionName,
      arguments: match[3].trim(),
    });
  }
  return calls;
}

/**
 * `tellTarget("clip") { … }` redirects the calls in its body to run on that nested
 * clip. Return the body ranges + clip name so calls inside are retargeted (the
 * runtime resolves the clip by name and runs its sprite-defined function).
 */
function findTellTargetContexts(source) {
  const contexts = [];
  for (const match of source.matchAll(/tellTarget\s*\(\s*"([^"]+)"\s*\)\s*\{/g)) {
    const clip = match[1];
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
    }
    contexts.push({ clip, start: match.index ?? 0, end: i });
  }
  return contexts;
}

function tellTargetAt(contexts, index) {
  for (const c of contexts) if (index >= c.start && index < c.end) return c.clip;
  return undefined;
}

function discoverFunctionCallActions(source, functionContexts, branchContexts, tellTargets = []) {
  const calls = [];
  for (const match of source.matchAll(/([A-Za-z0-9_.$]+)\.([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?/g)) {
    const target = match[1];
    const functionName = match[2];
    if (target === "_level0" || target === "_root") continue;
    if (target.endsWith(".s1") || target.endsWith(".s2") || /^_root\.snd_/i.test(target)) continue;
    if (functionName.startsWith("gotoAnd") || ["attachSound", "doRelease", "loadMovie", "loadMovieNum", "loadVariables", "stop", "setVolume", "getVolume"].includes(functionName)) continue;

    calls.push({
      call: {
        target,
        functionName,
        arguments: match[3].trim(),
      },
      context: actionContextAt(functionContexts, branchContexts, match.index ?? 0),
    });
  }
  for (const match of source.matchAll(/(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?/g)) {
    const functionName = match[1];
    // `tellTarget(…)` is a scoping directive, not a real call — skip it.
    if (functionName === "tellTarget") continue;
    if (["if", "while", "for", "function", "switch", "trace", "stop", "play", "gotoAndPlay", "gotoAndStop", "loadVariables", "loadMovieNum", "getTimer", "int", "typeof", "unloadMovie", "unloadMovieNum"].includes(functionName)) continue;
    const before = source.slice(Math.max(0, (match.index ?? 0) - 12), match.index ?? 0);
    if (/\bfunction\s*$/i.test(before)) continue;

    // Inside a tellTarget("clip") block the call runs on that nested clip; otherwise _root.
    const clip = tellTargetAt(tellTargets, match.index ?? 0);
    calls.push({
      call: {
        target: clip ?? "_root",
        functionName,
        arguments: match[2].trim(),
      },
      context: actionContextAt(functionContexts, branchContexts, match.index ?? 0),
    });
  }
  return calls;
}

function inferRootFunctionNavigation(functionCalls) {
  const rootCall = functionCalls.find((call) => call.target === "_level0" || call.target === "_root");
  if (!rootCall) return null;

  const body = rootFunctionBody(rootCall.functionName);
  if (!body) return null;

  const branchTargets = [];
  for (const match of body.matchAll(/(?:else\s+)?if\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\s*\}/g)) {
    const swf = match[2].match(/loadMovieNum\("([^"]+\.swf)"/)?.[1];
    if (swf) branchTargets.push({ condition: match[1].trim(), swf });
  }

  for (const target of branchTargets) {
    if (evaluateGeneratedCondition(target.condition)) {
      return {
        ...target,
        functionName: rootCall.functionName,
        sourceFunction: "A-tour:scripts/frame_1/DoAction.as",
      };
    }
  }

  const directSwf = body.match(/loadMovieNum\("([^"]+\.swf)"/)?.[1];
  return directSwf ? {
    swf: directSwf,
    functionName: rootCall.functionName,
    sourceFunction: "A-tour:scripts/frame_1/DoAction.as",
  } : null;
}

function inferRootFunctionSound(rootCall) {
  if (!rootCall || rootCall.functionName !== "initMusic") return null;

  const section = stringLiteral(rootCall.arguments ?? "");
  if (!section) return null;

  const body = rootFunctionBody(rootCall.functionName);
  if (!body) return null;

  for (const match of body.matchAll(/(?:else\s+)?if\s*\(\s*whichSection\s*==\s*"([^"]+)"\s*\)\s*\{([\s\S]*?)\n\s*\}/g)) {
    if (match[1] !== section) continue;
    const sound = match[2].match(/attachSound\("([^"]+)"\)/)?.[1];
    const resolvedSound = resolveSound(rootSoundLibrary, sound);
    const soundSrc = resolvedSound?.src;
    return sound && soundSrc ? {
      sound,
      soundSrc,
      ...(resolvedSound.name !== sound ? { resolvedSound: resolvedSound.name } : {}),
      functionName: rootCall.functionName,
      arguments: rootCall.arguments ?? "",
      sourceFunction: "A-tour:scripts/frame_1/DoAction.as",
    } : null;
  }

  return null;
}

function rootFunctionBody(functionName) {
  const sourcePath = join(root, "extracted", "A-tour", "scripts", "frame_1", "DoAction.as");
  if (!existsSync(sourcePath)) return "";

  const source = readFileSync(sourcePath, "utf8");
  const match = source.match(new RegExp(`function\\s+${escapeRegExp(functionName)}\\s*\\([^)]*\\)\\s*\\{`));
  if (!match) return "";

  const bodyStart = (match.index ?? 0) + match[0].length - 1;
  const bodyEnd = findMatchingBrace(source, bodyStart);
  return source.slice(bodyStart + 1, bodyEnd);
}

function evaluateGeneratedCondition(condition) {
  const normalized = condition.replaceAll("_level0.", "").trim();
  const equality = normalized.match(/^(.+?)\s*==\s*("[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false)$/);
  if (equality) return globalDefaults[normalizeGeneratedGlobalName(equality[1])] === parseActionScriptLiteral(equality[2]);

  const inequality = normalized.match(/^(.+?)\s*!=\s*("[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false)$/);
  if (inequality) return globalDefaults[normalizeGeneratedGlobalName(inequality[1])] !== parseActionScriptLiteral(inequality[2]);

  const value = globalDefaults[normalizeGeneratedGlobalName(normalized)];
  return Boolean(value);
}

function normalizeGeneratedGlobalName(expression) {
  return String(expression).trim().replace(/^bkgd\./, "bkgd.");
}

function inferExitNavigation(source, frameLabels) {
  if (!/exitAnim\s*\(/.test(source)) return null;

  const section = source.match(/(?:_level\d+\.)?nav\.targSection\s*=\s*"([^"]+)"/)?.[1];
  if (!section) return null;

  const sectionTargets = discoverTargetSectionNavigation();
  const target = chooseExitNavigationTarget(sectionTargets[section] ?? [], frameLabels);
  if (!target?.swf) return null;

  const exitLabel = frameLabels["navAnim_Pro_Exit"] !== undefined
    && target.frame > frameLabels["navAnim_Pro_Exit"]
      ? "navAnim_Pro_Exit"
      : frameLabels["navAnim_Personal_Exit"] !== undefined
      ? "navAnim_Personal_Exit"
      : undefined;
  const exitFrame = exitLabel ? frameLabels[exitLabel] : inferExitFrameFromExitAnim();
  if (!Number.isFinite(exitFrame) || exitFrame < 0) return null;

  return {
    variable: "nav.targSection",
    value: section,
    swf: target.swf,
    exitLabel,
    exitFrame,
  };
}

function chooseExitNavigationTarget(targets, frameLabels) {
  if (!targets.length) return null;
  const proExitFrame = frameLabels["navAnim_Pro_Exit"];
  const proTarget = Number.isFinite(proExitFrame)
    ? targets.find((target) => target.frame > proExitFrame)
    : undefined;
  return proTarget ?? targets[0];
}

function discoverTargetSectionNavigation() {
  const scriptsDir = join(extractedDir, "scripts");
  if (!existsSync(scriptsDir)) return {};

  const targets = {};
  for (const file of walkFiles(scriptsDir).filter((path) => /\/frame_\d+\/DoAction\.as$/.test(path.replaceAll("\\", "/")))) {
    const source = readFileSync(file, "utf8");
    const frame = Number(file.replaceAll("\\", "/").match(/\/frame_(\d+)\/DoAction\.as$/)?.[1] ?? 1) - 1;
    for (const branch of source.matchAll(/(?:else\s+)?if\s*\(\s*nav\.targSection\s*==\s*"([^"]+)"\s*\)\s*\{([\s\S]*?)\n\}/g)) {
      const swf = branch[2].match(/(?:_level0\.)?doRelease\("([^"]+\.swf)"\)/)?.[1]
        ?? branch[2].match(/loadMovieNum\("([^"]+\.swf)"/)?.[1];
      if (swf) {
        targets[branch[1]] ??= [];
        targets[branch[1]].push({ swf, frame });
      }
    }
  }
  return targets;
}

function inferExitFrameFromExitAnim() {
  const scriptsDir = join(extractedDir, "scripts");
  if (!existsSync(scriptsDir)) return -1;

  for (const file of walkFiles(scriptsDir).filter((path) => /\/frame_\d+\/DoAction\.as$/.test(path.replaceAll("\\", "/")))) {
    const source = readFileSync(file, "utf8");
    const functionMatch = source.match(/function\s+exitAnim\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    const frameExpression = functionMatch?.[1]?.match(/gotoAndPlay\((\d+)\)/)?.[1];
    const frame = Number.parseInt(frameExpression ?? "", 10);
    if (Number.isFinite(frame) && frame > 0) return frame - 1;
  }
  return -1;
}

function stringLiteral(expression) {
  return expression.match(/^"([^"]+)"$/)?.[1] ?? expression.match(/^'([^']+)'$/)?.[1] ?? "";
}

function resolveFrameExpression(expression, frameLabels) {
  const label = stringLiteral(expression);
  if (label && label in frameLabels) return frameLabels[label];

  const frameNumber = Number.parseInt(expression, 10);
  if (Number.isFinite(frameNumber) && frameNumber > 0) return frameNumber - 1;

  return -1;
}

function discoverFrameActions(frameLabels) {
  const scriptsDir = join(extractedDir, "scripts");
  if (!existsSync(scriptsDir)) return [];

  return walkFiles(scriptsDir)
    .filter((path) => {
      const normalized = path.replaceAll("\\", "/");
      return normalized.endsWith("/DoAction.as") && /\/frame_\d+\/DoAction\.as$/.test(normalized) && !normalized.includes("/DefineSprite_");
    })
    .map((file) => {
      const normalized = file.replaceAll("\\", "/");
      const frameMatch = normalized.match(/\/frame_(\d+)\/DoAction\.as$/);
      const frame = Number(frameMatch?.[1] ?? 1) - 1;
      const sourcePath = `scripts/${normalized.split("/scripts/").pop()}`;
      const body = readFileSync(file, "utf8");
      return {
        frame,
        source: sourcePath,
        // Frame commands (gotoAndPlay/stop/loadMovie/…) plus top-level variable
        // assignments (e.g. `nav.bln_CoreNavLoaded = 1`) the orchestration polls for.
        actions: [...summarizeActionScript(body, frameLabels, sourcePath, "root"), ...frameVariableActions(body, sourcePath)],
      };
    })
    .sort((a, b) => a.frame - b.frame);
}

/** Top-level `target = value;` assignments in a frame script, as setVariable actions. */
function frameVariableActions(body, sourcePath) {
  return parseStatements(body)
    .filter((statement) => statement.kind === "assign")
    .map((statement) => compactObject({
      command: "setVariable",
      target: statement.target,
      value: statement.value,
      rawValue: statement.rawValue,
      branchCondition: statement.branchCondition,
      executionContext: statement.branchCondition ? "branch" : "timeline",
      supported: true,
      source: sourcePath,
    }));
}

function discoverSpriteActions(frameLabels) {
  const scriptsDir = join(extractedDir, "scripts");
  if (!existsSync(scriptsDir)) return [];

  return walkFiles(scriptsDir)
    .filter((path) => {
      const normalized = path.replaceAll("\\", "/");
      return /\/DefineSprite_\d+\/frame_\d+\/DoAction\.as$/.test(normalized);
    })
    .map((file) => {
      const normalized = file.replaceAll("\\", "/");
      const match = normalized.match(/\/DefineSprite_(\d+)\/frame_(\d+)\/DoAction\.as$/);
      const spriteId = Number(match?.[1] ?? 0);
      const frame = Number(match?.[2] ?? 1) - 1;
      const sourcePath = `scripts/${normalized.split("/scripts/").pop()}`;
      const actions = summarizeActionScript(readFileSync(file, "utf8"), frameLabels, sourcePath, "sprite");
      return {
        spriteId,
        frame,
        source: sourcePath,
        actions: annotateNestedTargetPlacements(actions, spriteId, frame),
      };
    })
    .sort((a, b) => a.spriteId - b.spriteId || a.frame - b.frame);
}

function annotateNestedTargetPlacements(actions, spriteId, frame) {
  const actionableTargets = actions
    .flatMap((action) => [
      action.target,
      ...(action.functionCalls ?? []).map((call) => call.target),
    ])
    .filter((target) => target && target !== "self" && target !== "_root" && target !== "_parent");
  if (!actionableTargets.length) return actions;

  const usesByKey = new Map();
  for (let candidateFrame = frame; candidateFrame >= 0; candidateFrame -= 1) {
    const svgPath = join(extractedDir, "sprites", `DefineSprite_${spriteId}`, `${candidateFrame + 1}.svg`);
    if (!existsSync(svgPath)) continue;
    for (const [key, placement] of collectNamedUses(svgPath)) {
      if (!usesByKey.has(key)) usesByKey.set(key, placement);
    }
  }

  if (!usesByKey.size) return actions;

  return actions.map((action) => {
    const callTarget = action.functionCalls?.[0]?.target;
    const target = action.target ?? callTarget;
    if (!target || target === "self" || target === "_root" || target === "_parent") return action;
    const targetKeys = [
      normalizeName(target),
      normalizeName(String(target).split(".").pop() ?? ""),
    ].filter(Boolean);
    const placement = targetKeys.map((key) => usesByKey.get(key)).find(Boolean);
    return placement ? { ...action, targetPlacement: placement } : action;
  });
}

function collectNamedUses(svgPath) {
  const uses = new Map();
  const svg = readFileSync(svgPath, "utf8");
  for (const { attributes, matrix } of iterSpriteFrameUses(svg)) {
    const id = attributes.id;
    const characterId = Number(attributes["ffdec:characterId"] ?? attributes.characterId);
    if (!id || !Number.isFinite(characterId)) continue;

    uses.set(normalizeName(id), {
      characterId,
      matrix,
      width: number(attributes.width, 0),
      height: number(attributes.height, 0),
    });
  }
  return uses;
}

function iterSpriteFrameUses(svg) {
  const body = svg.split(/<defs\b/i)[0] ?? svg;
  const stack = [];
  const uses = [];
  for (const match of body.matchAll(/<\/g>|<g\b[^>]*>|<use\b[^>]*>/g)) {
    const tag = match[0];
    if (tag.startsWith("</g")) {
      stack.pop();
      continue;
    }

    const attributes = parseSvgAttributes(tag);
    if (tag.startsWith("<g")) {
      stack.push(matrixFromSvgTransform(attributes.transform));
      continue;
    }

    const matrix = [...stack, matrixFromSvgTransform(attributes.transform)].reduce(multiplyMatrices, identityMatrix());
    uses.push({ attributes, matrix });
  }
  return uses;
}

function parseSvgAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    attributes[match[1]] = decodeXmlEntities(match[2]);
  }
  return attributes;
}

function summarizeActionScript(source, frameLabels, sourcePath, scope) {
  const actions = [];
  const functionContexts = findFunctionContexts(source);
  const branchContexts = findBranchContexts(source);
  const tellTargets = findTellTargetContexts(source);

  for (const match of source.matchAll(/([A-Za-z0-9_.$]+)\.stop\(\);?/g)) {
    const context = actionContextAt(functionContexts, branchContexts, match.index ?? 0);
    actions.push(withActionContext({
      target: match[1],
      command: "stopSound",
      source: sourcePath,
      supported: !context,
      ...(context ? { reason: `${contextLabel(context)} sound stop is extracted for control-flow audit but not invoked by the generated runtime yet.` } : {}),
    }, context));
  }

  for (const match of source.matchAll(/(?<!\.)\bstop\(\);?/g)) {
    const context = actionContextAt(functionContexts, branchContexts, match.index ?? 0);
    const supported = !context || (context.type === "branch" && runtimeCanExecuteBranchCommand(scope, "stop"));
    actions.push(withActionContext({
      command: "stop",
      source: sourcePath,
      supported,
      ...(supported ? {} : { reason: `${contextLabel(context)} stop is extracted for control-flow audit but not invoked by the generated runtime yet.` }),
    }, context));
  }

  for (const match of source.matchAll(/\bplay\(\);?/g)) {
    const context = actionContextAt(functionContexts, branchContexts, match.index ?? 0);
    const supported = !context && scope === "sprite";
    actions.push(withActionContext({
      command: "play",
      source: sourcePath,
      supported,
      ...(supported ? {} : { reason: context ? `${contextLabel(context)} play is extracted for control-flow audit but not invoked by the generated runtime yet.` : "Root play is extracted but only explicit root timeline playback controls are compiled so far." }),
    }, context));
  }

  for (const match of source.matchAll(/([A-Za-z0-9_.$]+)\.gotoAnd(Play|Stop)\(([^)]+)\)/g)) {
    const context = actionContextAt(functionContexts, branchContexts, match.index ?? 0);
    const expression = match[3].trim();
    const frame = resolveFrameExpression(expression, frameLabels);
    const target = match[1];
    const command = `gotoAnd${match[2]}`;
    const hasRuntimeResolvableTarget = frame >= 0 || (/^_level\d+$/i.test(target) && Boolean(stringLiteral(expression)));
    const supported = (!context && (target === "_root" || target === "_parent") && frame >= 0)
      || (context?.type === "branch" && runtimeCanExecuteBranchCommand(scope, command, target, hasRuntimeResolvableTarget));
    actions.push(withActionContext({
      target,
      command,
      ...(stringLiteral(expression) ? { label: stringLiteral(expression) } : { frameExpression: expression }),
      ...(frame >= 0 ? { frame } : {}),
      source: sourcePath,
      supported,
      ...(supported ? {} : { reason: context ? `${contextLabel(context)} nested MovieClip goto is extracted for control-flow audit but not invoked by the generated runtime yet.` : "Nested MovieClip goto is extracted but not fully compiled into the web runtime yet." }),
    }, context));
  }

  for (const match of source.matchAll(/(?:^|[\s;])gotoAnd(Play|Stop)\(([^)]+)\)/g)) {
    const context = actionContextAt(functionContexts, branchContexts, match.index ?? 0);
    const expression = match[2].trim();
    const frame = resolveFrameExpression(expression, frameLabels);
    const currentFrameRelative = /^_currentframe\s*[+-]\s*\d+$/.test(expression);
    const command = `gotoAnd${match[1]}`;
    const hasResolvableTarget = frame >= 0 || currentFrameRelative;
    const supported = (!context && ((scope === "root" && hasResolvableTarget) || (scope === "sprite" && hasResolvableTarget)))
      || (context?.type === "branch" && runtimeCanExecuteBranchCommand(scope, command, "self", hasResolvableTarget));
    actions.push(withActionContext({
      target: "self",
      command,
      ...(stringLiteral(expression) ? { label: stringLiteral(expression) } : { frameExpression: expression }),
      ...(frame >= 0 ? { frame } : {}),
      source: sourcePath,
      supported,
      ...(supported ? {} : { reason: context ? `${contextLabel(context)} self goto is extracted for control-flow audit but not invoked by the generated runtime yet.` : `${scope === "root" ? "Computed root" : "Clip-local"} goto is extracted but not fully compiled into the web runtime yet.` }),
    }, context));
  }

  for (const match of source.matchAll(/(?:_level0\.)?doRelease\("([^"]+\.swf)"\)/g)) {
    const context = actionContextAt(functionContexts, branchContexts, match.index ?? 0);
    const supported = !context || (context.type === "branch" && runtimeCanExecuteBranchCommand(scope, "doRelease"));
    actions.push(withActionContext({
      command: "doRelease",
      swf: match[1],
      source: sourcePath,
      supported,
      ...(supported ? {} : { reason: `${contextLabel(context)} SWF navigation is extracted for control-flow audit but not invoked by the generated runtime yet.` }),
    }, context));
  }

  for (const match of source.matchAll(/loadMovieNum\("([^"]+\.swf)"(?:,\s*([^,)]+))?/g)) {
    const context = actionContextAt(functionContexts, branchContexts, match.index ?? 0);
    const supported = !context || (context.type === "branch" && runtimeCanExecuteBranchCommand(scope, "loadMovieNum"));
    actions.push(withActionContext({
      command: "loadMovieNum",
      swf: match[1],
      level: match[2]?.trim(),
      source: sourcePath,
      supported,
      ...(supported ? {} : { reason: `${contextLabel(context)} SWF load is extracted for control-flow audit but not invoked by the generated runtime yet.` }),
    }, context));
  }

  for (const match of source.matchAll(/(_level0|_root)\.([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?/g)) {
    const context = actionContextAt(functionContexts, branchContexts, match.index ?? 0);
    const callTarget = match[1];
    const functionName = match[2];
    const rootFunctionCall = {
      target: callTarget,
      functionName,
      arguments: match[3].trim(),
    };
    const rootFunctionNavigation = inferRootFunctionNavigation([{
      ...rootFunctionCall,
    }]);
    if (rootFunctionNavigation?.swf) {
      const supported = !context || (context.type === "branch" && runtimeCanExecuteBranchCommand(scope, "loadMovieNum"));
      actions.push(withActionContext({
        command: "loadMovieNum",
        swf: rootFunctionNavigation.swf,
        rootFunctionNavigation,
        source: sourcePath,
        supported,
        ...(supported ? {} : { reason: `${contextLabel(context)} root function SWF load is extracted for control-flow audit but not invoked by the generated runtime yet.` }),
      }, context));
      continue;
    }

    const rootFunctionSound = inferRootFunctionSound(rootFunctionCall);
    if (rootFunctionSound?.soundSrc) {
      const supported = !context;
      actions.push(withActionContext({
        command: "attachSound",
        sound: rootFunctionSound.sound,
        soundSrc: rootFunctionSound.soundSrc,
        soundRole: "music",
        rootFunctionSound,
        source: sourcePath,
        supported,
        ...(supported ? {} : { reason: `${contextLabel(context)} root function sound is extracted for control-flow audit but not invoked by the generated runtime yet.` }),
      }, context));
      continue;
    }

    // A generic cross-level function call (e.g. the intro's `_level0.LoadIntroNav()`
    // / `_level0.LoadInitialInteractive()`). Emit it as callFunctions so the runtime
    // dispatches it to the target level's player. Known timeline commands are matched
    // by their own regexes above, so skip them here.
    if (functionName.startsWith("gotoAnd")) continue;
    if (["stop", "play", "loadMovie", "loadMovieNum", "loadVariables", "unloadMovie", "unloadMovieNum",
         "attachSound", "doRelease", "playVO", "markSndSegment", "stopSound", "setVolume", "getVolume"].includes(functionName)) continue;
    actions.push(withActionContext({
      command: "callFunctions",
      functionCalls: [rootFunctionCall],
      source: sourcePath,
      supported: !context || context.type === "branch",
    }, context));
  }

  for (const { call, context } of discoverFunctionCallActions(source, functionContexts, branchContexts, tellTargets)) {
    const supported = !context || context.type === "branch";
    actions.push(withActionContext({
      command: "callFunctions",
      functionCalls: [call],
      source: sourcePath,
      supported,
      ...(supported ? {} : { reason: `${contextLabel(context)} function call is extracted for control-flow audit but not invoked by the generated runtime yet.` }),
    }, context));
  }

  for (const match of source.matchAll(/loadVariables\("([^"]+)"/g)) {
    const context = actionContextAt(functionContexts, branchContexts, match.index ?? 0);
    const variableSource = resolveVariableSource(match[1]);
    const supported = !context && Boolean(variableSource);
    actions.push(withActionContext({
      command: "loadVariables",
      target: match[1],
      ...(variableSource ? { variableSource: variableSource.publicPath } : {}),
      ...(variableSource?.compatibility ? { compatibility: variableSource.compatibility } : {}),
      source: sourcePath,
      supported,
      ...(supported ? {} : { reason: variableSource ? `${contextLabel(context)} variable load is extracted for control-flow audit but not invoked by the generated runtime yet.` : "External variable source was referenced by ActionScript but no matching exported text file was found." }),
    }, context));
  }

  for (const match of source.matchAll(/(?:_parent\.|_parent\._parent\.|_level0\.)?playVO\("([^"]+)"(?:\s*,\s*([^,)]+))?(?:\s*,\s*"([^"]+)")?/g)) {
    const context = actionContextAt(functionContexts, branchContexts, match.index ?? 0);
    const resolvedSound = resolveSound(soundLibrary, match[1]);
    actions.push(withActionContext({
      command: "playVO",
      sound: match[1],
      ...(match[2] !== undefined ? { ramp: match[2].trim() } : {}),
      ...(match[3] ? { segment: match[3] } : {}),
      ...(resolvedSound ? { soundSrc: resolvedSound.src } : {}),
      ...(resolvedSound && resolvedSound.name !== match[1] ? { resolvedSound: resolvedSound.name } : {}),
      source: sourcePath,
      supported: Boolean(resolvedSound),
      ...(resolvedSound ? {} : { reason: "Voiceover sound was referenced by ActionScript but no matching FFDec sound export was found." }),
    }, context));
  }

  for (const match of source.matchAll(/(?:_level0\.)?markSndSegment\("([^"]+)"\)/g)) {
    const context = actionContextAt(functionContexts, branchContexts, match.index ?? 0);
    actions.push(withActionContext({
      command: "markSndSegment",
      sound: match[1],
      source: sourcePath,
      supported: !context,
    }, context));
  }

  for (const match of source.matchAll(/\.attachSound\("([^"]+)"\)/g)) {
    const context = actionContextAt(functionContexts, branchContexts, match.index ?? 0);
    const resolvedSound = resolveSound(soundLibrary, match[1]);
    actions.push(withActionContext({
      command: "attachSound",
      sound: match[1],
      ...(resolvedSound ? { soundSrc: resolvedSound.src } : {}),
      ...(resolvedSound && resolvedSound.name !== match[1] ? { resolvedSound: resolvedSound.name } : {}),
      source: sourcePath,
      supported: !context && Boolean(resolvedSound),
      ...(resolvedSound ? {} : { reason: "Attached sound was referenced by ActionScript but no matching FFDec sound export was found." }),
      ...(context ? { reason: `${contextLabel(context)} attached sound is extracted for control-flow audit but not invoked by the generated runtime yet.` } : {}),
    }, context));
  }

  return actions;
}

function runtimeCanExecuteBranchCommand(scope, command, target = "", hasResolvableTarget = true) {
  if (!hasResolvableTarget) return false;
  if (command === "stop") return scope === "root" || scope === "sprite";
  if (command === "doRelease" || command === "loadMovieNum") return scope === "root" || scope === "sprite";
  if (command !== "gotoAndPlay" && command !== "gotoAndStop") return false;
  if (target === "self") return scope === "root" || scope === "sprite";
  if (target === "_root" || target === "_parent") return scope === "sprite";
  if (scope === "root" && /^_level\d+$/i.test(target)) return true;
  return false;
}

function withActionContext(action, context) {
  if (!context) return { ...action, executionContext: "timeline" };
  if (context.type === "function") {
    return {
      ...action,
      functionName: context.name,
      ...(context.branchCondition ? { functionBranchCondition: context.branchCondition } : {}),
      executionContext: "function",
    };
  }
  return { ...action, branchCondition: context.condition, executionContext: "branch" };
}

function contextLabel(context) {
  return context.type === "function" ? "Function-scoped" : "Branch-scoped";
}

function findFunctionContexts(source) {
  const contexts = [];
  for (const match of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
    const bodyStart = (match.index ?? 0) + match[0].length - 1;
    const bodyEnd = findMatchingBrace(source, bodyStart);
    contexts.push({ type: "function", name: match[1], start: match.index ?? 0, bodyStart, end: bodyEnd });
  }
  return contexts;
}

function findBranchContexts(source) {
  const contexts = [];
  const re = /(?:else\s+if|if)\s*\(|else\s*\{/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    let condition;
    let bodyStart;
    if (match[0].endsWith("{")) {
      condition = "else";
      bodyStart = match.index + match[0].length - 1;
    } else {
      // Balance-match the condition's parens so nested calls survive, e.g.
      // `if(!timeMarkDone(AttractLoopWaitTime))` (the attract-loop hold guard).
      const parenOpen = match.index + match[0].length - 1;
      const parenClose = matchParenFrom(source, parenOpen);
      condition = source.slice(parenOpen + 1, parenClose).trim() || "else";
      bodyStart = source.indexOf("{", parenClose);
      if (bodyStart < 0) continue;
      re.lastIndex = bodyStart;
    }
    contexts.push({ type: "branch", condition, start: match.index, bodyStart, end: findMatchingBrace(source, bodyStart) });
  }
  return contexts;
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length - 1;
}

function matchParenFrom(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") { depth -= 1; if (depth === 0) return i; }
  }
  return source.length;
}

function skipNoiseFrom(source, i) {
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source.startsWith("//", i)) { const nl = source.indexOf("\n", i); i = nl < 0 ? source.length : nl + 1; continue; }
    if (source.startsWith("/*", i)) { const e = source.indexOf("*/", i); i = e < 0 ? source.length : e + 2; continue; }
    break;
  }
  return i;
}

function findStatementEnd(source, i) {
  let depth = 0;
  let quote = "";
  for (; i < source.length; i += 1) {
    const c = source[i];
    if (quote) { if (c === quote && source[i - 1] !== "\\") quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (c === ";" && depth === 0) return i;
  }
  return source.length;
}

/**
 * Parse an ActionScript function/frame body into an ordered list of statements,
 * each tagged with the combined if/else branch condition under which it runs. The
 * tour's orchestration functions (e.g. `showSceneMenu`) are if/else chains that
 * call `_level6.<button>.gotoAndPlay("over")` for the active section — without the
 * conditions the runtime can't pick the right branch. `else` arms become the
 * negation of their prior siblings, so each statement carries a self-contained,
 * `evalCondition`-ready guard. Statement kinds: `assign` (target/rawValue) and
 * `call` (target/functionName/arguments). Nested function defs are skipped.
 */
function parseStatements(src) {
  const out = [];
  parseBlock(src, []);
  return out;

  function parseBlock(code, condStack) {
    let i = 0;
    while (i < code.length) {
      i = skipNoiseFrom(code, i);
      if (i >= code.length) break;
      const rest = code.slice(i);
      if (/^if\s*\(/.test(rest)) { i = parseIf(code, i, condStack); continue; }
      const fn = /^function\b[^{]*\{/.exec(rest);
      if (fn) { i = findMatchingBrace(code, i + fn[0].length - 1) + 1; continue; }
      if (code[i] === "{") { const e = findMatchingBrace(code, i); parseBlock(code.slice(i + 1, e), condStack); i = e + 1; continue; }
      const semi = findStatementEnd(code, i);
      emitStatement(code.slice(i, semi).trim(), condStack);
      i = semi + 1;
    }
  }

  function parseIf(code, start, condStack) {
    let i = start;
    const priors = [];
    for (;;) {
      const m = /^if\s*\(/.exec(code.slice(i));
      if (!m) break;
      const condOpen = i + m[0].length - 1;
      const condClose = matchParenFrom(code, condOpen);
      const cond = code.slice(condOpen + 1, condClose).trim();
      const [block, after] = readBlock(code, condClose + 1);
      parseBlock(block, [...condStack, [...priors.map((c) => `!(${c})`), `(${cond})`].join(" && ")]);
      priors.push(cond);
      i = skipNoiseFrom(code, after);
      if (/^else\s+if\b/.test(code.slice(i))) { i += /^else\s+/.exec(code.slice(i))[0].length; continue; }
      if (/^else\b/.test(code.slice(i))) {
        i += /^else\s*/.exec(code.slice(i))[0].length;
        const [eblock, eafter] = readBlock(code, i);
        parseBlock(eblock, [...condStack, priors.map((c) => `!(${c})`).join(" && ") || "true"]);
        i = eafter;
      }
      break;
    }
    return i;
  }

  function readBlock(code, from) {
    const j = skipNoiseFrom(code, from);
    if (code[j] === "{") { const e = findMatchingBrace(code, j); return [code.slice(j + 1, e), e + 1]; }
    const semi = findStatementEnd(code, j);
    return [code.slice(j, semi), semi + 1];
  }

  function emitStatement(stmt, condStack) {
    if (!stmt) return;
    const branchCondition = condStack.length ? condStack.map((c) => `(${c})`).join(" && ") : undefined;
    const call = /^([A-Za-z_$][\w$.]*)\s*\(([\s\S]*)\)$/.exec(stmt);
    if (call) {
      const path = call[1];
      const dot = path.lastIndexOf(".");
      const target = dot > 0 ? path.slice(0, dot) : undefined;
      const functionName = dot > 0 ? path.slice(dot + 1) : path;
      if (functionName === "trace" || functionName === "var") return;
      // Self timeline commands (gotoAndPlay(60), stop()) are handled by frameActions.
      if (!target && SELF_TIMELINE_COMMANDS.has(functionName)) return;
      out.push(compactObject({ kind: "call", target, functionName, arguments: call[2].trim() || undefined, branchCondition }));
      return;
    }
    const asg = /^(?:var\s+)?([A-Za-z_$][\w$.]*)\s*=\s*([\s\S]+)$/.exec(stmt);
    if (asg && !/^[=<>!]/.test(asg[2])) {
      out.push(compactObject({ kind: "assign", target: asg[1], value: parseActionScriptLiteral(asg[2]), rawValue: asg[2].trim(), branchCondition }));
    }
  }
}

function contextAt(contexts, index) {
  return contexts.find((context) => index > context.bodyStart && index < context.end);
}

function actionContextAt(functionContexts, branchContexts, index) {
  const functionContext = contextAt(functionContexts, index);
  const branchContext = contextAt(branchContexts, index);
  if (functionContext) {
    return {
      ...functionContext,
      ...(branchContext ? { branchCondition: branchContext.condition } : {}),
    };
  }
  return branchContext;
}

function discoverSpriteStopFrames() {
  const scriptsDir = join(extractedDir, "scripts");
  if (!existsSync(scriptsDir)) return {};

  const stops = {};
  for (const file of walkFiles(scriptsDir).filter((path) => path.endsWith("DoAction.as") && path.includes("DefineSprite_"))) {
    const normalized = file.replaceAll("\\", "/");
    const match = normalized.match(/DefineSprite_(\d+)\/frame_(\d+)\/DoAction\.as$/);
    if (!match) continue;

    const source = readFileSync(file, "utf8").trim();
    if (!/^stop\(\);?\s*$/m.test(source)) continue;

    const spriteId = match[1];
    stops[spriteId] ??= [];
    stops[spriteId].push(Number(match[2]) - 1);
  }

  for (const stopList of Object.values(stops)) stopList.sort((a, b) => a - b);
  return stops;
}

function discoverSpriteLocalDefaults() {
  const scriptsDir = join(extractedDir, "scripts");
  if (!existsSync(scriptsDir)) return {};

  const defaults = {};
  const files = walkFiles(scriptsDir)
    .filter((path) => /\/DefineSprite_\d+\/frame_\d+\/DoAction\.as$/.test(path.replaceAll("\\", "/")))
    .sort((left, right) => {
      const leftMatch = left.replaceAll("\\", "/").match(/\/DefineSprite_(\d+)\/frame_(\d+)\/DoAction\.as$/);
      const rightMatch = right.replaceAll("\\", "/").match(/\/DefineSprite_(\d+)\/frame_(\d+)\/DoAction\.as$/);
      return Number(leftMatch?.[1] ?? 0) - Number(rightMatch?.[1] ?? 0)
        || Number(leftMatch?.[2] ?? 0) - Number(rightMatch?.[2] ?? 0);
    });

  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    const match = normalized.match(/\/DefineSprite_(\d+)\/frame_(\d+)\/DoAction\.as$/);
    const spriteId = match?.[1];
    if (!spriteId) continue;

    const source = readFileSync(file, "utf8");
    const functionContexts = findFunctionContexts(source);
    const branchContexts = findBranchContexts(source);
    defaults[spriteId] ??= {};

    for (const assignment of source.matchAll(/(^|[^\w.$])([A-Za-z_$][\w$]*)\s*=\s*("[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false)\s*;/gm)) {
      const index = (assignment.index ?? 0) + assignment[1].length;
      if (actionContextAt(functionContexts, branchContexts, index)) continue;

      const name = assignment[2];
      if (defaults[spriteId][name] !== undefined) continue;
      defaults[spriteId][name] = parseActionScriptLiteral(assignment[3]);
    }
  }

  return Object.fromEntries(Object.entries(defaults).filter(([, values]) => Object.keys(values).length));
}

function actionBytesStartWith(actionBytes, opcodeHex) {
  return typeof actionBytes === "string" && actionBytes.toLowerCase().startsWith(opcodeHex.toLowerCase());
}

function matrixFromTag(matrix) {
  const hasScale = matrix.hasScale === "true";
  const hasRotate = matrix.hasRotate === "true";
  // SWF MATRIX → SVG/CSS matrix(a,b,c,d,e,f):
  //   x' = ScaleX*x + RotateSkew1*y + tx   → a=ScaleX, c=RotateSkew1
  //   y' = RotateSkew0*x + ScaleY*y  + ty   → b=RotateSkew0, d=ScaleY
  return {
    a: hasScale ? number(matrix.scaleX, 1) : 1,
    b: hasRotate ? number(matrix.rotateSkew0, 0) : 0,
    c: hasRotate ? number(matrix.rotateSkew1, 0) : 0,
    d: hasScale ? number(matrix.scaleY, 1) : 1,
    tx: number(matrix.translateX, 0) / 20,
    ty: number(matrix.translateY, 0) / 20,
  };
}

function matrixFromSvgTransform(transform) {
  const values = String(transform ?? "")
    .match(/matrix\(([^)]+)\)/)?.[1]
    ?.split(/[,\s]+/)
    .filter(Boolean)
    .map((value) => Number.parseFloat(value));
  if (!values || values.length < 6 || values.some((value) => !Number.isFinite(value))) return identityMatrix();
  const [a, b, c, d, tx, ty] = values;
  return { a, b, c, d, tx, ty };
}

function multiplyMatrices(left, right) {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    tx: left.a * right.tx + left.c * right.ty + left.tx,
    ty: left.b * right.tx + left.d * right.ty + left.ty,
  };
}

function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
}

/**
 * Find a button's embedded dynamic editText in its up-state SVG and return its
 * button-record placement matrix. FFDec nests the field as
 * `<g transform="<bounds-shift>"><use ffdec:characterId="N" transform="<placement>"/></g>`,
 * where the outer g is exactly the bounds/origin shift — so the inner `<use>` transform
 * IS the field's placement relative to the button registration (what the runtime composes
 * with the button's instance matrix to reproduce the standalone field position).
 */
function buttonDynamicTextField(svgPath, isDynamic) {
  let svg;
  try {
    svg = readFileSync(svgPath, "utf8");
  } catch {
    return undefined;
  }
  for (const tag of svg.match(/<use\b[^>]*>/g) ?? []) {
    const cid = tag.match(/ffdec:characterId="(\d+)"/);
    if (!cid || !isDynamic(Number(cid[1]))) continue;
    const transform = tag.match(/transform="([^"]*)"/)?.[1];
    return { id: Number(cid[1]), matrix: matrixFromSvgTransform(transform) };
  }
  return undefined;
}

/**
 * Strip baked dynamic-text `<use>`s from sprite frame SVGs. FFDec bakes a loadVariables()
 * editText's INITIAL content into the composited frame at the field registration (ignoring
 * the bounds offset), so it renders mispositioned/clipped (e.g. nav "Skip Intro"). The runtime
 * overlays the live value at the correct position, so drop the baked copy. Only variable-bound
 * fields are stripped — static editText (incl. masked title strips like the nav section
 * headings) stay baked, since FFDec composites their masks correctly and the runtime can't
 * mask-clip a DOM overlay.
 */
function stripBakedDynamicText(assetDefs) {
  const ids = new Set(
    Object.values(assetDefs)
      .filter((a) => a?.kind === "text" && a?.text)
      .map((a) => a.id),
  );
  const spritesDir = join(publicDir, "sprites");
  if (!ids.size || !existsSync(spritesDir)) return;
  for (const dir of readdirSync(spritesDir)) {
    let entries;
    try {
      entries = readdirSync(join(spritesDir, dir));
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".svg")) continue;
      const path = join(spritesDir, dir, file);
      const svg = readFileSync(path, "utf8");
      const stripped = svg.replace(/<use\b[^>]*\/>/g, (m) => {
        const cid = m.match(/ffdec:characterId="(\d+)"/);
        return cid && ids.has(Number(cid[1])) ? "" : m;
      });
      if (stripped !== svg) writeFileSync(path, stripped);
    }
  }
}

function opacityFromTag(transform) {
  const mult = number(transform.alphaMultTerm, 256) / 256;
  const add = number(transform.alphaAddTerm, 0) / 255;
  return Math.max(0, Math.min(1, mult + add));
}

/**
 * Extract the RGB part of a CXFORMWITHALPHA as normalized mult (term/256) + add
 * (term/255) per channel. Alpha is handled separately via `opacity`, so this
 * returns only the colour tint (e.g. the tour-shell swoosh's #6699cc stroke is
 * lightened toward white). Returns undefined when the RGB transform is identity.
 */
function colorTransformFromTag(transform) {
  if (!transform) return undefined;
  const rm = number(transform.redMultTerm, 256) / 256;
  const gm = number(transform.greenMultTerm, 256) / 256;
  const bm = number(transform.blueMultTerm, 256) / 256;
  const ra = number(transform.redAddTerm, 0) / 255;
  const ga = number(transform.greenAddTerm, 0) / 255;
  const ba = number(transform.blueAddTerm, 0) / 255;
  if (rm === 1 && gm === 1 && bm === 1 && ra === 0 && ga === 0 && ba === 0) return undefined;
  const round = (n) => Math.round(n * 1000) / 1000;
  return { rm: round(rm), gm: round(gm), bm: round(bm), ra: round(ra), ga: round(ga), ba: round(ba) };
}

function colorFromTag(color) {
  if (!color) return "#ffffff";
  const red = Math.max(0, Math.min(255, Math.round(number(color.red, 255))));
  const green = Math.max(0, Math.min(255, Math.round(number(color.green, 255))));
  const blue = Math.max(0, Math.min(255, Math.round(number(color.blue, 255))));
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

function loadSceneVariables(sceneName) {
  const variablesPath = findSceneVariablesPath(sceneName);
  if (!variablesPath) return {};

  const source = readFileSync(variablesPath, "utf8").replace(/\r\n/g, "\n");
  const variables = {};
  for (const chunk of source.split("&")) {
    const separator = chunk.indexOf("=");
    if (separator <= 0) continue;

    const key = chunk.slice(0, separator).trim();
    const value = chunk.slice(separator + 1).trim();
    if (!key) continue;
    variables[normalizeVariableName(key)] = normalizeLoadedText(value);
  }

  return variables;
}

function findSceneVariablesPath(sceneName) {
  const publicRoot = join(root, "public");
  const exact = join(publicRoot, `${sceneName}.txt`);
  if (existsSync(exact)) return exact;

  const lowerName = `${sceneName.toLowerCase()}.txt`;
  return readdirSync(publicRoot)
    .filter((file) => file.toLowerCase() === lowerName)
    .map((file) => join(publicRoot, file))
    .find((path) => existsSync(path));
}

function resolveVariableSource(fileName) {
  const publicRoot = join(root, "public");
  const lowerName = String(fileName).toLowerCase();
  const exactFile = readdirSync(publicRoot).find((file) => file.toLowerCase() === lowerName);
  if (exactFile) return { publicPath: exactFile };

  const locMatch = lowerName.match(/^(.+)_loc\.fla$/);
  if (locMatch?.[1] === scene.toLowerCase()) {
    const sceneVariablesPath = findSceneVariablesPath(scene);
    if (sceneVariablesPath && Object.keys(loadedVariables).length) {
      return {
        publicPath: basename(sceneVariablesPath),
        compatibility: "Resolved missing *_loc.fla variable load to the exported scene .txt variable file.",
      };
    }
  }

  return null;
}

function normalizeVariableName(name) {
  return String(name).replace(/^_root\./, "").split(".").pop();
}

function normalizeName(name) {
  return String(name).replace(/^_root\./, "").replace(/^_parent\./, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function normalizeLoadedText(value) {
  const decoded = safeDecodeURIComponent(value.replace(/\+/g, "%20"));
  return decodeXmlEntities(decoded)
    .replace(/\\r\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function comparableText(value) {
  return normalizeLoadedText(value).replace(/\s+/g, " ").trim();
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeXmlEntities(value) {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", "\"")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function textAlignFromTag(value) {
  if (String(value) === "1") return "right";
  if (String(value) === "2") return "center";
  if (String(value) === "3") return "justify";
  return "left";
}

/**
 * Alignment for an edit-text field. For HTML fields the field's `align` attribute
 * is just the placeholder format; the rendered HTML governs and defaults to LEFT
 * (matching Flash/Ruffle) unless the content carries a <P ALIGN="…">. Non-HTML
 * fields use the field's align attribute directly.
 */
function htmlTextAlign(tag, content) {
  if (tag.html !== "true") return textAlignFromTag(tag.align);
  const match = String(content ?? "").match(/ALIGN\s*=\s*["']?(LEFT|RIGHT|CENTER|JUSTIFY)/i);
  return match ? match[1].toLowerCase() : "left";
}

function hex(value) {
  return value.toString(16).padStart(2, "0");
}

function svgOrigin(path) {
  if (!path || !existsSync(path)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const sample = readFileSync(path, "utf8").slice(0, 1200);
  const width = Number.parseFloat(sample.match(/\bwidth="([\d.]+)px"/)?.[1] ?? "0");
  const height = Number.parseFloat(sample.match(/\bheight="([\d.]+)px"/)?.[1] ?? "0");
  const transform = sample.match(/<g[^>]+transform="matrix\(([^)]+)\)"/)?.[1];
  const parts = transform ? transform.split(",").map((part) => Number.parseFloat(part.trim())) : [];
  return {
    x: Number.isFinite(parts[4]) ? parts[4] : 0,
    y: Number.isFinite(parts[5]) ? parts[5] : 0,
    width,
    height,
  };
}

function findSpriteDir(id) {
  return listDir("sprites").find((name) => name === `DefineSprite_${id}` || name.startsWith(`DefineSprite_${id}_`));
}

function listDir(name) {
  const dir = join(extractedDir, name);
  return existsSync(dir) ? readdirSync(dir) : [];
}

function relativeExtractedPath(filePath) {
  return filePath.slice(extractedDir.length + 1).replaceAll("\\", "/");
}

function copyIfExists(name) {
  const src = join(extractedDir, name);
  if (existsSync(src)) {
    cpSync(src, join(publicDir, name), { recursive: true });
  }
}

function preserveGeneratedReports() {
  if (!existsSync(secondaryDir) && !existsSync(parserReportPath)) return "";
  const tempDir = mkdtempSync(join(root, ".tmp-secondary-"));
  if (existsSync(secondaryDir)) renameSync(secondaryDir, join(tempDir, "secondary"));
  if (existsSync(parserReportPath)) renameSync(parserReportPath, join(tempDir, "swf-parser-report.json"));
  return tempDir;
}

function restoreGeneratedReports(tempDir) {
  if (!tempDir) return;
  const backupDir = join(tempDir, "secondary");
  if (existsSync(backupDir)) renameSync(backupDir, secondaryDir);
  const backupParserReport = join(tempDir, "swf-parser-report.json");
  if (existsSync(backupParserReport)) renameSync(backupParserReport, parserReportPath);
  rmSync(tempDir, { recursive: true, force: true });
}

function normalizeFrameSvgs(rootFrames, assetDefs) {
  const framesDir = join(publicDir, "frames");
  if (!existsSync(framesDir)) return;

  for (const file of listPublicDir("frames").filter((name) => name.endsWith(".svg"))) {
    const path = join(framesDir, file);
    const frameIndex = Math.max(0, Number.parseInt(file, 10) - 1);
    const frame = rootFrames[frameIndex];
    let svg = readFileSync(path, "utf8");
    const ids = new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
    let changed = false;

    svg = svg.replace(/<use\b[^>]*(?:xlink:href|href)="#([^"]+)"[^>]*>/g, (tag, hrefId) => {
      if (ids.has(hrefId)) return tag;

      const characterId = tag.match(/\bffdec:characterId="(\d+)"/)?.[1];
      const width = Number.parseFloat(tag.match(/\bwidth="([^"]+)"/)?.[1] ?? "0");
      const height = Number.parseFloat(tag.match(/\bheight="([^"]+)"/)?.[1] ?? "0");

      changed = true;
      if (!characterId || width <= 0 || height <= 0) return "";

      return replacementForMissingUse(tag, hrefId, characterId, frame, assetDefs);
    });

    if (changed) writeFileSync(path, svg);
  }
}

function normalizeSvgTextLayouts() {
  const svgFiles = walkFiles(publicDir).filter((path) => path.endsWith(".svg"));

  for (const path of svgFiles) {
    let svg = readFileSync(path, "utf8");
    let changed = false;

    const textReferences = [...svg.matchAll(/<use\b[^>]*ffdec:characterId="(\d+)"[^>]*(?:xlink:href|href)="#([^"]+)"[^>]*>/g)];
    for (const [, characterId, textId] of textReferences) {
      if (!textId.startsWith("text")) continue;
      const sourceText = readExtractedText(characterId);
      const expectedLines = sourceText ? sourceText.split(/\r\n|\r|\n/).filter((line) => line.length > 0).length : 0;
      if (expectedLines <= 0) continue;

      const nextSvg = reflowSvgTextGroup(svg, textId, expectedLines);
      if (nextSvg !== svg) {
        svg = nextSvg;
        changed = true;
      }
    }

    if (changed) writeFileSync(path, svg);
  }
}

function readExtractedText(characterId) {
  const path = join(publicDir, "texts", `${characterId}.txt`);
  return existsSync(path) ? readFileSync(path, "utf8").trimEnd() : "";
}

function reflowSvgTextGroup(svg, textId, expectedLines) {
  const groupPattern = new RegExp(`(<g id="${escapeRegExp(textId)}">\\s*<g[^>]*>)([\\s\\S]*?)(\\s*</g>\\s*</g>)`);
  const match = svg.match(groupPattern);
  if (!match) return svg;

  const body = match[2];
  const glyphs = [...body.matchAll(/<use\b[^>]*\btransform="matrix\(([^"]+)\)"[^>]*>/g)].map((glyphMatch) => {
    const matrix = glyphMatch[1].split(/[\s,]+/).filter(Boolean).map((value) => Number.parseFloat(value));
    return { tag: glyphMatch[0], x: matrix[4], y: matrix[5] };
  });
  const rows = groupGlyphRows(glyphs);
  if (rows.length <= expectedLines || expectedLines <= 0) return svg;

  const extraRows = rows.length - expectedLines;
  const targetY = rows.slice(0, expectedLines).map((row) => row.y);
  const rowMoves = new Map();
  let firstRowMaxX = rows[0].glyphs.reduce((max, glyph) => Math.max(max, glyph.x), 0);

  rows.forEach((row, rowIndex) => {
    if (rowIndex <= extraRows) {
      rowMoves.set(row.y, {
        y: targetY[0],
        xOffset: rowIndex === 0 ? 0 : firstRowMaxX - row.glyphs[0].x + 7,
      });
      if (rowIndex > 0) {
        firstRowMaxX = Math.max(firstRowMaxX, row.glyphs.reduce((max, glyph) => Math.max(max, glyph.x + firstRowMaxX + 7), 0));
      }
      return;
    }

    rowMoves.set(row.y, { y: targetY[rowIndex - extraRows], xOffset: 0 });
  });

  const nextBody = body.replace(/<use\b[^>]*\btransform="matrix\(([^"]+)\)"[^>]*>/g, (glyphTag, matrixText) => {
    const matrix = matrixText.split(/[\s,]+/).filter(Boolean).map((value) => Number.parseFloat(value));
    const move = rowMoves.get(matrix[5]);
    if (!move) return glyphTag;
    matrix[4] = roundSvgNumber(matrix[4] + move.xOffset);
    matrix[5] = roundSvgNumber(move.y);
    return glyphTag.replace(matrixText, matrix.join(", "));
  });

  return svg.replace(match[0], `${match[1]}${nextBody}${match[3]}`);
}

function groupGlyphRows(glyphs) {
  const rows = [];
  for (const glyph of glyphs) {
    let row = rows.find((item) => Math.abs(item.y - glyph.y) < 0.05);
    if (!row) {
      row = { y: glyph.y, glyphs: [] };
      rows.push(row);
    }
    row.glyphs.push(glyph);
  }

  return rows.sort((a, b) => a.y - b.y).map((row) => ({
    ...row,
    glyphs: row.glyphs.sort((a, b) => a.x - b.x),
  }));
}

function roundSvgNumber(value) {
  return Math.round(value * 100) / 100;
}

function replaceStaticVariableText(allTags) {
  const replacements = discoverStaticVariableTextReplacements(allTags);
  if (!Object.keys(replacements).length) return;

  for (const path of walkFiles(publicDir).filter((file) => file.endsWith(".svg"))) {
    let svg = readFileSync(path, "utf8");
    let changed = false;

    svg = svg.replace(/<use\b[^>]*ffdec:characterId="(\d+)"[^>]*>/g, (tag, characterId) => {
      const replacement = replacements[characterId];
      if (!replacement) return tag;

      const transform = tag.match(/\btransform="([^"]+)"/)?.[1] ?? "";
      const width = Number.parseFloat(tag.match(/\bwidth="([^"]+)"/)?.[1] ?? "0");
      const height = Number.parseFloat(tag.match(/\bheight="([^"]+)"/)?.[1] ?? "0");
      if (width <= 0 || height <= 0) return tag;

      changed = true;
      return svgTextReplacement(characterId, replacement, transform, width, height);
    });

    if (changed) writeFileSync(path, svg);
  }
}

function discoverStaticVariableTextReplacements(allTags) {
  const replacements = {};

  for (const tag of allTags) {
    if (!tag?.characterID || !tag.variableName) continue;

    const variableName = normalizeVariableName(tag.variableName);
    const loadedText = loadedVariables[variableName];
    const initialText = normalizeLoadedText(String(tag.initialText ?? ""));
    if (!loadedText || !initialText.includes("\n")) continue;
    if (comparableText(initialText) !== comparableText(loadedText)) continue;
    if (number(tag.fontHeight, 0) / 20 > 16) continue;

    replacements[String(tag.characterID)] = {
      text: initialText,
      fontHeight: number(tag.fontHeight, 0) / 20,
      leading: number(tag.leading, 0) / 20,
      color: colorFromTag(tag.textColor),
      align: textAlignFromTag(tag.align),
    };
  }

  return replacements;
}

function svgTextReplacement(characterId, replacement, transform, width, height) {
  const lines = replacement.text.split("\n").filter(Boolean);
  const fontSize = Math.max(1, replacement.fontHeight || 12);
  const lineHeight = Math.max(fontSize, fontSize + (replacement.leading || 0));
  const anchor = replacement.align === "center" ? "middle" : replacement.align === "right" ? "end" : "start";
  const x = replacement.align === "center" ? width / 2 : replacement.align === "right" ? width : 0;
  const transformAttribute = transform ? ` transform="${escapeXmlAttribute(transform)}"` : "";
  const tspans = lines
    .map((line, index) => `<tspan x="${roundSvgNumber(x)}" y="${roundSvgNumber(fontSize + index * lineHeight)}">${escapeXmlText(line)}</tspan>`)
    .join("");

  return `<text ffdec:characterId="${characterId}"${transformAttribute} fill="${replacement.color}" font-family="Franklin Gothic Medium, Franklin Gothic, FranklinGothic, XP Franklin Gothic, Arial Narrow, Arial, sans-serif" font-size="${roundSvgNumber(fontSize)}" font-weight="700" text-anchor="${anchor}">${tspans}</text>`;
}

function escapeXmlAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

function escapeXmlText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function replacementForMissingUse(tag, hrefId, characterId, frame, assetDefs) {
  const asset = assetDefs[characterId];
  if (!asset) return "";

  const transform = tag.match(/\btransform="([^"]+)"/)?.[1] ?? "";
  const transformAttribute = transform ? ` transform="${transform}"` : "";
  const width = tag.match(/\bwidth="([^"]+)"/)?.[1] ?? "0";
  const height = tag.match(/\bheight="([^"]+)"/)?.[1] ?? "0";

  if (asset.kind === "shape") {
    return inlineSvgAsset(join(publicDir, "shapes", `${characterId}.svg`), `${hrefId}_${characterId}`, transformAttribute);
  }

  if (asset.kind === "image") {
    const href = dataUri(join(publicDir, "images", `${characterId}.png`), "image/png");
    return href ? `<image ffdec:characterId="${characterId}" width="${width}" height="${height}"${transformAttribute} href="${href}" xlink:href="${href}" preserveAspectRatio="none"/>` : "";
  }

  if (asset.kind === "sprite" && asset.frames?.length) {
    const src = spriteFrameForRootFrame(characterId, frame, asset);
    const relative = src.split(`generated/${scene}/`).pop();
    return relative
      ? inlineSvgAsset(join(publicDir, relative), `${hrefId}_${characterId}`, transformAttribute, characterId, registrationShift(asset))
      : "";
  }

  return "";
}

function spriteFrameForRootFrame(characterId, frame, asset) {
  const instance = frame?.instances?.find((item) => String(item.characterId) === String(characterId));
  if (!instance || !asset.frames?.length) return firstNonEmptySpriteFrame(asset.frames);

  const relativeFrame = Math.max(0, frame.index - (instance.placedFrame ?? frame.index));
  const stoppedFrame = firstReachedStopFrame(characterId, relativeFrame);
  const spriteFrame = stoppedFrame ?? relativeFrame % asset.frames.length;
  return asset.frames[spriteFrame] ?? firstNonEmptySpriteFrame(asset.frames);
}

function firstReachedStopFrame(characterId, relativeFrame) {
  const stops = spriteStopFrames[String(characterId)] ?? [];
  return stops.find((stopFrame) => stopFrame <= relativeFrame);
}

function firstNonEmptySpriteFrame(frames) {
  return (
    frames.find((src) => {
      const relative = src.split(`generated/${scene}/`).pop();
      if (!relative) return false;
      const svg = readFileSync(join(publicDir, relative), "utf8");
      return /<(path|use|text|image|polygon|polyline|ellipse|circle|rect)\b/.test(svg);
    }) ?? frames[0]
  );
}

function registrationShift(asset) {
  const x = number(asset.origin?.x, 0);
  const y = number(asset.origin?.y, 0);
  return x || y ? ` transform="matrix(1, 0, 0, 1, ${-x}, ${-y})"` : "";
}

function inlineSvgAsset(path, idPrefix, transformAttribute, characterId = "", contentTransformAttribute = "") {
  if (!existsSync(path)) return "";

  let svg = readFileSync(path, "utf8");
  const body = svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i)?.[1]?.trim();
  if (!body) return "";

  const prefix = `ffdec_${scene}_${idPrefix}_`.replace(/[^A-Za-z0-9_-]/g, "_");
  const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  let namespaced = body;

  for (const id of ids) {
    const escaped = escapeRegExp(id);
    namespaced = namespaced
      .replace(new RegExp(`\\sid="${escaped}"`, "g"), ` id="${prefix}${id}"`)
      .replace(new RegExp(`url\\(#${escaped}\\)`, "g"), `url(#${prefix}${id})`)
      .replace(new RegExp(`(xlink:href|href)="#${escaped}"`, "g"), `$1="#${prefix}${id}"`);
  }

  const characterAttribute = characterId ? ` ffdec:characterId="${characterId}"` : "";
  const content = contentTransformAttribute ? `<g${contentTransformAttribute}>${namespaced}</g>` : namespaced;
  return `<g ffdec:inlinedCharacter="${idPrefix}"${characterAttribute}${transformAttribute}>${content}</g>`;
}

function dataUri(path, mimeType) {
  if (!existsSync(path)) return "";
  return `data:${mimeType};base64,${readFileSync(path).toString("base64")}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listPublicDir(name) {
  const dir = join(publicDir, name);
  return existsSync(dir) ? readdirSync(dir) : [];
}

function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function rectSize(max, min) {
  return (number(max, 0) - number(min, 0)) / 20;
}

function number(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
