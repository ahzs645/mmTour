// Control-flow discovery: frame/sprite actions, stop frames, local defaults,
// button events, nested-section targets, dynamic texts.

import { ctx } from "./extractContext.mjs";
import { parseActionScript, summarizeActionScript } from "./actionscript.mjs";
import { frameVariableActions } from "./asActions.mjs";
import { actionContextAt, findBranchContexts, findFunctionContexts, parseActionScriptLiteral } from "./asParse.mjs";
import { discoverButtonOwnerSprites } from "./assets.mjs";
import { walkFiles } from "./fileUtils.mjs";
import { colorFromTag } from "./geom.mjs";
import { collectNamedUses } from "./svgText.mjs";
import { actionBytesStartWith, compactObject, comparableText, htmlTextAlign, normalizeLoadedText, normalizeName, normalizeVariableName, number } from "./util.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function discoverControlFlow(allTags, frameLabels, groupedEvents) {
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
    stopFrames: [...new Set(stopFrames)].filter((index) => index >= 0 && index < ctx.frames.length).sort((a, b) => a - b),
    spriteStopFrames: ctx.spriteStopFrames,
    spriteLocalDefaults: ctx.spriteLocalDefaults,
    frameActions: ctx.frameActions,
    spriteActions: ctx.spriteActions,
    definedFunctions: ctx.definedFunctions,
    soundLibrary: ctx.soundLibrary,
    globalDefaults: ctx.globalDefaults,
    nestedSectionTargets: ctx.nestedSectionTargets,
    dynamicTexts: discoverDynamicTexts(allTags),
    buttonActions: Object.fromEntries(
      Object.entries(groupedEvents)
        .filter(([, event]) => event.release?.supported
          || event.release?.functionCalls?.length
          || event.rollOver?.functionCalls?.length
          || event.rollOut?.functionCalls?.length
          // A control whose only hover behaviour is a self goto that reveals its label
          // (the kiosk Exit/Replay buttons: on(rollOver) gotoAndPlay(2)) still counts.
          || event.rollOver?.command
          || event.rollOut?.command
          || ctx.nestedSectionTargets[event.release?.target])
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
              level: event.release.level,
              exitNavigation: event.release.exitNavigation,
              rootFunctionNavigation: event.release.rootFunctionNavigation,
              functionCalls: event.release.functionCalls,
              nestedSection: ctx.nestedSectionTargets[event.release.target],
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

export function discoverFrameActions(frameLabels) {
  const scriptsDir = join(ctx.extractedDir, "scripts");
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

export function discoverSpriteActions(frameLabels) {
  const scriptsDir = join(ctx.extractedDir, "scripts");
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
      const body = readFileSync(file, "utf8");
      // Include the script's bare `target = value` assignments too — a toolbar *Pro sprite sets its
      // own `btnDown`/`labelHidden` here, which hideMe/showMe (and the label hide on hover) gate on.
      const actions = [...summarizeActionScript(body, frameLabels, sourcePath, "sprite"), ...frameVariableActions(body, sourcePath)];
      return {
        spriteId,
        frame,
        source: sourcePath,
        actions: annotateNestedTargetPlacements(actions, spriteId, frame),
      };
    })
    .sort((a, b) => a.spriteId - b.spriteId || a.frame - b.frame);
}

export function annotateNestedTargetPlacements(actions, spriteId, frame) {
  const actionableTargets = actions
    .flatMap((action) => [
      action.target,
      ...(action.functionCalls ?? []).map((call) => call.target),
    ])
    .filter((target) => target && target !== "self" && target !== "_root" && target !== "_parent");
  if (!actionableTargets.length) return actions;

  const usesByKey = new Map();
  for (let candidateFrame = frame; candidateFrame >= 0; candidateFrame -= 1) {
    const svgPath = join(ctx.extractedDir, "sprites", `DefineSprite_${spriteId}`, `${candidateFrame + 1}.svg`);
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

export function discoverSpriteStopFrames() {
  const scriptsDir = join(ctx.extractedDir, "scripts");
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

export function discoverSpriteLocalDefaults() {
  const scriptsDir = join(ctx.extractedDir, "scripts");
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

export function discoverButtonEvents(frameLabels) {
  const scriptsDir = join(ctx.extractedDir, "scripts");
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

export function discoverNestedSectionTargets(groupedEvents) {
  const targets = {};
  const normalizedLabels = new Map(Object.entries(ctx.labels).map(([label, frame]) => [normalizeName(label), { label, frame }]));

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

export function discoverDynamicTexts(allTags) {
  const dynamicTexts = {};

  for (const tag of allTags) {
    if (!tag?.characterID || !tag.variableName) continue;

    const variableName = normalizeVariableName(tag.variableName);
    const loadedText = ctx.loadedVariables[variableName];
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
