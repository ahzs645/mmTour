// Pure ActionScript source parsers for the timeline extractor: brace/paren/statement
// scanning, function/branch context detection, and small literal/condition helpers.

import { compactObject } from "./util.mjs";

const SELF_TIMELINE_COMMANDS = new Set(["gotoAndPlay", "gotoAndStop", "play", "stop", "nextFrame", "prevFrame", "stopAllSounds"]);

export function parseActionScriptLiteral(value) {
  const trimmed = String(value).trim();
  const stringMatch = trimmed.match(/^"([^"]*)"$/) ?? trimmed.match(/^'([^']*)'$/);
  if (stringMatch) return stringMatch[1];
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const numericValue = Number(trimmed);
  return Number.isFinite(numericValue) ? numericValue : trimmed;
}

export function stripActionScriptStrings(source) {
  return source.replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, (literal) => literal[0] === "'" ? "''" : '""');
}

export function discoverFunctionCalls(source) {
  const calls = [];
  for (const match of source.matchAll(/([A-Za-z0-9_.$]+)\.([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?/g)) {
    const functionName = match[2];
    const target = match[1];
    const isGoto = functionName.startsWith("gotoAnd");
    // A goto on a NAMED sibling clip (e.g. a button's `_parent.btn_green_anim.gotoAndPlay("over")`
    // rollover glow) must be dispatched as a clip command; only _root/self gotos are the action's
    // own command (handled in parseActionScript), so keep targeted clip gotos here.
    if (isGoto && (target === "_root" || target === "_level0")) continue;
    if (!isGoto && ["attachSound", "doRelease", "loadMovie", "loadMovieNum", "loadVariables"].includes(functionName)) continue;
    if (target.endsWith(".s1") || target.endsWith(".s2")) continue;
    calls.push({
      target,
      functionName,
      arguments: match[3].trim(),
    });
  }
  // Bare self-calls (no target) — a control's `over()`/`out()` label-reveal functions, run on
  // the button's own clip. Skip AS built-ins and the gotos/loads handled as the action command.
  const BUILTINS = new Set(["trace", "stop", "play", "gotoAndPlay", "gotoAndStop", "nextFrame", "prevFrame",
    "fscommand", "getURL", "stopAllSounds", "loadMovie", "loadMovieNum", "loadVariables", "unloadMovie",
    "unloadMovieNum", "attachSound", "doRelease", "if", "while", "for", "function", "return", "Number", "String"]);
  for (const match of source.matchAll(/(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;/g)) {
    const functionName = match[1];
    if (BUILTINS.has(functionName)) continue;
    calls.push({ target: "self", functionName, arguments: match[2].trim() });
  }
  return calls;
}

export /**
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

export function tellTargetAt(contexts, index) {
  for (const c of contexts) if (index >= c.start && index < c.end) return c.clip;
  return undefined;
}

export function normalizeGeneratedGlobalName(expression) {
  return String(expression).trim().replace(/^bkgd\./, "bkgd.");
}

export function stringLiteral(expression) {
  return expression.match(/^"([^"]+)"$/)?.[1] ?? expression.match(/^'([^']+)'$/)?.[1] ?? "";
}

export function resolveFrameExpression(expression, frameLabels) {
  const label = stringLiteral(expression);
  if (label && label in frameLabels) return frameLabels[label];

  const frameNumber = Number.parseInt(expression, 10);
  if (Number.isFinite(frameNumber) && frameNumber > 0) return frameNumber - 1;

  return -1;
}

export function runtimeCanExecuteBranchCommand(scope, command, target = "", hasResolvableTarget = true) {
  if (!hasResolvableTarget) return false;
  if (command === "stop") return scope === "root" || scope === "sprite";
  if (command === "doRelease" || command === "loadMovieNum") return scope === "root" || scope === "sprite";
  if (command !== "gotoAndPlay" && command !== "gotoAndStop") return false;
  if (target === "self") return scope === "root" || scope === "sprite";
  if (target === "_root" || target === "_parent") return scope === "sprite";
  if (scope === "root" && /^_level\d+$/i.test(target)) return true;
  return false;
}

export function withActionContext(action, context) {
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

export function contextLabel(context) {
  return context.type === "function" ? "Function-scoped" : "Branch-scoped";
}

export function findFunctionContexts(source) {
  const contexts = [];
  for (const match of source.matchAll(/function\s+((?:get|set)\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
    const bodyStart = (match.index ?? 0) + match[0].length - 1;
    const bodyEnd = findMatchingBrace(source, bodyStart);
    contexts.push({ type: "function", name: `${match[1] ?? ""}${match[2]}`.trim(), start: match.index ?? 0, bodyStart, end: bodyEnd });
  }
  return contexts;
}

export function findBranchContexts(source) {
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

export function findMatchingBrace(source, openIndex) {
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

export function matchParenFrom(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") { depth -= 1; if (depth === 0) return i; }
  }
  return source.length;
}

export function skipNoiseFrom(source, i) {
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source.startsWith("//", i)) { const nl = source.indexOf("\n", i); i = nl < 0 ? source.length : nl + 1; continue; }
    if (source.startsWith("/*", i)) { const e = source.indexOf("*/", i); i = e < 0 ? source.length : e + 2; continue; }
    break;
  }
  return i;
}

export function findStatementEnd(source, i) {
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

function switchCaseGroups(block) {
  const entries = [];
  const re = /\b(case\s+([\s\S]*?)|default)\s*:/g;
  let match;
  while ((match = re.exec(block)) !== null) {
    entries.push({
      label: match[1] === "default" ? "default" : match[2].trim(),
      labelStart: match.index,
      bodyStart: re.lastIndex,
    });
  }
  const groups = [];
  let labels = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const nextStart = entries[i + 1]?.labelStart ?? block.length;
    const rawBody = block.slice(entry.bodyStart, nextStart);
    labels.push(entry.label);
    const breakAt = topLevelBreakIndex(rawBody);
    if (breakAt >= 0) {
      groups.push({ labels: [...labels], body: rawBody.slice(0, breakAt) });
      labels = [];
    } else if (rawBody.trim()) {
      groups.push({ labels: [...labels], body: rawBody });
      labels = [];
    }
  }
  return groups;
}

function topLevelBreakIndex(source) {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) { if (c === quote && source[i - 1] !== "\\") quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "(" || c === "[") depth += 1;
    else if (c === "}" || c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && /\bbreak\s*;/.test(source.slice(i, i + 8))) return i;
  }
  return -1;
}

