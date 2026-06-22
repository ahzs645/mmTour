import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseSwf, swf } from "swf-parser";
import { extractControl } from "../src/convert/avm1Control.ts";
import { compactObject } from "./lib/util.mjs";
import {
  disassembleAvm1, decodeAvm1Action, decodePushValues, actionName, matrixFromParser,
  fixedPointValue, readU16, readS16, readU32, readCString, bytesToHex, hexByte,
} from "./lib/avm1Disasm.mjs";
import {
  actionTargetNode, actionEdge, rootFrameNode, spriteFrameNode, functionNode, buttonNode,
  targetNode, expressionNode, swfNode, soundNode, variableNode, variableSourceNode,
  instanceTargetKeys, actionTargetKeys, normalizeTargetName,
} from "./lib/cfgNodes.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["A-tour.swf", "intro.swf", "nav.swf", "segment1.swf", "segment2.swf", "segment3.swf", "segment4.swf", "segment5.swf"];

for (const target of targets) {
  const swfPath = resolveSwfPath(target);
  if (!existsSync(swfPath)) {
    throw new Error(`SWF not found: ${swfPath}`);
  }

  const scene = basename(target, ".swf");
  const outputDir = join(root, "public/generated", scene);
  mkdirSync(outputDir, { recursive: true });

  const report = buildReport(swfPath, scene);
  writeFileSync(join(outputDir, "swf-parser-report.json"), `${JSON.stringify(report, null, 2)}\n`);

  const controlPath = join(outputDir, "control-flow.json");
  const timelinePath = join(outputDir, "timeline.json");
  const timeline = existsSync(timelinePath)
    ? JSON.parse(readFileSync(timelinePath, "utf8"))
    : undefined;
  const timelineControl = timeline?.control ?? {};
  if (existsSync(controlPath)) {
    const existing = JSON.parse(readFileSync(controlPath, "utf8"));
    const annotated = mergeBytecodeFallbacks(annotateGeneratedActionSupport(existing, timeline, report), report.bytecodeControl);
    const merged = {
      ...annotated,
      avm: report.avm,
      secondaryValidation: report.secondaryValidation,
      autoPlayRanges: report.autoPlayRanges,
      bytecodeFrameActions: report.rootFrameActions,
      bytecodeSpriteActions: report.spriteFrameActions,
      buttonDefinitions: report.buttons,
      clickableRegions: report.clickableRegions,
      segmentNavigation: inferSegmentNavigation(existing, report),
      externalMovieLevelActions: inferExternalMovieLevelActions(annotated, timelineControl),
      nestedMovieClips: report.sprites,
      definedFunctions: annotated.definedFunctions ?? timelineControl.definedFunctions ?? [],
      nestedSectionTargets: annotated.nestedSectionTargets ?? timelineControl.nestedSectionTargets ?? {},
      buttonActions: annotated.buttonActions ?? timelineControl.buttonActions ?? {},
      soundLibrary: augmentSoundLibraryDurations(annotated.soundLibrary ?? timelineControl.soundLibrary ?? {}, report.soundDurations),
    };
    merged.controlFlowGraphs = buildControlFlowGraphs(merged, timeline, report);
    writeFileSync(controlPath, `${JSON.stringify(merged, null, 2)}\n`);
  }

  if (timeline) {
    timeline.control ??= {};
    timeline.control = mergeBytecodeFallbacks(timeline.control, report.bytecodeControl);
    timeline.control.avm = report.avm;
    timeline.control.autoPlayRanges = report.autoPlayRanges;
    timeline.control.buttonDefinitions = report.buttons;
    timeline.control.clickableRegions = report.clickableRegions;
    timeline.control.segmentNavigation = inferSegmentNavigation(timeline.control, report);
    timeline.control.externalMovieLevelActions = inferExternalMovieLevelActions(timeline.control, timelineControl);
    timeline.control.nestedMovieClips = report.sprites;
    timeline.control.definedFunctions ??= timelineControl.definedFunctions ?? [];
    timeline.control.nestedSectionTargets ??= timelineControl.nestedSectionTargets ?? {};
    timeline.control.buttonActions ??= timelineControl.buttonActions ?? {};
    timeline.control.soundLibrary = augmentSoundLibraryDurations(timeline.control.soundLibrary ?? timelineControl.soundLibrary ?? {}, report.soundDurations);
    const controlForGraph = existsSync(controlPath) ? JSON.parse(readFileSync(controlPath, "utf8")) : timeline.control;
    timeline.control.controlFlowGraphs = controlForGraph.controlFlowGraphs ?? buildControlFlowGraphs(controlForGraph, timeline, report);
    writeFileSync(timelinePath, `${JSON.stringify(timeline)}\n`);
  }

  console.log(`${scene}: ${report.avm.kind}, ${report.rootFrameActions.length} root action frames, ${report.spriteFrameActions.length} sprite action frames, ${report.buttons.length} buttons`);
}

