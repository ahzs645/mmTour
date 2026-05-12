import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const scenes = ["A-tour", "intro", "nav", "segment1", "segment2", "segment3", "segment4", "segment5"];
const expectedTools = [
  { name: "FFDec", commands: [["java", ["-jar", "tools/ffdec-runtime/ffdec_26.0.0/ffdec-cli.jar", "-version"]], ["tools/ffdec-runtime/ffdec_26.0.0/ffdec", ["-version"]]] },
  { name: "Flasm", commands: [["tools/flasm-bin/flasm", []], ["flasm", ["-h"]]] },
  { name: "SWFTools swfdump", commands: [["swfdump", ["--help"]]] },
  { name: "SWFTools swfextract", commands: [["swfextract", ["--help"]]] },
  { name: "swfmill", commands: [["swfmill", ["--help"]]] },
  { name: "RABCDAsm", commands: [["rabcdasm", []], ["rabcasm", []]] },
];

const strictTools = process.argv.includes("--strict-tools");
const failures = [];
const warnings = [];
const sceneReports = [];
const toolReport = expectedTools.map(checkTool);
const referenceDocs = verifyReferenceDocs();

for (const scene of scenes) {
  const sceneReport = verifyScene(scene);
  sceneReports.push(sceneReport);
}

for (const tool of toolReport) {
  const message = `${tool.name}: ${tool.available ? `available via ${tool.command}` : "not available on PATH/local runtime"}`;
  if (tool.available) continue;
  if (tool.name === "RABCDAsm" && sceneReports.every((scene) => scene.avmKind !== "AVM2")) {
    warnings.push(`${message}; skipped because all bundled SWFs are AVM1.`);
  } else if (strictTools) {
    failures.push(message);
  } else {
    warnings.push(message);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  scenes: sceneReports,
  tools: toolReport,
  referenceDocs,
  warnings,
  failures,
};

writeFileSync(join(root, "public/generated/verification-report.json"), `${JSON.stringify(report, null, 2)}\n`);

for (const scene of sceneReports) {
  console.log(`${scene.scene}: ${scene.avmKind}, frames=${scene.frames.timeline}, stops=${scene.stopFrames}, labels=${scene.labels}, buttons=${scene.buttons}, hitAreas=${scene.hitAreas}`);
}

for (const warning of warnings) {
  console.warn(`warning: ${warning}`);
}

if (failures.length) {
  for (const failure of failures) console.error(`error: ${failure}`);
  process.exit(1);
}

console.log(`Verified ${sceneReports.length} SWF conversion artifact sets. Wrote public/generated/verification-report.json`);

function verifyReferenceDocs() {
  const openflPath = join(root, "docs/openfl-swf-reference.md");
  const report = {
    openflSwf: {
      path: "docs/openfl-swf-reference.md",
      exists: existsSync(openflPath),
      coveredTerms: [],
    },
  };

  if (!report.openflSwf.exists) {
    failures.push("OpenFL SWF reference notes missing at docs/openfl-swf-reference.md");
    return report;
  }

  const content = readFileSync(openflPath, "utf8");
  const requiredTerms = [
    "MovieClip",
    "SimpleButton",
    "masks",
    "filters",
    "blend modes",
    "buttonDefinitions",
    "clickableRegions",
    "nestedMovieClips",
  ];

  report.openflSwf.coveredTerms = requiredTerms.filter((term) => content.includes(term));
  for (const term of requiredTerms) {
    if (!content.includes(term)) failures.push(`OpenFL SWF reference notes missing required term: ${term}`);
  }

  return report;
}

function verifyScene(scene) {
  const swfPath = sourceSwfPath(scene);
  const extractedDir = join(root, "extracted", scene);
  const generatedDir = join(root, "public/generated", scene);
  const timelinePath = join(generatedDir, "timeline.json");
  const controlPath = join(generatedDir, "control-flow.json");
  const parserPath = join(generatedDir, "swf-parser-report.json");
  const xmlPath = join(extractedDir, `${scene}.xml`);

  assertExists(swfPath, `${scene}: source SWF`);
  assertExists(xmlPath, `${scene}: FFDec XML`);
  assertExists(join(extractedDir, "frames"), `${scene}: FFDec frame SVG directory`);
  assertExists(timelinePath, `${scene}: generated timeline.json`);
  assertExists(controlPath, `${scene}: generated control-flow.json`);
  assertExists(parserPath, `${scene}: generated swf-parser-report.json`);
  if (isToolAvailable("Flasm")) assertExists(join(generatedDir, "secondary/flasm.flm"), `${scene}: Flasm disassembly`);
  if (isToolAvailable("SWFTools swfdump")) assertExists(join(generatedDir, "secondary/swfdump.txt"), `${scene}: SWFTools swfdump report`);
  if (isToolAvailable("SWFTools swfextract")) assertExists(join(generatedDir, "secondary/swfextract.txt"), `${scene}: SWFTools swfextract report`);
  if (isToolAvailable("swfmill")) assertExists(join(generatedDir, "secondary/swfmill.xml"), `${scene}: swfmill XML report`);

  const timeline = json(timelinePath);
  const control = json(controlPath);
  const parser = json(parserPath);
  const tagCounts = parser.secondaryValidation?.tagCounts ?? {};

  const extractedFrameCount = countFrameSvgs(join(extractedDir, "frames"));
  const publicFrameCount = timeline.frameSvgs?.length ?? 0;
  const parserFrameCount = parser.header?.frameCount;
  const timelineFrameCount = timeline.frameCount;

  assertEqual(scene, "timeline.frameCount vs Open Flash header.frameCount", timelineFrameCount, parserFrameCount);
  assertEqual(scene, "timeline.frameSvgs length vs timeline.frameCount", publicFrameCount, timelineFrameCount);
  assertEqual(scene, "FFDec extracted frame SVG count vs timeline.frameCount", extractedFrameCount, timelineFrameCount);
  assertEqual(scene, "control-flow frameCount vs timeline.frameCount", control.frameCount, timelineFrameCount);
  assertEqual(scene, "control-flow AVM kind vs parser report AVM kind", control.avm?.kind, parser.avm?.kind);

  if (parser.avm?.kind === "AVM2" && !parser.avm?.needsRabcdasm) {
    failures.push(`${scene}: AVM2 detected but needsRabcdasm is not true`);
  }
  if (parser.avm?.kind !== "AVM2" && parser.avm?.needsRabcdasm) {
    failures.push(`${scene}: RABCDAsm requested for non-AVM2 file`);
  }
  if (!Array.isArray(control.bytecodeFrameActions)) failures.push(`${scene}: missing bytecodeFrameActions`);
  if (!Array.isArray(control.bytecodeSpriteActions)) failures.push(`${scene}: missing bytecodeSpriteActions`);
  if (!Array.isArray(control.buttonDefinitions)) failures.push(`${scene}: missing buttonDefinitions`);
  if (!Array.isArray(control.autoPlayRanges)) failures.push(`${scene}: missing autoPlayRanges`);
  if (!Array.isArray(control.clickableRegions)) failures.push(`${scene}: missing clickableRegions`);
  if (!Array.isArray(control.definedFunctions)) failures.push(`${scene}: missing definedFunctions`);
  verifyControlFlowGraphs(scene, control, timeline);
  if (!timeline.control?.avm) failures.push(`${scene}: timeline.control.avm missing`);
  if (!Array.isArray(timeline.control?.buttonDefinitions)) failures.push(`${scene}: timeline.control.buttonDefinitions missing`);
  if (!Array.isArray(timeline.control?.autoPlayRanges)) failures.push(`${scene}: timeline.control.autoPlayRanges missing`);
  if (!Array.isArray(timeline.control?.clickableRegions)) failures.push(`${scene}: timeline.control.clickableRegions missing`);
  if (!Array.isArray(timeline.control?.nestedMovieClips)) failures.push(`${scene}: timeline.control.nestedMovieClips missing`);
  if (!Array.isArray(timeline.control?.definedFunctions)) failures.push(`${scene}: timeline.control.definedFunctions missing`);
  if (!control.secondaryValidation?.tagCounts) failures.push(`${scene}: secondaryValidation.tagCounts missing`);
  if (tagCounts.DefineSound > 0) {
    assertNonEmptyDir(join(extractedDir, "sounds"), `${scene}: FFDec exported sounds`);
    assertNonEmptyDir(join(generatedDir, "sounds"), `${scene}: generated sounds`);
    if (!hasAssetKind(timeline, "sound")) failures.push(`${scene}: timeline assets missing sound entries`);
    if (!control.soundLibrary || !Object.keys(control.soundLibrary).length) failures.push(`${scene}: control-flow soundLibrary missing`);
    if (!timeline.control?.soundLibrary || !Object.keys(timeline.control.soundLibrary).length) failures.push(`${scene}: timeline.control.soundLibrary missing`);
  }
  if (tagCounts.DefineFont > 0 || tagCounts.DefineFont2 > 0 || tagCounts.DefineFont3 > 0 || tagCounts.DefineFont4 > 0) {
    assertNonEmptyDir(join(extractedDir, "fonts"), `${scene}: FFDec exported fonts`);
    assertNonEmptyDir(join(generatedDir, "fonts"), `${scene}: generated fonts`);
    if (!hasAssetKind(timeline, "font")) failures.push(`${scene}: timeline assets missing font entries`);
  }
  if ((tagCounts.DefineButton ?? 0) > 0 || (tagCounts.DefineButton2 ?? 0) > 0) {
    assertNonEmptyDir(join(extractedDir, "buttons"), `${scene}: FFDec exported button SVGs`);
    assertNonEmptyDir(join(generatedDir, "buttons"), `${scene}: generated button SVGs`);
    if (!hasAssetKind(timeline, "button")) failures.push(`${scene}: timeline assets missing button entries`);
  }

  const parserButtonCount = parser.buttons?.length ?? 0;
  const controlButtonCount = control.buttonDefinitions?.length ?? 0;
  const timelineButtonCount = timeline.control?.buttonDefinitions?.length ?? 0;
  const timelineButtonAssets = Object.values(timeline.assets ?? {}).filter((asset) => asset?.kind === "button");
  assertEqual(scene, "control buttonDefinitions vs parser buttons", controlButtonCount, parserButtonCount);
  assertEqual(scene, "timeline control buttonDefinitions vs parser buttons", timelineButtonCount, parserButtonCount);
  assertEqual(scene, "control nestedSectionTargets vs timeline control nestedSectionTargets", Object.keys(control.nestedSectionTargets ?? {}).length, Object.keys(timeline.control?.nestedSectionTargets ?? {}).length);
  assertEqual(scene, "control nestedMovieClips vs timeline control nestedMovieClips", control.nestedMovieClips?.length ?? 0, timeline.control?.nestedMovieClips?.length ?? 0);
  assertEqual(scene, "control definedFunctions vs timeline control definedFunctions", control.definedFunctions?.length ?? 0, timeline.control?.definedFunctions?.length ?? 0);
  verifyDefinedFunctions(scene, control);
  assertEqual(scene, "control externalMovieLevelActions vs timeline control externalMovieLevelActions", control.externalMovieLevelActions?.length ?? 0, timeline.control?.externalMovieLevelActions?.length ?? 0);
  verifyExternalMovieLevelActions(scene, control, timeline);
  if (parserButtonCount > 0) {
    assertEqual(scene, "timeline button assets vs parser buttons", timelineButtonAssets.length, parserButtonCount);
    for (const asset of timelineButtonAssets) {
      for (const state of ["up", "over", "down", "hittest"]) {
        if (!asset.states?.[state]?.src) failures.push(`${scene}: button ${asset.id} missing ${state} state SVG reference`);
      }
    }
  }

  const soundActions = [...(control.frameActions ?? []), ...(control.spriteActions ?? [])]
    .flatMap((entry) => entry.actions ?? [])
    .filter((action) => ["playVO", "attachSound", "markSndSegment", "stopSound"].includes(action.command));
  const playableSoundActions = soundActions.filter((action) => action.command === "playVO" || action.command === "attachSound");
  for (const action of playableSoundActions.filter((action) => action.supported && !action.soundSrc)) {
    failures.push(`${scene}: supported ${action.command} ${action.sound} missing soundSrc`);
  }
  const globalDefaults = timeline.control?.globalDefaults ?? control.globalDefaults ?? {};
  if (globalDefaults["bkgd.OSVersion"] !== "Pro") {
    failures.push(`${scene}: generated globalDefaults missing root bkgd.OSVersion=Pro`);
  }
  const spriteLocalDefaults = timeline.control?.spriteLocalDefaults ?? control.spriteLocalDefaults ?? {};
  if (scene === "segment1" && spriteLocalDefaults["116"]?.isFaded !== 0) {
    failures.push(`${scene}: generated spriteLocalDefaults missing DefineSprite_116 isFaded=0`);
  }
  const functionScopedUnsupportedSoundActions = soundActions.filter((action) => action.supported === false && isFunctionScopedAction(action));
  const branchScopedUnsupportedSoundActions = soundActions.filter((action) => action.supported === false && isBranchScopedAction(action));
  const timelineUnsupportedSoundActions = soundActions.filter((action) => action.supported === false && isImmediateTimelineAction(action));

  const nestedSelfActions = (control.spriteActions ?? [])
    .flatMap((entry) => (entry.actions ?? []).map((action) => ({ ...action, spriteId: entry.spriteId, frame: entry.frame })))
    .filter((action) => action.target === "self" && (action.command === "gotoAndPlay" || action.command === "gotoAndStop"));
  for (const action of nestedSelfActions) {
    const hasTarget = typeof action.frame === "number" || typeof action.frameExpression === "string" || typeof action.label === "string";
    if (!hasTarget) failures.push(`${scene}: nested sprite ${action.spriteId} frame ${action.frame} ${action.command} missing target`);
  }
  const unsupportedGotoActions = [...(control.frameActions ?? []), ...(control.spriteActions ?? [])]
    .flatMap((entry) => (entry.actions ?? []).map((action) => ({ ...action, ownerFrame: entry.frame, spriteId: entry.spriteId })))
    .filter((action) => (action.command === "gotoAndPlay" || action.command === "gotoAndStop") && action.supported === false);
  const functionScopedUnsupportedGotoActions = unsupportedGotoActions.filter(isFunctionScopedAction);
  const branchScopedUnsupportedGotoActions = unsupportedGotoActions.filter(isBranchScopedAction);
  const timelineUnsupportedGotoActions = unsupportedGotoActions.filter(isImmediateTimelineAction);
  if (branchScopedUnsupportedGotoActions.length > 0) {
    failures.push(`${scene}: ${branchScopedUnsupportedGotoActions.length} branch-scoped goto actions remain unsupported`);
  }
  const nestedTargetPlacementActions = [...(control.frameActions ?? []), ...(control.spriteActions ?? [])]
    .flatMap((entry) => (entry.actions ?? []).map((action) => ({ ...action, ownerFrame: entry.frame, spriteId: entry.spriteId })))
    .filter((action) => action.targetPlacement);
  const unsupportedAddressableGotoActions = timelineUnsupportedGotoActions.filter((action) => (
    isAddressableRootGoto(action, timeline) || isAddressableNestedTargetGoto(action, timeline)
  ));
  for (const action of unsupportedAddressableGotoActions) {
    failures.push(`${scene}: addressable goto ${action.target}.${action.command} at frame ${action.ownerFrame} is still marked unsupported`);
  }
  const exitNavigationActions = Object.values(control.buttonActions ?? {})
    .map((group) => group.release)
    .filter((release) => release?.exitNavigation);
  for (const action of exitNavigationActions) {
    if (!action.swf || !Number.isFinite(action.exitNavigation?.exitFrame)) {
      failures.push(`${scene}: exit navigation action in ${action.source} missing swf or exit frame`);
    }
  }
  const functionCallButtonActions = Object.values(control.buttonActions ?? {})
    .map((group) => group.release)
    .filter((release) => release?.functionCalls?.length);
  for (const action of functionCallButtonActions) {
    for (const call of action.functionCalls ?? []) {
      if (!call.target || !call.functionName) failures.push(`${scene}: function call action in ${action.source} missing target/functionName`);
    }
  }
  const rootFunctionNavigationActions = [
    ...Object.values(control.buttonActions ?? {}).map((group) => group.release),
    ...(control.frameActions ?? []).flatMap((entry) => entry.actions ?? []),
    ...(control.spriteActions ?? []).flatMap((entry) => entry.actions ?? []),
  ].filter((action) => action?.rootFunctionNavigation);
  for (const action of rootFunctionNavigationActions) {
    const navigation = action.rootFunctionNavigation;
    if (!navigation.functionName || !navigation.swf || !navigation.sourceFunction) {
      failures.push(`${scene}: root function navigation in ${action.source} missing functionName/swf/sourceFunction`);
      continue;
    }
    if (!rootFunctionBodyContainsLoad(navigation.functionName, navigation.swf)) {
      failures.push(`${scene}: root function navigation ${navigation.functionName} -> ${navigation.swf} is not backed by A-tour source`);
    }
  }
  const rootFunctionSoundActions = [...(control.frameActions ?? []), ...(control.spriteActions ?? [])]
    .flatMap((entry) => entry.actions ?? [])
    .filter((action) => action.rootFunctionSound);
  for (const action of rootFunctionSoundActions) {
    const sound = action.rootFunctionSound;
    if (!sound.functionName || !sound.sound || !sound.soundSrc || !sound.sourceFunction) {
      failures.push(`${scene}: root function sound in ${action.source} missing functionName/sound/sourceFunction`);
      continue;
    }
    if (!rootFunctionBodyContainsSound(sound.functionName, sound.sound)) {
      failures.push(`${scene}: root function sound ${sound.functionName} -> ${sound.sound} is not backed by A-tour source`);
    }
    if (action.soundSrc !== sound.soundSrc) failures.push(`${scene}: root function sound ${sound.sound} has mismatched action soundSrc`);
  }
  const calledButtonFunctionNames = calledFunctionNames(control);
  const invokedByButtonFunctionActions = [...(control.frameActions ?? []), ...(control.spriteActions ?? [])]
    .flatMap((entry) => (entry.actions ?? []).map((action) => ({ ...action, spriteId: entry.spriteId, ownerFrame: entry.frame })))
    .filter((action) => action.invokedByButtonFunction);
  for (const action of invokedByButtonFunctionActions) {
    if (action.supported !== true) failures.push(`${scene}: invoked button function ${action.functionName} on sprite ${action.spriteId} is not marked supported`);
    if (!calledButtonFunctionNames.has(action.functionName)) failures.push(`${scene}: invokedByButtonFunction ${action.functionName} has no extracted button caller`);
    const executableGoto = (action.command === "gotoAndPlay" || action.command === "gotoAndStop") && action.target === "self";
    const executableTargetGoto = (action.command === "gotoAndPlay" || action.command === "gotoAndStop") && action.target && !/^_level\d+/i.test(action.target);
    const executableSound = (action.command === "playVO" || action.command === "attachSound") && action.soundSrc;
    const executableSoundStop = action.command === "stopSound";
    const executableFunctionCall = action.command === "callFunctions" && action.functionCalls?.length;
    if (!executableGoto && !executableTargetGoto && !executableSound && !executableSoundStop && !executableFunctionCall) failures.push(`${scene}: invoked button function ${action.functionName} command ${action.command} is outside runtime-supported function scope`);
  }
  const expectedCallableFunctionActions = expectedButtonCallableFunctionActions(control, calledButtonFunctionNames);
  if (invokedByButtonFunctionActions.length < expectedCallableFunctionActions.length) {
    failures.push(`${scene}: ${expectedCallableFunctionActions.length - invokedByButtonFunctionActions.length} button-callable function actions were not marked invokedByButtonFunction`);
  }
  const unsupportedActions = [...(control.frameActions ?? []), ...(control.spriteActions ?? [])]
    .flatMap((entry) => (entry.actions ?? []).map((action) => ({ ...action, ownerFrame: entry.frame, spriteId: entry.spriteId })))
    .filter((action) => action.supported === false);
  const unsupportedActionCategories = categorizeUnsupportedActions(unsupportedActions);
  if (unsupportedActionCategories.immediateNavigation > 0) {
    failures.push(`${scene}: ${unsupportedActionCategories.immediateNavigation} immediate unsupported navigation actions remain`);
  }
  if (unsupportedActionCategories.missingSoundExport > 0) {
    failures.push(`${scene}: ${unsupportedActionCategories.missingSoundExport} referenced sound actions have no matching FFDec sound export`);
  }
  const missingVariableLoads = unsupportedActions.filter((action) => action.command === "loadVariables");
  for (const action of missingVariableLoads) {
    failures.push(`${scene}: missing variable source ${action.target}`);
  }
  const supportedVariableLoads = [...(control.frameActions ?? []), ...(control.spriteActions ?? [])]
    .flatMap((entry) => entry.actions ?? [])
    .filter((action) => action.command === "loadVariables" && action.supported);
  for (const action of supportedVariableLoads) {
    if (!action.variableSource) failures.push(`${scene}: supported variable load ${action.target} missing resolved variableSource`);
  }
  const functionBodyCoverage = summarizeFunctionBodyCoverage(control);

  return {
    scene,
    source: `${scene}.swf`,
    avmKind: parser.avm?.kind,
    needsRabcdasm: Boolean(parser.avm?.needsRabcdasm),
    frames: {
      swfParser: parserFrameCount,
      ffdec: extractedFrameCount,
      timeline: timelineFrameCount,
      frameSvgs: publicFrameCount,
    },
    labels: Object.keys(control.labels ?? {}).length,
    stopFrames: control.stopFrames?.length ?? 0,
    autoPlayRanges: control.autoPlayRanges?.length ?? 0,
    rootActions: control.bytecodeFrameActions?.length ?? 0,
    spriteActions: control.bytecodeSpriteActions?.length ?? 0,
    definedFunctions: control.definedFunctions?.length ?? 0,
    functionDefinitionsWithAssignments: functionBodyCoverage.withAssignments,
    functionDefinitionsWithCalls: functionBodyCoverage.withCalls,
    functionDefinitionsWithBodyMetadata: functionBodyCoverage.withBodyMetadata,
    functionDefinitionsWithoutBodyMetadata: functionBodyCoverage.withoutBodyMetadata,
    soundLibrary: Object.keys(control.soundLibrary ?? {}).length,
    globalDefaults: Object.keys(globalDefaults).length,
    spriteLocalDefaults: Object.keys(spriteLocalDefaults).length,
    soundActions: soundActions.length,
    unsupportedSoundActions: soundActions.filter((action) => action.supported === false).length,
    functionScopedUnsupportedSoundActions: functionScopedUnsupportedSoundActions.length,
    branchScopedUnsupportedSoundActions: branchScopedUnsupportedSoundActions.length,
    timelineUnsupportedSoundActions: timelineUnsupportedSoundActions.length,
    nestedSelfActions: nestedSelfActions.length,
    exitNavigationActions: exitNavigationActions.length,
    functionCallButtonActions: functionCallButtonActions.length,
    rootFunctionNavigationActions: rootFunctionNavigationActions.length,
    rootFunctionSoundActions: rootFunctionSoundActions.length,
    unsupportedGotoActions: unsupportedGotoActions.length,
    functionScopedUnsupportedGotoActions: functionScopedUnsupportedGotoActions.length,
    branchScopedUnsupportedGotoActions: branchScopedUnsupportedGotoActions.length,
    timelineUnsupportedGotoActions: timelineUnsupportedGotoActions.length,
    unsupportedAddressableGotoActions: unsupportedAddressableGotoActions.length,
    nestedTargetPlacementActions: nestedTargetPlacementActions.length,
    invokedByButtonFunctionActions: invokedByButtonFunctionActions.length,
    unsupportedActionCategories,
    missingVariableLoads: missingVariableLoads.map((action) => action.target),
    buttons: controlButtonCount,
    hitAreas: (control.buttonDefinitions ?? []).reduce((total, button) => total + (button.hitAreas?.length ?? 0), 0),
    clickableRegions: control.clickableRegions?.length ?? 0,
    externalMovieLevelActions: control.externalMovieLevelActions?.length ?? 0,
    segmentNavigation: control.segmentNavigation ?? [],
  };
}

function sourceSwfPath(scene) {
  const rootPath = join(root, `${scene}.swf`);
  if (existsSync(rootPath)) return rootPath;
  return join(root, "public", `${scene}.swf`);
}

function verifyExternalMovieLevelActions(scene, control, timeline) {
  const actions = control.externalMovieLevelActions;
  if (actions === undefined) return;
  if (!Array.isArray(actions)) {
    failures.push(`${scene}: externalMovieLevelActions is not an array`);
    return;
  }

  const timelineActions = timeline.control?.externalMovieLevelActions ?? [];
  const controlKeys = new Set(actions.map(externalMovieLevelActionKey));
  const timelineKeys = new Set(timelineActions.map(externalMovieLevelActionKey));
  for (const key of controlKeys) {
    if (!timelineKeys.has(key)) failures.push(`${scene}: externalMovieLevelAction missing from timeline control: ${key}`);
  }

  const sourceKeys = collectLevelActionSourceKeys(control);
  for (const action of actions) {
    if (!Number.isInteger(action.level) || action.level <= 0) {
      failures.push(`${scene}: external movie action has invalid level ${action.level}`);
    }
    if (!action.target || !String(action.target).startsWith(`_level${action.level}`)) {
      failures.push(`${scene}: external movie action target ${action.target} does not match level ${action.level}`);
    }
    if (!action.command) {
      failures.push(`${scene}: external movie action ${action.target} missing command`);
    }
    if (action.command === "callFunction" && !action.calledFunctionName) {
      failures.push(`${scene}: external movie call ${action.target} missing calledFunctionName`);
    }
    if (action.swf && !String(action.swf).endsWith(".swf")) {
      failures.push(`${scene}: external movie action ${action.target} has invalid swf ${action.swf}`);
    }
    for (const candidate of action.swfCandidates ?? []) {
      if (!String(candidate).endsWith(".swf")) failures.push(`${scene}: external movie action ${action.target} has invalid swfCandidate ${candidate}`);
    }
    if (action.swf && action.swfCandidates?.length) {
      failures.push(`${scene}: external movie action ${action.target} has both swf and swfCandidates`);
    }
    if (!sourceKeys.has(externalMovieLevelActionSourceKey(action))) {
      failures.push(`${scene}: external movie action ${action.target}.${action.calledFunctionName ?? action.command} is not backed by extracted control action`);
    }
    verifyExternalMovieTarget(scene, action);
  }
}

function verifyDefinedFunctions(scene, control) {
  const definitions = control.definedFunctions ?? [];
  const seen = new Set();
  for (const definition of definitions) {
    if (!definition.functionName) failures.push(`${scene}: defined function missing functionName`);
    if (!definition.source) failures.push(`${scene}: defined function ${definition.functionName ?? "<unknown>"} missing source`);
    if (definition.scope !== "root" && definition.scope !== "sprite") {
      failures.push(`${scene}: defined function ${definition.functionName ?? "<unknown>"} has invalid scope ${definition.scope}`);
    }
    if (definition.scope === "sprite" && !Number.isInteger(definition.spriteId)) {
      failures.push(`${scene}: sprite defined function ${definition.functionName ?? "<unknown>"} missing spriteId`);
    }
    if (!Array.isArray(definition.parameters)) {
      failures.push(`${scene}: defined function ${definition.functionName ?? "<unknown>"} missing parameters array`);
    }
    if (definition.assignments !== undefined && !Array.isArray(definition.assignments)) {
      failures.push(`${scene}: defined function ${definition.functionName ?? "<unknown>"} assignments is not an array`);
    }
    if (definition.calls !== undefined && !Array.isArray(definition.calls)) {
      failures.push(`${scene}: defined function ${definition.functionName ?? "<unknown>"} calls is not an array`);
    }
    const key = `${definition.scope}:${definition.spriteId ?? "root"}:${definition.source}:${definition.functionName}`;
    if (seen.has(key)) failures.push(`${scene}: duplicate defined function ${key}`);
    seen.add(key);
  }
}

function verifyControlFlowGraphs(scene, control, timeline) {
  const graphs = control.controlFlowGraphs;
  const timelineGraphs = timeline.control?.controlFlowGraphs;
  if (!graphs) {
    failures.push(`${scene}: missing controlFlowGraphs`);
    return;
  }
  if (!timelineGraphs) failures.push(`${scene}: timeline.control.controlFlowGraphs missing`);
  if (graphs.schemaVersion !== 1) failures.push(`${scene}: controlFlowGraphs schemaVersion must be 1`);
  if (!Array.isArray(graphs.root?.nodes) || graphs.root.nodes.length !== control.frameCount) {
    failures.push(`${scene}: root control-flow graph node count does not match frame count`);
  }
  if (!Array.isArray(graphs.root?.edges)) failures.push(`${scene}: root control-flow graph edges missing`);
  if (!Array.isArray(graphs.sprites)) failures.push(`${scene}: sprite control-flow graphs missing`);
  if (!Array.isArray(graphs.functions)) failures.push(`${scene}: function control-flow graphs missing`);
  if (!Array.isArray(graphs.buttons)) failures.push(`${scene}: button control-flow graphs missing`);
  if ((control.definedFunctions?.length ?? 0) !== (graphs.functions?.length ?? 0)) {
    failures.push(`${scene}: function control-flow graph count does not match definedFunctions`);
  }
  if (Object.keys(control.buttonActions ?? {}).length > 0 && !graphs.buttons?.length) {
    failures.push(`${scene}: button actions exist but button control-flow graphs are empty`);
  }
  const actionEdgeCount = (graphs.root?.edges ?? []).filter((edge) => edge.command).length
    + (graphs.sprites ?? []).flatMap((graph) => graph.edges ?? []).filter((edge) => edge.command).length
    + (graphs.buttons ?? []).flatMap((graph) => graph.edges ?? []).filter((edge) => edge.command).length;
  const actionCount = [...(control.frameActions ?? []), ...(control.spriteActions ?? [])]
    .flatMap((entry) => entry.actions ?? [])
    .length
    + Object.values(control.buttonActions ?? {}).flatMap((group) => [group.release, group.rollOver, group.rollOut].filter(Boolean)).length;
  if (actionCount > 0 && actionEdgeCount <= 0) {
    failures.push(`${scene}: action metadata exists but controlFlowGraphs contain no action edges`);
  }
}

function summarizeFunctionBodyCoverage(control) {
  const definitions = control.definedFunctions ?? [];
  const withAssignments = definitions.filter((definition) => (definition.assignments?.length ?? 0) > 0).length;
  const withCalls = definitions.filter((definition) => (definition.calls?.length ?? 0) > 0).length;
  const withBodyMetadata = definitions.filter((definition) => (
    (definition.assignments?.length ?? 0) > 0 || (definition.calls?.length ?? 0) > 0
  )).length;
  return {
    withAssignments,
    withCalls,
    withBodyMetadata,
    withoutBodyMetadata: definitions.length - withBodyMetadata,
  };
}

function verifyExternalMovieTarget(scene, action) {
  if (action.command !== "callFunction" || !action.calledFunctionName) return;

  const candidates = action.swf ? [action.swf] : action.swfCandidates ?? [];
  if (!candidates.length) return;

  const resolved = candidates.filter((swfName) => {
    const targetControl = controlForSwf(swfName);
    if (!targetControl) return false;
    return controlFunctionNames(targetControl).has(action.calledFunctionName);
  });

  if (!resolved.length) {
    failures.push(`${scene}: external movie call ${action.target}.${action.calledFunctionName} does not resolve to any target SWF function in ${candidates.join(", ")}`);
    return;
  }

  const definitions = resolved.flatMap((swfName) => {
    const targetControl = controlForSwf(swfName);
    return targetControl ? targetFunctionDefinitions(targetControl, action.calledFunctionName) : [];
  });
  if (!definitions.length) return;

  const hasBodyMetadata = definitions.some((definition) => (
    (definition.assignments?.length ?? 0) > 0 || (definition.calls?.length ?? 0) > 0
  ));
  if (!hasBodyMetadata) {
    failures.push(`${scene}: external movie call ${action.target}.${action.calledFunctionName} resolves but has no extracted assignments/calls in ${resolved.join(", ")}`);
  }
}

function controlForSwf(swfName) {
  const sceneName = String(swfName).replace(/\.swf$/i, "");
  const path = join(root, "public/generated", sceneName, "control-flow.json");
  return existsSync(path) ? json(path) : undefined;
}

function controlFunctionNames(control) {
  return new Set(
    [
      ...(control.definedFunctions ?? []).map((definition) => definition.functionName),
      ...[...(control.frameActions ?? []), ...(control.spriteActions ?? [])]
        .flatMap((entry) => entry.actions ?? [])
        .flatMap((action) => [
        action.functionName,
        ...(action.functionCalls ?? []).map((call) => call.functionName),
        ]),
    ].filter(Boolean),
  );
}

function targetFunctionDefinitions(control, functionName) {
  return (control.definedFunctions ?? []).filter((definition) => definition.functionName === functionName);
}

function collectLevelActionSourceKeys(control) {
  const keys = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.target === "string" && /^_level[1-9]\d*(?:\.|$)/i.test(value.target) && typeof value.command === "string") {
      keys.add(externalMovieLevelActionSourceKey(value));
    }
    for (const call of value.functionCalls ?? []) {
      if (typeof call.target === "string" && /^_level[1-9]\d*(?:\.|$)/i.test(call.target)) {
        keys.add(externalMovieLevelActionSourceKey({
          ...value,
          target: call.target,
          command: "callFunction",
          calledFunctionName: call.functionName,
        }));
      }
    }
    const children = Array.isArray(value)
      ? value.map((child) => ["", child])
      : Object.entries(value);
    for (const [key, child] of children) {
      if (key === "externalMovieLevelActions") continue;
      visit(child);
    }
  };
  visit(control);
  return keys;
}

