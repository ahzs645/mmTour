import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseSwf, swf } from "swf-parser";

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
    const annotated = annotateGeneratedActionSupport(existing, timeline, report);
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
      soundLibrary: annotated.soundLibrary ?? timelineControl.soundLibrary ?? {},
    };
    merged.controlFlowGraphs = buildControlFlowGraphs(merged, timeline, report);
    writeFileSync(controlPath, `${JSON.stringify(merged, null, 2)}\n`);
  }

  if (timeline) {
    timeline.control ??= {};
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
    timeline.control.soundLibrary ??= timelineControl.soundLibrary ?? {};
    const controlForGraph = existsSync(controlPath) ? JSON.parse(readFileSync(controlPath, "utf8")) : timeline.control;
    timeline.control.controlFlowGraphs = controlForGraph.controlFlowGraphs ?? buildControlFlowGraphs(controlForGraph, timeline, report);
    writeFileSync(timelinePath, `${JSON.stringify(timeline)}\n`);
  }

  console.log(`${scene}: ${report.avm.kind}, ${report.rootFrameActions.length} root action frames, ${report.spriteFrameActions.length} sprite action frames, ${report.buttons.length} buttons`);
}

function resolveSwfPath(target) {
  const direct = resolve(root, target);
  if (existsSync(direct)) return direct;

  const publicPath = resolve(root, "public", basename(target));
  if (existsSync(publicPath)) return publicPath;

  return direct;
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

  const functions = (control.definedFunctions ?? []).map((definition) => {
    const node = functionNode(definition.functionName);
    const edges = [];
    for (const call of definition.functionCalls ?? []) {
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
        to: variableNode(assignment.variable),
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

function actionTargetNode(action, context) {
  if (action.target && action.target !== "self") return targetNode(action.target);
  if (typeof action.frame === "number") {
    return context.scope === "sprite" ? spriteFrameNode(context.spriteId, action.frame) : rootFrameNode(action.frame);
  }
  if (action.label && context.labels?.has(action.label)) {
    const frame = context.labels.get(action.label);
    return context.scope === "sprite" ? spriteFrameNode(context.spriteId, frame) : rootFrameNode(frame);
  }
  if (action.frameExpression) {
    return expressionNode(action.frameExpression);
  }
  return targetNode(action.target ?? "unresolved");
}

function actionEdge(from, to, type, action) {
  return compactObject({
    from,
    to,
    type,
    command: action.command,
    condition: action.branchCondition ?? action.functionBranchCondition,
    source: action.source,
    supported: action.supported,
    target: action.target,
    label: action.label,
    frame: action.frame,
    frameExpression: action.frameExpression,
    swf: action.swf,
    level: action.level,
    sound: action.sound,
    functionName: action.functionName,
  });
}

function nestedSpriteFrameCount(control, spriteId) {
  const frames = (control.spriteActions ?? [])
    .filter((entry) => entry.spriteId === spriteId)
    .map((entry) => entry.frame);
  const stopFrames = control.spriteStopFrames?.[String(spriteId)] ?? [];
  return Math.max(0, ...frames, ...stopFrames) + 1;
}

function rootFrameNode(frame) {
  return `root:frame:${frame}`;
}

function spriteFrameNode(spriteId, frame) {
  return `sprite:${spriteId}:frame:${frame}`;
}

function functionNode(functionName) {
  return `function:${functionName ?? "anonymous"}`;
}

function buttonNode(buttonId) {
  return `button:${buttonId}`;
}

function targetNode(target) {
  return `target:${target}`;
}

function expressionNode(expression) {
  return `expression:${expression}`;
}

function swfNode(swfName, level) {
  return `swf:${swfName ?? "unknown"}${level !== undefined ? `:level:${level}` : ""}`;
}

function soundNode(sound) {
  return `sound:${sound ?? "unknown"}`;
}

function variableNode(variable) {
  return `variable:${variable ?? "unknown"}`;
}

function variableSourceNode(source) {
  return `variables:${source ?? "unknown"}`;
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

function instanceTargetKeys(name) {
  const normalized = normalizeTargetName(name);
  return normalized ? [normalized] : [];
}

function actionTargetKeys(name) {
  const normalized = normalizeTargetName(name);
  const lastSegment = normalizeTargetName(String(name).split(".").pop() ?? "");
  return [...new Set([normalized, lastSegment].filter(Boolean))];
}

function normalizeTargetName(name) {
  return String(name).replace(/^_root\./, "").replace(/^_parent\./, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function buildReport(swfPath, scene) {
  const movie = parseSwf(readFileSync(swfPath));
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
    rootFrameActions: root.frameActions,
    spriteFrameActions: sprites.flatMap((spriteInfo) =>
      spriteInfo.frameActions.map((action) => ({ spriteId: spriteInfo.spriteId, ...action })),
    ),
    sprites,
    buttons,
    clickableRegions,
  };
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

function disassembleAvm1(bytes) {
  const actions = [];
  const pool = [];
  let offset = 0;

  while (offset < bytes.length) {
    const actionOffset = offset;
    const code = bytes[offset++];
    if (code === 0) {
      actions.push({ offset: actionOffset, op: "End" });
      break;
    }

    let body = new Uint8Array();
    if (code >= 0x80) {
      if (offset + 2 > bytes.length) {
        actions.push({ offset: actionOffset, op: `Action${hexByte(code)}`, malformed: true });
        break;
      }
      const length = bytes[offset] | (bytes[offset + 1] << 8);
      offset += 2;
      body = bytes.slice(offset, offset + length);
      offset += length;
    }

    actions.push(decodeAvm1Action(code, body, actionOffset, pool));
  }

  return actions;
}

function decodeAvm1Action(code, body, offset, pool) {
  switch (code) {
    case 0x04:
      return { offset, op: "NextFrame" };
    case 0x05:
      return { offset, op: "PreviousFrame" };
    case 0x06:
      return { offset, op: "Play" };
    case 0x07:
      return { offset, op: "Stop" };
    case 0x17:
      return { offset, op: "Pop" };
    case 0x1c:
      return { offset, op: "GetVariable" };
    case 0x1d:
      return { offset, op: "SetVariable" };
    case 0x3d:
      return { offset, op: "CallFunction" };
    case 0x4e:
      return { offset, op: "GetMember" };
    case 0x52:
      return { offset, op: "CallMethod" };
    case 0x81:
      return { offset, op: "GotoFrame", frame: readU16(body, 0) };
    case 0x83:
      return { offset, op: "GetUrl", url: readCString(body, 0), target: readCString(body, readCString(body, 0).length + 1) };
    case 0x87:
      return { offset, op: "StoreRegister", register: body[0] };
    case 0x88: {
      pool.length = 0;
      const count = readU16(body, 0);
      let cursor = 2;
      for (let i = 0; i < count; i += 1) {
        const value = readCString(body, cursor);
        pool.push(value);
        cursor += value.length + 1;
      }
      return { offset, op: "ConstantPool", values: pool.slice() };
    }
    case 0x8a:
      return { offset, op: "WaitForFrame", frame: readU16(body, 0), skipCount: body[2] };
    case 0x8b:
      return { offset, op: "SetTarget", target: readCString(body, 0) };
    case 0x8c:
      return { offset, op: "GoToLabel", label: readCString(body, 0) };
    case 0x96:
      return { offset, op: "Push", values: decodePushValues(body, pool) };
    case 0x99:
      return { offset, op: "Jump", branchOffset: readS16(body, 0) };
    case 0x9d:
      return { offset, op: "If", branchOffset: readS16(body, 0) };
    case 0x9f:
      return { offset, op: "GotoFrame2", play: (body[0] & 1) !== 0, sceneBiasFlag: (body[0] & 2) !== 0, sceneBias: body.length >= 3 ? readU16(body, 1) : undefined };
    default:
      return { offset, op: actionName(code), actionCode: code, actionBytes: bytesToHex(body) };
  }
}

function decodePushValues(body, pool) {
  const values = [];
  let cursor = 0;

  while (cursor < body.length) {
    const type = body[cursor++];
    if (type === 0) {
      const value = readCString(body, cursor);
      values.push({ type: "string", value });
      cursor += value.length + 1;
    } else if (type === 1) {
      values.push({ type: "float", value: new DataView(body.buffer, body.byteOffset + cursor, 4).getFloat32(0, true) });
      cursor += 4;
    } else if (type === 4) {
      values.push({ type: "register", value: body[cursor++] });
    } else if (type === 5) {
      values.push({ type: "boolean", value: body[cursor++] !== 0 });
    } else if (type === 6) {
      values.push({ type: "double", value: new DataView(body.buffer, body.byteOffset + cursor, 8).getFloat64(0, true) });
      cursor += 8;
    } else if (type === 7) {
      values.push({ type: "integer", value: readU32(body, cursor) });
      cursor += 4;
    } else if (type === 8) {
      const index = body[cursor++];
      values.push({ type: "constant8", index, value: pool[index] });
    } else if (type === 9) {
      const index = readU16(body, cursor);
      values.push({ type: "constant16", index, value: pool[index] });
      cursor += 2;
    } else {
      values.push({ type: `unknown:${type}` });
      break;
    }
  }

  return values;
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

function matrixFromParser(matrix) {
  return {
    a: fixedPointValue(matrix.scaleX),
    b: fixedPointValue(matrix.rotateSkew1),
    c: fixedPointValue(matrix.rotateSkew0),
    d: fixedPointValue(matrix.scaleY),
    tx: matrix.translateX / 20,
    ty: matrix.translateY / 20,
  };
}

function fixedPointValue(value) {
  if (typeof value?.toValue === "function") return value.toValue();
  if (typeof value?.epsilons === "number") return value.epsilons / 65536;
  return Number(value) || 0;
}

function readU16(bytes, offset) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readS16(bytes, offset) {
  const value = readU16(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function readU32(bytes, offset) {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
}

function readCString(bytes, offset) {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  return Buffer.from(bytes.slice(offset, end)).toString("utf8");
}

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function hexByte(code) {
  return `0x${code.toString(16).padStart(2, "0")}`;
}

function actionName(code) {
  const names = {
    0x0a: "Add",
    0x0b: "Subtract",
    0x0c: "Multiply",
    0x0d: "Divide",
    0x0e: "Equals",
    0x0f: "Less",
    0x10: "And",
    0x11: "Or",
    0x12: "Not",
    0x13: "StringEquals",
    0x14: "StringLength",
    0x21: "StringAdd",
    0x22: "GetProperty",
    0x23: "SetProperty",
    0x24: "CloneSprite",
    0x25: "RemoveSprite",
    0x26: "Trace",
    0x27: "StartDrag",
    0x28: "EndDrag",
    0x29: "StringLess",
    0x2a: "Throw",
    0x2b: "CastOp",
    0x2c: "ImplementsOp",
    0x30: "RandomNumber",
    0x31: "MbStringLength",
    0x32: "CharToAscii",
    0x33: "AsciiToChar",
    0x34: "GetTime",
    0x35: "MbStringExtract",
    0x36: "MbCharToAscii",
    0x37: "MbAsciiToChar",
    0x3a: "Delete",
    0x3b: "Delete2",
    0x3c: "DefineLocal",
    0x3e: "Return",
    0x3f: "Modulo",
    0x40: "NewObject",
    0x41: "DefineLocal2",
    0x42: "InitArray",
    0x43: "InitObject",
    0x44: "TypeOf",
    0x45: "TargetPath",
    0x46: "Enumerate",
    0x47: "Add2",
    0x48: "Less2",
    0x49: "Equals2",
    0x4a: "ToNumber",
    0x4b: "ToString",
    0x4c: "PushDuplicate",
    0x4d: "StackSwap",
    0x4f: "SetMember",
    0x50: "Increment",
    0x51: "Decrement",
    0x53: "NewMethod",
    0x54: "InstanceOf",
    0x55: "Enumerate2",
    0x60: "BitAnd",
    0x61: "BitOr",
    0x62: "BitXor",
    0x63: "BitLShift",
    0x64: "BitRShift",
    0x65: "BitURShift",
    0x66: "StrictEquals",
    0x67: "Greater",
    0x68: "StringGreater",
    0x69: "Extends",
    0x8e: "DefineFunction2",
    0x8f: "Try",
    0x94: "With",
    0x9b: "DefineFunction",
  };
  return names[code] ?? `Action${hexByte(code)}`;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