function resolveSwfPath(target) {
  // Accept a path, "segment4.swf", or a bare "segment4" — same as build-asset-timeline.
  const file = /\.swf$/i.test(target) ? basename(target) : `${basename(target)}.swf`;
  const candidates = [resolve(root, target), resolve(root, "public", file)];
  return candidates.find((path) => existsSync(path)) ?? candidates[candidates.length - 1];
}

function mergeBytecodeFallbacks(control = {}, bytecodeControl = {}) {
  const merged = { ...control };
  if (!hasItems(merged.stopFrames) && hasItems(bytecodeControl.stopFrames)) {
    merged.stopFrames = [...new Set(bytecodeControl.stopFrames)].sort((a, b) => a - b);
  }
  if (!hasItems(merged.spriteStopFrames) && hasItems(bytecodeControl.spriteStopFrames)) {
    merged.spriteStopFrames = bytecodeControl.spriteStopFrames;
  }
  if (!hasItems(merged.frameActions) && hasItems(bytecodeControl.frameActions)) {
    merged.frameActions = withBytecodeSources(bytecodeControl.frameActions, "root");
  }
  if (!hasItems(merged.spriteActions) && hasItems(bytecodeControl.spriteActions)) {
    merged.spriteActions = withBytecodeSources(bytecodeControl.spriteActions, "sprite");
  }
  if (!hasItems(merged.definedFunctions) && hasItems(bytecodeControl.definedFunctions)) {
    merged.definedFunctions = bytecodeControl.definedFunctions;
  }
  if (!hasItems(merged.buttonActions) && hasItems(bytecodeControl.buttonActions)) {
    merged.buttonActions = bytecodeControl.buttonActions;
  }
  return merged;
}

function withBytecodeSources(records = [], scope) {
  return records.map((record) => {
    const source = record.source ?? (scope === "sprite"
      ? `bytecode/DefineSprite_${record.spriteId}/frame_${record.frame + 1}/DoAction`
      : `bytecode/frame_${record.frame + 1}/DoAction`);
    return {
      ...record,
      source,
      actions: (record.actions ?? []).map((action) => ({ ...action, source: action.source ?? source })),
    };
  });
}