export /**
 * Parse an ActionScript function/frame body into an ordered list of statements,
 * each tagged with the combined if/else branch condition under which it runs. The
 * tour's orchestration functions (e.g. `showSceneMenu`) are if/else chains that
 * call `_level6.<button>.gotoAndPlay("over")` for the active section — without the
 * conditions the runtime can't pick the right branch. `else` arms become the
 * negation of their prior siblings, so each statement carries a self-contained,
 * `evalCondition`-ready guard. Statement kinds: `assign` (target/rawValue) and
 * `call` (target/functionName/arguments). Nested function defs are skipped.
 */
function parseStatements(src, keepSelfTimeline = false) {
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
      if (/^while\s*\(/.test(rest)) { i = parseWhile(code, i, condStack); continue; }
      if (/^switch\s*\(/.test(rest)) { i = parseSwitch(code, i, condStack); continue; }
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

  function parseWhile(code, start, condStack) {
    const m = /^while\s*\(/.exec(code.slice(start));
    if (!m) return start + 1;
    const condOpen = start + m[0].length - 1;
    const condClose = matchParenFrom(code, condOpen);
    const [block, after] = readBlock(code, condClose + 1);
    const condition = code.slice(condOpen + 1, condClose).trim();
    const branchCondition = condStack.length ? condStack.map((c) => `(${c})`).join(" && ") : undefined;
    out.push(compactObject({ kind: "call", functionName: "while", arguments: `${condition})\n{\n${block}\n}`, branchCondition }));
    return after;
  }

  function parseSwitch(code, start, condStack) {
    const m = /^switch\s*\(/.exec(code.slice(start));
    if (!m) return start + 1;
    const exprOpen = start + m[0].length - 1;
    const exprClose = matchParenFrom(code, exprOpen);
    const expr = code.slice(exprOpen + 1, exprClose).trim();
    const [block, after] = readBlock(code, exprClose + 1);
    for (const group of switchCaseGroups(block)) {
      const caseCondition = group.labels.includes("default")
        ? group.labels.length === 1 ? "true" : group.labels.filter((label) => label !== "default").map((label) => `${expr} == ${label}`).join(" || ") || "true"
        : group.labels.map((label) => `${expr} == ${label}`).join(" || ");
      parseBlock(group.body, [...condStack, caseCondition]);
    }
    return after;
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
      // Self timeline commands (gotoAndPlay(60), stop()) are handled by frameActions for frame
      // scripts; for a sprite FUNCTION body (over()/out() label reveal) they ARE the behaviour,
      // so keep them (with their branchCondition) when keepSelfTimeline is set.
      if (!target && SELF_TIMELINE_COMMANDS.has(functionName) && !keepSelfTimeline) return;
      out.push(compactObject({ kind: "call", target, functionName, arguments: call[2].trim() || undefined, branchCondition }));
      return;
    }
    const asg = /^(?:var\s+)?([A-Za-z_$][\w$.]*)\s*=\s*([\s\S]+)$/.exec(stmt);
    if (asg && !/^[=<>!]/.test(asg[2])) {
      out.push(compactObject({ kind: "assign", target: asg[1], value: parseActionScriptLiteral(asg[2]), rawValue: asg[2].trim(), branchCondition }));
    }
  }
}

export function contextAt(contexts, index) {
  return contexts.find((context) => index > context.bodyStart && index < context.end);
}

export function actionContextAt(functionContexts, branchContexts, index) {
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