function externalMovieLevelActionSourceKey(action) {
  return [
    action.source ?? "",
    action.target ?? "",
    action.command ?? "",
    action.functionName ?? "",
    action.calledFunctionName ?? "",
  ].join("|");
}

function externalMovieLevelActionKey(action) {
  return [
    externalMovieLevelActionSourceKey(action),
    action.level ?? "",
    action.swf ?? "",
    (action.swfCandidates ?? []).join(","),
  ].join("|");
}

function checkTool(tool) {
  for (const [command, args] of tool.commands) {
    const result = spawnSync(command, args, { cwd: root, stdio: "ignore" });
    if (result.error?.code === "ENOENT") continue;
    return {
      name: tool.name,
      available: true,
      command: [command, ...args].join(" "),
      status: result.status,
    };
  }

  return {
    name: tool.name,
    available: false,
    command: "",
  };
}

function isToolAvailable(name) {
  return toolReport.find((tool) => tool.name === name)?.available ?? false;
}

function assertExists(path, label) {
  if (!existsSync(path)) failures.push(`${label} missing at ${path}`);
}

function assertNonEmptyDir(path, label) {
  assertExists(path, label);
  if (existsSync(path) && readdirSync(path).length === 0) failures.push(`${label} empty at ${path}`);
}

function assertEqual(scene, label, actual, expected) {
  if (actual !== expected) failures.push(`${scene}: ${label} mismatch: ${actual} !== ${expected}`);
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function countFrameSvgs(dir) {
  return readdirSync(dir).filter((file) => file.endsWith(".svg")).length;
}

function hasAssetKind(timeline, kind) {
  return Object.values(timeline.assets ?? {}).some((asset) => asset?.kind === kind);
}

function isAddressableRootGoto(action, timeline) {
  if (action.spriteId !== undefined) return false;
  if (!action.target || action.target === "self" || action.target === "_root" || action.target === "_parent") return false;

  const targetKeys = actionTargetKeys(action.target);
  const nestedMovieClipById = new Map((timeline.control?.nestedMovieClips ?? []).map((movieClip) => [movieClip.spriteId, movieClip]));
  const frames = (timeline.frames ?? []).slice(action.ownerFrame ?? 0);
  for (const frame of frames) {
    for (const instance of frame.instances ?? []) {
      if (!instanceTargetKeys(instance.name).some((key) => targetKeys.includes(key))) continue;
      const asset = timeline.assets?.[String(instance.characterId)];
      if (asset?.kind !== "sprite" || !asset.frames?.length) continue;
      if (typeof action.frame === "number") return true;
      if (typeof action.frameExpression === "string" && Number.isFinite(Number.parseInt(action.frameExpression, 10))) return true;
      if (typeof action.label === "string" && nestedMovieClipById.get(instance.characterId)?.labels?.[action.label] !== undefined) return true;
    }
  }
  return false;
}

function isAddressableNestedTargetGoto(action, timeline) {
  const characterId = action.targetPlacement?.characterId;
  if (!characterId) return false;

  const asset = timeline.assets?.[String(characterId)];
  if (asset?.kind !== "sprite" || !asset.frames?.length) return false;

  const nestedMovieClipById = new Map((timeline.control?.nestedMovieClips ?? []).map((movieClip) => [movieClip.spriteId, movieClip]));
  if (typeof action.frame === "number") return true;
  if (typeof action.frameExpression === "string" && Number.isFinite(Number.parseInt(action.frameExpression, 10))) return true;
  if (typeof action.label === "string" && nestedMovieClipById.get(characterId)?.labels?.[action.label] !== undefined) return true;
  return false;
}

function isFunctionScopedAction(action) {
  return action.executionContext === "function" || Boolean(action.functionName);
}

function isBranchScopedAction(action) {
  return action.executionContext === "branch" || Boolean(action.branchCondition);
}

function isImmediateTimelineAction(action) {
  return !isFunctionScopedAction(action) && !isBranchScopedAction(action);
}

function calledFunctionNames(control) {
  const names = new Set();
  for (const group of Object.values(control.buttonActions ?? {})) {
    for (const eventName of ["release", "rollOver", "rollOut"]) {
      for (const call of group[eventName]?.functionCalls ?? []) {
        if (call.functionName) names.add(call.functionName);
      }
    }
  }
  for (const entry of [...(control.frameActions ?? []), ...(control.spriteActions ?? [])]) {
    for (const action of entry.actions ?? []) {
      for (const call of action.functionCalls ?? []) {
        if (call.functionName) names.add(call.functionName);
      }
    }
  }
  return names;
}

function expectedButtonCallableFunctionActions(control, calledNames) {
  if (!calledNames.size) return [];
  return [...(control.frameActions ?? []), ...(control.spriteActions ?? [])]
    .flatMap((entry) => (entry.actions ?? []).map((action) => ({ ...action, spriteId: entry.spriteId, ownerFrame: entry.frame })))
    .filter((action) => {
      if (action.executionContext !== "function" || !calledNames.has(action.functionName)) return false;
      const executableGoto = (action.command === "gotoAndPlay" || action.command === "gotoAndStop") && action.target === "self";
      const executableTargetGoto = (action.command === "gotoAndPlay" || action.command === "gotoAndStop") && action.target && !/^_level\d+/i.test(action.target);
      const hasGotoTarget = typeof action.frame === "number" || typeof action.frameExpression === "string" || typeof action.label === "string";
      const executableSound = (action.command === "playVO" || action.command === "attachSound") && action.soundSrc;
      const executableSoundStop = action.command === "stopSound";
      const executableFunctionCall = action.command === "callFunctions" && action.functionCalls?.length;
      return ((executableGoto || executableTargetGoto) && hasGotoTarget) || executableSound || executableSoundStop || executableFunctionCall;
    });
}

function rootFunctionBodyContainsLoad(functionName, swf) {
  const sourcePath = join(root, "extracted", "A-tour", "scripts", "frame_1", "DoAction.as");
  if (!existsSync(sourcePath)) return false;

  const source = readFileSync(sourcePath, "utf8");
  const match = source.match(new RegExp(`function\\s+${escapeRegExp(functionName)}\\s*\\([^)]*\\)\\s*\\{`));
  if (!match) return false;

  const bodyStart = (match.index ?? 0) + match[0].length - 1;
  const bodyEnd = findMatchingBrace(source, bodyStart);
  return source.slice(bodyStart + 1, bodyEnd).includes(`loadMovieNum("${swf}"`);
}

function rootFunctionBodyContainsSound(functionName, sound) {
  const sourcePath = join(root, "extracted", "A-tour", "scripts", "frame_1", "DoAction.as");
  if (!existsSync(sourcePath)) return false;

  const source = readFileSync(sourcePath, "utf8");
  const match = source.match(new RegExp(`function\\s+${escapeRegExp(functionName)}\\s*\\([^)]*\\)\\s*\\{`));
  if (!match) return false;

  const bodyStart = (match.index ?? 0) + match[0].length - 1;
  const bodyEnd = findMatchingBrace(source, bodyStart);
  return source.slice(bodyStart + 1, bodyEnd).includes(`attachSound("${sound}"`);
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function categorizeUnsupportedActions(actions) {
  const categories = {
    immediateNavigation: 0,
    immediateSpritePlay: 0,
    dataLoads: 0,
    deferredNavigation: 0,
    deferredSound: 0,
    deferredControl: 0,
    missingSoundExport: 0,
    other: 0,
  };

  for (const action of actions) {
    const command = action.command ?? "unknown";
    const isNavigation = command === "gotoAndPlay" || command === "gotoAndStop" || command === "doRelease" || command === "loadMovieNum";
    const isSound = command === "playVO" || command === "attachSound" || command === "markSndSegment" || command === "stopSound";
    const isDeferred = isFunctionScopedAction(action) || isBranchScopedAction(action);

    if (command === "loadVariables") categories.dataLoads += 1;
    else if (command === "play" && isImmediateTimelineAction(action)) categories.immediateSpritePlay += 1;
    else if (isNavigation && !isDeferred) categories.immediateNavigation += 1;
    else if (isNavigation) categories.deferredNavigation += 1;
    else if (isSound && /no matching FFDec sound export/i.test(action.reason ?? "")) categories.missingSoundExport += 1;
    else if (isSound) categories.deferredSound += 1;
    else if ((command === "stop" || command === "play") && isDeferred) categories.deferredControl += 1;
    else categories.other += 1;
  }

  return categories;
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