function hasItems(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

function augmentSoundLibraryDurations(soundLibrary = {}, durations = {}) {
  return Object.fromEntries(Object.entries(soundLibrary).map(([name, entry]) => {
    if (!entry || typeof entry !== "object" || entry.durationMs !== undefined) return [name, entry];
    const id = soundIdFromSrc(entry.src);
    const durationMs = durations[String(id)];
    return [name, durationMs === undefined ? entry : { ...entry, durationMs }];
  }));
}

function soundIdFromSrc(src) {
  const file = basename(String(src ?? ""));
  const match = file.match(/^([+-]?\d+)_/);
  return match ? Number(match[1]) : undefined;
}

function annotateGeneratedActionSupport(control, timeline, report) {
  if (!timeline?.frames?.length) return control;
  const spriteById = new Map((report.sprites ?? []).map((spriteInfo) => [spriteInfo.spriteId, spriteInfo]));
  const assetById = new Map(Object.entries(timeline.assets ?? {}).map(([id, asset]) => [Number(id), asset]));

  const annotateEntry = (entry) => ({
    ...entry,
    actions: (entry.actions ?? []).map((action) => annotateAction(action, entry.frame, Boolean(entry.spriteId), timeline, spriteById, assetById)),
  });

  return {
    ...control,
    frameActions: (control.frameActions ?? []).map(annotateEntry),
    spriteActions: (control.spriteActions ?? []).map(annotateEntry),
  };
}

function buildControlFlowGraphs(control, timeline, report) {
  const frameCount = control.frameCount ?? timeline?.frameCount ?? report.header?.frameCount ?? 0;
  const labels = control.labels ?? timeline?.labels ?? {};
  const labelToFrame = new Map(Object.entries(labels));
  const frameLabel = new Map(Object.entries(labels).map(([label, frame]) => [frame, label]));

  const root = {
    nodes: Array.from({ length: frameCount }, (_, frame) => compactObject({
      id: rootFrameNode(frame),
      type: "rootFrame",
      frame,
      label: frameLabel.get(frame),
    })),
    edges: [],
  };
  for (let frame = 0; frame < Math.max(0, frameCount - 1); frame += 1) {
    root.edges.push({ from: rootFrameNode(frame), to: rootFrameNode(frame + 1), type: "timelineNext" });
  }
  for (const entry of control.frameActions ?? []) {
    addActionEdges(root.edges, rootFrameNode(entry.frame), entry.actions ?? [], {
      scope: "root",
      labels: labelToFrame,
    });
  }

  const sprites = (control.nestedMovieClips ?? []).map((sprite) => {
    const frameTotal = sprite.frameCount ?? sprite.frames ?? nestedSpriteFrameCount(control, sprite.spriteId);
    const spriteLabels = new Map(Object.entries(sprite.labels ?? {}));
    const reverseLabels = new Map(Object.entries(sprite.labels ?? {}).map(([label, frame]) => [frame, label]));
    const graph = {
      spriteId: sprite.spriteId,
      nodes: Array.from({ length: frameTotal }, (_, frame) => compactObject({
        id: spriteFrameNode(sprite.spriteId, frame),
        type: "spriteFrame",
        spriteId: sprite.spriteId,
        frame,
        label: reverseLabels.get(frame),
      })),
      edges: [],
    };
    for (let frame = 0; frame < Math.max(0, frameTotal - 1); frame += 1) {
      graph.edges.push({ from: spriteFrameNode(sprite.spriteId, frame), to: spriteFrameNode(sprite.spriteId, frame + 1), type: "timelineNext" });
    }
    for (const entry of (control.spriteActions ?? []).filter((candidate) => candidate.spriteId === sprite.spriteId)) {
      addActionEdges(graph.edges, spriteFrameNode(sprite.spriteId, entry.frame), entry.actions ?? [], {
        scope: "sprite",
        spriteId: sprite.spriteId,
        labels: spriteLabels,
      });
    }
    return graph;
  });

  const functions = Object.values(control.definedFunctions ?? {}).map((definition) => {
    const node = functionNode(definition.functionName);
    const edges = [];
    for (const call of definition.functionCalls ?? definition.calls ?? []) {
      edges.push(compactObject({
        from: node,
        to: functionNode(call.functionName),
        type: "functionCall",
        target: call.target,
        arguments: call.arguments,
      }));
    }
    for (const assignment of definition.assignments ?? []) {
      edges.push(compactObject({
        from: node,
        to: variableNode(assignment.variable ?? assignment.target),
        type: "assignment",
        value: assignment.value,
      }));
    }
    return {
      functionName: definition.functionName,
      nodes: [compactObject({ id: node, type: "function", functionName: definition.functionName, source: definition.source })],
      edges,
    };
  });

  const buttons = Object.entries(control.buttonActions ?? {}).map(([buttonId, group]) => {
    const nodes = [{ id: buttonNode(buttonId), type: "button", buttonId }];
    const edges = [];
    for (const eventName of ["release", "rollOver", "rollOut"]) {
      const action = group[eventName];
      if (!action) continue;
      const eventNode = `${buttonNode(buttonId)}:${eventName}`;
      nodes.push({ id: eventNode, type: "buttonEvent", buttonId, eventName });
      edges.push({ from: buttonNode(buttonId), to: eventNode, type: "buttonEvent" });
      addActionEdges(edges, eventNode, [action], {
        scope: "button",
        labels: labelToFrame,
      });
    }
    return { buttonId: Number(buttonId), nodes, edges };
  });

  return {
    schemaVersion: 1,
    generatedFrom: "Open Flash parser + FFDec ActionScript action metadata",
    root,
    sprites,
    functions,
    buttons,
  };
}

function addActionEdges(edges, from, actions, context) {
  for (const action of actions) {
    if (action.command === "stop") {
      edges.push(actionEdge(from, `${from}:stop`, "stop", action));
      continue;
    }
    if (action.command === "play") {
      edges.push(actionEdge(from, `${from}:play`, "play", action));
      continue;
    }
    if (action.command === "gotoAndPlay" || action.command === "gotoAndStop") {
      const target = actionTargetNode(action, context);
      edges.push(actionEdge(from, target, action.command, action));
      continue;
    }
    if (action.command === "loadMovieNum" || action.command === "doRelease") {
      edges.push(actionEdge(from, swfNode(action.swf, action.level), action.command, action));
      continue;
    }
    if (action.command === "callFunctions") {
      for (const call of action.functionCalls ?? []) {
        edges.push(actionEdge(from, functionNode(call.functionName), "functionCall", {
          ...action,
          target: call.target,
          functionName: call.functionName,
          arguments: call.arguments,
        }));
      }
      continue;
    }
    if (action.command === "playVO" || action.command === "attachSound" || action.command === "markSndSegment" || action.command === "stopSound") {
      edges.push(actionEdge(from, soundNode(action.sound ?? action.target), action.command, action));
      continue;
    }
    if (action.command === "loadVariables") {
      edges.push(actionEdge(from, variableSourceNode(action.variableSource ?? action.target), action.command, action));
    }
  }
}

function nestedSpriteFrameCount(control, spriteId) {
  const frames = (control.spriteActions ?? [])
    .filter((entry) => entry.spriteId === spriteId)
    .map((entry) => entry.frame);
  const stopFrames = control.spriteStopFrames?.[String(spriteId)] ?? [];
  return Math.max(0, ...frames, ...stopFrames) + 1;
}

function annotateAction(action, rootFrame, isSpriteAction, timeline, spriteById, assetById) {
  if (action.supported !== false) return action;
  if (action.command !== "gotoAndPlay" && action.command !== "gotoAndStop") return action;
  if (!action.target || action.target === "self" || action.target === "_root" || action.target === "_parent") return action;

  const placedTarget = action.targetPlacement?.characterId ? assetById.get(Number(action.targetPlacement.characterId)) : undefined;
  if (placedTarget?.kind === "sprite" && placedTarget.frames?.length && hasResolvableSpriteTarget(action, spriteById.get(Number(action.targetPlacement.characterId)))) {
    const { reason, ...supportedAction } = action;
    return {
      ...supportedAction,
      supported: true,
    };
  }

  const targetKeys = actionTargetKeys(action.target);
  const candidateFrames = isSpriteAction ? [timeline.frames?.[rootFrame]].filter(Boolean) : (timeline.frames ?? []).slice(rootFrame);
  const targetInstance = candidateFrames
    .flatMap((frame) => frame.instances ?? [])
    .find((instance) => instanceTargetKeys(instance.name).some((key) => targetKeys.includes(key)));
  if (!targetInstance) return action;

  const asset = assetById.get(targetInstance.characterId);
  if (asset?.kind !== "sprite" || !asset.frames?.length) return action;

  if (!hasResolvableSpriteTarget(action, spriteById.get(targetInstance.characterId))) return action;

  const { reason, ...supportedAction } = action;
  return {
    ...supportedAction,
    supported: true,
  };
}

function hasResolvableSpriteTarget(action, nestedSprite) {
  return (
    typeof action.frame === "number" ||
    (typeof action.frameExpression === "string" && Number.isFinite(Number.parseInt(action.frameExpression, 10))) ||
    (typeof action.label === "string" && nestedSprite?.labels?.[action.label] !== undefined)
  );
}

function buildReport(swfPath, scene) {
  const movie = parseSwf(readFileSync(swfPath));
  const bytecodeControl = extractControl(movie);
  const soundDurations = soundDurationsFromMovie(movie);
  const tagCounts = countTags(movie.tags);
  const root = inspectTimeline(movie.tags, "root", undefined);
  const sprites = movie.tags
    .filter((tag) => tag.type === swf.TagType.DefineSprite)
    .map((tag) => inspectTimeline(tag.tags ?? [], "sprite", tag.id, tag.frameCount))
    .sort((a, b) => a.spriteId - b.spriteId);
  const buttons = movie.tags
    .filter((tag) => tag.type === swf.TagType.DefineButton)
    .map(describeButton)
    .sort((a, b) => a.id - b.id);
  const hasAvm2 = Boolean(tagCounts.DoAbc || tagCounts.DoAbcDefine || movie.tags.some((tag) => tag.type === swf.TagType.FileAttributes && tag.useAs3));
  const hasAvm1 = Boolean(tagCounts.DoAction || tagCounts.DoInitAction || buttons.some((button) => button.actions.length));

  const clickableRegions = buttons.flatMap((button) => button.hitAreas.map((hitArea) => ({
    buttonId: button.id,
    hitCharacterId: hitArea.characterId,
    depth: hitArea.depth,
    matrix: hitArea.matrix,
    events: [...new Set(button.actions.flatMap((action) => action.events))],
  })));

  return {
    scene,
    source: `${scene}.swf`,
    generatedFrom: "Open Flash swf-parser bytecode and structural traversal",
    header: {
      swfVersion: movie.header.swfVersion,
      frameRate: fixedPointValue(movie.header.frameRate),
      frameCount: movie.header.frameCount,
      dimensions: {
        width: (movie.header.frameSize.xMax - movie.header.frameSize.xMin) / 20,
        height: (movie.header.frameSize.yMax - movie.header.frameSize.yMin) / 20,
      },
    },
    avm: {
      kind: hasAvm2 ? "AVM2" : hasAvm1 ? "AVM1" : "none",
      hasAvm1,
      hasAvm2,
      needsRabcdasm: hasAvm2,
      evidence: {
        doActionTags: tagCounts.DoAction ?? 0,
        doInitActionTags: tagCounts.DoInitAction ?? 0,
        doAbcTags: (tagCounts.DoAbc ?? 0) + (tagCounts.DoAbcDefine ?? 0),
        fileAttributesUseAs3: movie.tags.some((tag) => tag.type === swf.TagType.FileAttributes && tag.useAs3),
      },
    },
    secondaryValidation: {
      parser: "swf-parser",
      tagCounts,
      rootFrameCount: root.frameCount,
      spriteCount: sprites.length,
      buttonCount: buttons.length,
      notes: hasAvm2
        ? ["AVM2 bytecode found; inspect ABC with RABCDAsm before compiling behavior."]
        : ["No AVM2/ABC tags found; behavior is AVM1/ActionScript 1-2 bytecode."],
    },
    labels: root.labels,
    autoPlayRanges: buildAutoPlayRanges(movie.header.frameCount, root.stopFrames ?? [], root.labels),
    bytecodeControl,
    soundDurations,
    rootFrameActions: root.frameActions,
    spriteFrameActions: sprites.flatMap((spriteInfo) =>
      spriteInfo.frameActions.map((action) => ({ spriteId: spriteInfo.spriteId, ...action })),
    ),
    sprites,
    buttons,
    clickableRegions,
  };
}

function soundDurationsFromMovie(movie) {
  return Object.fromEntries(
    movie.tags
      .filter((tag) => tag.type === swf.TagType.DefineSound)
      .map((tag) => [String(Number(tag.id)), soundDurationMs(tag)])
      .filter(([, duration]) => duration !== undefined),
  );
}

function soundDurationMs(tag) {
  const samples = Number(tag.sampleCount);
  const rate = swfSoundRate(tag.soundRate);
  return Number.isFinite(samples) && samples > 0 && rate > 0 ? (samples / rate) * 1000 : undefined;
}

function swfSoundRate(soundRate) {
  const rates = [5512, 11025, 22050, 44100];
  return soundRate <= 3 ? rates[soundRate] : Number(soundRate) || 0;
}

function inspectTimeline(tags, scope, spriteId, declaredFrameCount) {
  const labels = {};
  const frameActions = [];
  let frame = 0;
  let pendingLabel = "";

  for (const tag of tags) {
    if (tag.type === swf.TagType.FrameLabel) {
      pendingLabel = tag.name;
      labels[pendingLabel] = frame;
      continue;
    }

    if (tag.type === swf.TagType.DoAction) {
      frameActions.push({
        frame,
        label: pendingLabel || undefined,
        scope,
        actionBytes: bytesToHex(tag.actions),
        actions: disassembleAvm1(tag.actions),
      });
      continue;
    }

    if (tag.type === swf.TagType.ShowFrame) {
      frame += 1;
      pendingLabel = "";
    }
  }

  const stopFrames = frameActions
    .filter((entry) => entry.actions.some((action) => action.op === "Stop"))
    .map((entry) => entry.frame);

  return compactObject({
    spriteId,
    frameCount: declaredFrameCount ?? frame,
    labels,
    stopFrames,
    autoPlayRanges: buildAutoPlayRanges(declaredFrameCount ?? frame, stopFrames, labels),
    frameActions,
  });
}

function buildAutoPlayRanges(frameCount, stopFrames, labels) {
  const stops = new Set(stopFrames);
  const labelsByFrame = new Map(Object.entries(labels).map(([label, frame]) => [frame, label]));
  const ranges = [];
  let start = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    if (!stops.has(frame)) continue;
    if (start <= frame - 1) {
      ranges.push(compactObject({
        startFrame: start,
        endFrame: frame - 1,
        startLabel: labelsByFrame.get(start),
        endLabel: labelsByFrame.get(frame - 1),
      }));
    }
    start = frame + 1;
  }

  if (start <= frameCount - 1) {
    ranges.push(compactObject({
      startFrame: start,
      endFrame: frameCount - 1,
      startLabel: labelsByFrame.get(start),
      endLabel: labelsByFrame.get(frameCount - 1),
    }));
  }

  return ranges.filter((range) => range.endFrame >= range.startFrame);
}

