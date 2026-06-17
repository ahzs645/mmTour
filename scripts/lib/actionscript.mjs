// ActionScript summarisation: root-function navigation/sound inference, exit
// navigation, defined-function discovery, parse/summarise of frame & sprite scripts.

import { ctx } from "./extractContext.mjs";
import { chooseExitNavigationTarget, discoverFunctionAssignments, discoverFunctionBodyCalls, discoverFunctionCallActions, resolveSound } from "./asActions.mjs";
import { actionContextAt, contextLabel, discoverFunctionCalls, findBranchContexts, findFunctionContexts, findMatchingBrace, findTellTargetContexts, parseStatements, resolveFrameExpression, runtimeCanExecuteBranchCommand, stringLiteral, withActionContext } from "./asParse.mjs";
import { relativeExtractedPath, walkFiles } from "./fileUtils.mjs";
import { evaluateGeneratedCondition, resolveVariableSource } from "./sceneVars.mjs";
import { compactObject, escapeRegExp } from "./util.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let movieTargetLevelCache;

export function parseActionScript(source, frameLabels, sourcePath) {
  const rootGoto = source.match(/_root\.gotoAnd(Play|Stop)\(([^)]+)\)/);
  const clipGoto = source.match(/([A-Za-z0-9_.$]+)\.gotoAnd(Play|Stop)\(([^)]+)\)/);
  const localGoto = source.match(/(?:^|[\s;])gotoAnd(Play|Stop)\(([^)]+)\)/);
  // Every movie this handler loads, in source order. An explicit `loadMovieNum(url, N)` carries N;
  // a bare `_level0.doRelease(url)` defers to the shell, which drops it into the content level
  // (`intMovieTargLevel`). Without the level, a section button's doRelease defaulted to level 0 at
  // runtime and replaced the shell instead of swapping the content level. A handler may load more
  // than one movie (e.g. a "restart the whole tour" button: segment1 into the content level AND an
  // MS-logo overlay into a higher level), so capture them all — not just the first.
  const loads = collectMovieLoads(source);
  const swf = loads[0]?.swf;
  const swfLevel = loads[0]?.level;
  const swfLevelEntry = swf && swfLevel != null ? { level: swfLevel } : {};
  // Only carry the array when there's a second load to honor; the single-load common case is fully
  // described by swf/level above (and the runtime falls back to those when `loads` is absent).
  const multiLoad = loads.length > 1 ? { loads } : {};
  const exitNavigation = inferExitNavigation(source, frameLabels);
  const functionCalls = discoverFunctionCalls(source);
  // Simple `flag = value;` assignments in the handler (e.g. a section icon's `isActive = 1;`
  // and `_parent.holdState = 1;`). FFDec's button handlers carry these alongside the calls;
  // they drive the select/deselect state the runtime needs (without `isActive` the icon's
  // unSelect() never fires its return animation and the icons stack at the replay slot).
  const assignments = discoverFunctionAssignments(source);
  const extraAssignments = assignments.length ? { assignments } : {};

  if (exitNavigation) {
    return {
      target: "_root",
      command: "gotoAndPlay",
      label: exitNavigation.exitLabel,
      frame: exitNavigation.exitFrame,
      swf: exitNavigation.swf,
      ...(exitNavigation.level ? { level: exitNavigation.level } : {}),
      exitNavigation,
      ...(functionCalls.length ? { functionCalls } : {}),
      ...extraAssignments,
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
      ...swfLevelEntry,
      ...multiLoad,
      ...(functionCalls.length ? { functionCalls } : {}),
      ...extraAssignments,
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
      ...swfLevelEntry,
      ...multiLoad,
      ...(functionCalls.length ? { functionCalls } : {}),
      ...extraAssignments,
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
      ...swfLevelEntry,
      ...multiLoad,
      ...(functionCalls.length ? { functionCalls } : {}),
      ...extraAssignments,
      source: sourcePath,
      supported: parentMapsToRoot || Boolean(swf),
      ...(parentMapsToRoot || swf ? {} : { reason: "Nested MovieClip actions are extracted but not compiled into the frame-SVG runtime yet." }),
    };
  }

  if (swf) {
    return {
      swf,
      ...swfLevelEntry,
      ...multiLoad,
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
      ...extraAssignments,
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

export function summarizeActionScript(source, frameLabels, sourcePath, scope) {
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
    const resolvedSound = resolveSound(ctx.soundLibrary, match[1]);
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
    const resolvedSound = resolveSound(ctx.soundLibrary, match[1]);
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

export function inferRootFunctionNavigation(functionCalls) {
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

export function inferRootFunctionSound(rootCall) {
  if (!rootCall || rootCall.functionName !== "initMusic") return null;

  const section = stringLiteral(rootCall.arguments ?? "");
  if (!section) return null;

  const body = rootFunctionBody(rootCall.functionName);
  if (!body) return null;

  for (const match of body.matchAll(/(?:else\s+)?if\s*\(\s*whichSection\s*==\s*"([^"]+)"\s*\)\s*\{([\s\S]*?)\n\s*\}/g)) {
    if (match[1] !== section) continue;
    const sound = match[2].match(/attachSound\("([^"]+)"\)/)?.[1];
    const resolvedSound = resolveSound(ctx.rootSoundLibrary, sound);
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

export function rootFunctionBody(functionName) {
  const sourcePath = join(ctx.root, "extracted", "A-tour", "scripts", "frame_1", "DoAction.as");
  if (!existsSync(sourcePath)) return "";

  const source = readFileSync(sourcePath, "utf8");
  const match = source.match(new RegExp(`function\\s+${escapeRegExp(functionName)}\\s*\\([^)]*\\)\\s*\\{`));
  if (!match) return "";

  const bodyStart = (match.index ?? 0) + match[0].length - 1;
  const bodyEnd = findMatchingBrace(source, bodyStart);
  return source.slice(bodyStart + 1, bodyEnd);
}

export function inferExitNavigation(source, frameLabels) {
  if (!/exitAnim\s*\(/.test(source)) return null;

  const section = source.match(/(?:_level\d+\.)?nav\.targSection\s*=\s*"([^"]+)"/)?.[1];
  if (!section) return null;

  const sectionTargets = discoverTargetSectionNavigation();
  const target = chooseExitNavigationTarget(sectionTargets[section] ?? [], frameLabels);
  if (!target?.swf) return null;

  // exitAnim() branches on the (runtime) OSVersion: Pro → navAnim_Pro_Exit, Per → navAnim_Personal_Exit.
  // The old `target.frame > navAnim_Pro_Exit` heuristic misclassified BestForBusiness (its doRelease
  // sits at f323, inside the Pro cascade but BEFORE the Pro-exit label) as Personal, sending the Pro
  // toolbar down the Per path (4 buttons, no silver). Pick by the tour's OSVersion default instead.
  const osVersion = ctx.globalDefaults["bkgd.OSVersion"];
  const exitLabel = osVersion === "Per" && frameLabels["navAnim_Personal_Exit"] !== undefined
    ? "navAnim_Personal_Exit"
    : frameLabels["navAnim_Pro_Exit"] !== undefined
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
    level: discoverMovieTargetLevel(),
  };
}

/** Every movie a handler loads, in source order: `loadMovieNum(url, N)` → level N;
 *  a bare `_level0.doRelease(url)` → the shell's content level (`discoverMovieTargetLevel()`). */
function collectMovieLoads(source) {
  const loads = [];
  const re = /(?:_level0\.)?doRelease\("([^"]+\.swf)"\)|loadMovieNum\("([^"]+\.swf)"(?:\s*,\s*(\d+))?/g;
  let m;
  while ((m = re.exec(source))) {
    if (m[1]) loads.push({ swf: m[1], level: discoverMovieTargetLevel() });
    else if (m[2]) loads.push(m[3] != null ? { swf: m[2], level: Number(m[3]) } : { swf: m[2] });
  }
  return loads;
}

export function discoverMovieTargetLevel() {
  if (movieTargetLevelCache !== undefined) return movieTargetLevelCache;
  const scriptsDir = join(ctx.extractedDir, "scripts");
  movieTargetLevelCache = 0;
  if (existsSync(scriptsDir)) {
    for (const file of walkFiles(scriptsDir).filter((path) => path.endsWith(".as"))) {
      const m = readFileSync(file, "utf8").match(/intMovieTargLevel\s*=\s*(\d+)/);
      if (m) { movieTargetLevelCache = Number(m[1]); break; }
    }
  }
  return movieTargetLevelCache;
}

export function discoverTargetSectionNavigation() {
  const scriptsDir = join(ctx.extractedDir, "scripts");
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

export function inferExitFrameFromExitAnim() {
  const scriptsDir = join(ctx.extractedDir, "scripts");
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

export function discoverDefinedFunctions() {
  const scriptsDir = join(ctx.extractedDir, "scripts");
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
      // For sprite functions keep self-gotos too — a control's over()/out() reveal is just
      // `if(!musicOn)gotoAndPlay(28);else gotoAndPlay(5)`, and the runtime needs the branch.
      const statements = parseStatements(body, Boolean(sprite));
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