function describeButton(tag) {
  return {
    id: tag.id,
    trackAsMenu: Boolean(tag.trackAsMenu),
    states: {
      up: describeButtonRecords(tag.records.filter((record) => record.stateUp)),
      over: describeButtonRecords(tag.records.filter((record) => record.stateOver)),
      down: describeButtonRecords(tag.records.filter((record) => record.stateDown)),
      hitTest: describeButtonRecords(tag.records.filter((record) => record.stateHitTest)),
    },
    hitAreas: describeButtonRecords(tag.records.filter((record) => record.stateHitTest)),
    actions: tag.actions.map((action) => ({
      events: buttonEventsFromConditions(action.conditions),
      conditions: action.conditions,
      actionBytes: bytesToHex(action.actions),
      actions: disassembleAvm1(action.actions),
    })),
  };
}

function describeButtonRecords(records) {
  return records
    .map((record) => ({
      characterId: record.characterId,
      depth: record.depth,
      matrix: matrixFromParser(record.matrix),
      states: compactObject({
        up: record.stateUp || undefined,
        over: record.stateOver || undefined,
        down: record.stateDown || undefined,
        hitTest: record.stateHitTest || undefined,
      }),
    }))
    .sort((a, b) => a.depth - b.depth || a.characterId - b.characterId);
}

function buttonEventsFromConditions(conditions) {
  const events = [];
  if (conditions.overDownToOverUp) events.push("release");
  if (conditions.idleToOverDown || conditions.overUpToOverDown) events.push("press");
  if (conditions.idleToOverUp || conditions.outDownToOverDown) events.push("rollOver");
  if (conditions.overUpToIdle || conditions.overDownToOutDown || conditions.outDownToIdle || conditions.overDownToIdle) events.push("rollOut");
  if (conditions.keyPress) events.push(`keyPress:${conditions.keyPress}`);
  return events.length ? events : ["unknown"];
}

function inferSegmentNavigation(existing, report) {
  const swfs = new Set();
  for (const source of [existing, report]) collectSwfTargets(source, swfs);
  return [...swfs].sort().map((swf) => ({ swf }));
}

function inferExternalMovieLevelActions(...sources) {
  const levelLoads = shellMovieLevelLoads();
  const actions = [];

  for (const source of sources) collectExternalMovieLevelActions(source, actions, levelLoads);

  return uniqueBy(actions, (action) =>
    [
      action.scope,
      action.spriteId ?? "",
      action.frame ?? "",
      action.source ?? "",
      action.level,
      action.target ?? "",
      action.command ?? "",
      action.functionName ?? "",
      action.calledFunctionName ?? "",
      action.swf ?? "",
    ].join("|"),
  );
}

function collectExternalMovieLevelActions(value, actions, levelLoads, owner = {}) {
  if (!value || typeof value !== "object") return;

  const nextOwner = {
    ...owner,
    ...(typeof value.frame === "number" ? { frame: value.frame } : {}),
    ...(typeof value.spriteId === "number" ? { spriteId: value.spriteId, scope: "sprite" } : {}),
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
  };

  if (typeof value.target === "string" && typeof value.command === "string") {
    const level = movieLevel(value.target);
    if (level !== undefined) {
      const swfs = levelLoads.get(level) ?? [];
      actions.push(compactObject({
        scope: nextOwner.scope ?? "root",
        spriteId: nextOwner.spriteId,
        frame: nextOwner.frame,
        source: value.source,
        level,
        swf: swfs.length === 1 ? swfs[0] : undefined,
        swfCandidates: swfs.length > 1 ? swfs : undefined,
        target: value.target,
        command: value.command,
        functionName: value.functionName,
        branchCondition: value.functionBranchCondition ?? value.branchCondition,
        supported: value.supported,
        reason: value.reason,
      }));
    }
  }

  for (const call of value.functionCalls ?? []) {
    const level = movieLevel(call.target);
    if (level === undefined) continue;
    const swfs = levelLoads.get(level) ?? [];
    actions.push(compactObject({
      scope: nextOwner.scope ?? "root",
      spriteId: nextOwner.spriteId,
      frame: nextOwner.frame,
      source: value.source,
      level,
      swf: swfs.length === 1 ? swfs[0] : undefined,
      swfCandidates: swfs.length > 1 ? swfs : undefined,
      target: call.target,
      command: "callFunction",
      functionName: value.functionName,
      calledFunctionName: call.functionName,
      arguments: call.arguments,
      branchCondition: value.functionBranchCondition ?? value.branchCondition,
      supported: value.supported,
      reason: value.reason,
    }));
  }

  const children = Array.isArray(value)
    ? value.map((child) => ["", child])
    : Object.entries(value);
  for (const [key, child] of children) {
    if (key === "externalMovieLevelActions") continue;
    collectExternalMovieLevelActions(child, actions, levelLoads, nextOwner);
  }
}

function movieLevel(target) {
  const match = String(target).match(/^_level(\d+)(?:\.|$)/i);
  if (!match) return undefined;
  const level = Number(match[1]);
  return level > 0 ? level : undefined;
}

function shellMovieLevelLoads() {
  const loads = new Map();
  const shellSource = join(root, "public/generated/A-tour/scripts/frame_1/DoAction.as");
  if (!existsSync(shellSource)) return loads;

  const source = readFileSync(shellSource, "utf8");
  for (const match of source.matchAll(/loadMovieNum\("([^"]+\.swf)"\s*,\s*(\d+)/g)) {
    const level = Number(match[2]);
    const swfs = loads.get(level) ?? [];
    loads.set(level, [...new Set([...swfs, match[1]])].sort());
  }
  return loads;
}

function uniqueBy(items, keyFor) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function collectSwfTargets(value, swfs) {
  if (!value || typeof value !== "object") return;
  if (typeof value.swf === "string" && value.swf.endsWith(".swf")) swfs.add(value.swf);
  for (const child of Array.isArray(value) ? value : Object.values(value)) collectSwfTargets(child, swfs);
}

function countTags(tags) {
  const counts = {};
  for (const tag of tags) {
    const name = swf.TagType[tag.type] ?? `Tag${tag.type}`;
    counts[name] = (counts[name] ?? 0) + 1;
    if (tag.type === swf.TagType.DefineSprite) {
      const nested = countTags(tag.tags ?? []);
      for (const [nestedName, count] of Object.entries(nested)) {
        counts[nestedName] = (counts[nestedName] ?? 0) + count;
      }
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
