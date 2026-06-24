import type { BodyStatement, ControlAction, DefinedFunction, FunctionCall } from "../../data/timelineTypes.ts";
import type { Avm1Action } from "./parse.ts";

type Expr =
  | { kind: "literal"; value: unknown }
  | { kind: "var"; name: string }
  | { kind: "member"; object: Expr; key: Expr }
  | { kind: "unary"; op: "!"; value: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr }
  | { kind: "call"; target?: Expr; name: string; args: Expr[] }
  | { kind: "array"; items: Expr[] }
  | { kind: "object"; className?: string; args?: Expr[] }
  | { kind: "unknown"; label?: string };

type SummaryContext = {
  scope: "root" | "sprite";
  spriteId?: number;
  source?: string;
};

type SummaryState = {
  stack: Expr[];
  registers: Map<number, Expr>;
  currentTarget?: string;
  actions: ControlAction[];
  definedFunctions: DefinedFunction[];
};

export type ProgramSummary = {
  actions: ControlAction[];
  definedFunctions: DefinedFunction[];
};

const unknown = (label?: string): Expr => ({ kind: "unknown", label });
const literal = (value: unknown): Expr => ({ kind: "literal", value });
const TIMELINE_METHODS = new Set(["gotoAndPlay", "gotoAndStop", "play", "stop"]);

export function summarizeProgram(program: Avm1Action[], context: SummaryContext): ProgramSummary {
  const state: SummaryState = { stack: [], registers: new Map(), actions: [], definedFunctions: [] };
  summarizeRange(program, 0, program.length, state, context, undefined);
  return { actions: state.actions, definedFunctions: state.definedFunctions };
}

function summarizeRange(
  program: Avm1Action[],
  start: number,
  end: number,
  state: SummaryState,
  context: SummaryContext,
  guard: string | undefined,
) {
  let i = start;
  while (i < end) {
    const action = program[i];
    const shortCircuitEnd = summarizeShortCircuitAnd(program, i, end, state, context, guard);
    if (shortCircuitEnd !== undefined) {
      i = shortCircuitEnd;
      continue;
    }
    if (action.op === "If") {
      const cond = state.stack.pop() ?? unknown("condition");
      const target = boundedJump(action.jumpTo, i + 1, end);
      if (target > i + 1) {
        const jumpIndex = findForwardJump(program, i + 1, target, end);
        if (jumpIndex >= 0) {
          const afterElse = boundedJump(program[jumpIndex].jumpTo, target, end);
          summarizeBranch(program, i + 1, jumpIndex, state, context, andGuard(guard, invertExpr(cond)));
          summarizeBranch(program, target, afterElse, state, context, andGuard(guard, condToString(cond)));
          i = afterElse;
          continue;
        }
        summarizeBranch(program, i + 1, target, state, context, andGuard(guard, invertExpr(cond)));
        i = target;
        continue;
      }
    }
    if (action.op === "Jump") {
      const target = action.jumpTo;
      if (typeof target === "number" && target > i && target <= end) {
        i = target;
        continue;
      }
    }
    processAction(action, state, context, guard);
    i += 1;
  }
}

function summarizeShortCircuitAnd(
  program: Avm1Action[],
  start: number,
  end: number,
  state: SummaryState,
  context: SummaryContext,
  guard: string | undefined,
): number | undefined {
  if (program[start]?.op !== "PushDuplicate" || program[start + 1]?.op !== "Not" || program[start + 2]?.op !== "If") return undefined;
  const lhs = state.stack[state.stack.length - 1];
  if (!lhs) return undefined;

  const join = boundedJump(program[start + 2].jumpTo, start + 3, end);
  const finalIf = join + 1;
  if (join <= start + 3 || finalIf >= end || program[join]?.op !== "Not" || program[finalIf]?.op !== "If") return undefined;

  const rhs = summarizeConditionRhs(program, start + 3, join, state, context);
  if (!rhs) return undefined;

  // Flash compiles `A && B` as:
  //   A; dup; not; if join; pop; B; join: not; if after
  // The final `if` jumps when the composite condition is false. If the RHS
  // block ends in `Not`, this naturally becomes `A && !B`.
  state.stack.pop();
  const composite: Expr = { kind: "binary", op: "&&", left: lhs, right: rhs };
  const skipCondition = notExpr(composite);
  const target = boundedJump(program[finalIf].jumpTo, finalIf + 1, end);
  if (target > finalIf + 1) {
    const jumpIndex = findForwardJump(program, finalIf + 1, target, end);
    if (jumpIndex >= 0) {
      const afterElse = boundedJump(program[jumpIndex].jumpTo, target, end);
      summarizeBranch(program, finalIf + 1, jumpIndex, state, context, andGuard(guard, invertExpr(skipCondition)));
      summarizeBranch(program, target, afterElse, state, context, andGuard(guard, condToString(skipCondition)));
      return afterElse;
    }
    summarizeBranch(program, finalIf + 1, target, state, context, andGuard(guard, invertExpr(skipCondition)));
    return target;
  }

  return undefined;
}

function summarizeConditionRhs(
  program: Avm1Action[],
  start: number,
  end: number,
  base: SummaryState,
  context: SummaryContext,
): Expr | undefined {
  const probe: SummaryState = {
    stack: base.stack.slice(),
    registers: new Map(base.registers),
    currentTarget: base.currentTarget,
    actions: [],
    definedFunctions: [],
  };
  for (let i = start; i < end; i += 1) {
    if (program[i].op === "If" || program[i].op === "Jump") return undefined;
    processAction(program[i], probe, context, undefined);
    if (probe.actions.length || probe.definedFunctions.length) return undefined;
  }
  return probe.stack[probe.stack.length - 1];
}

function summarizeBranch(
  program: Avm1Action[],
  start: number,
  end: number,
  base: SummaryState,
  context: SummaryContext,
  guard: string | undefined,
) {
  const branch: SummaryState = {
    stack: base.stack.slice(),
    registers: new Map(base.registers),
    currentTarget: base.currentTarget,
    actions: base.actions,
    definedFunctions: base.definedFunctions,
  };
  summarizeRange(program, start, end, branch, context, guard);
}

function processAction(action: Avm1Action, state: SummaryState, context: SummaryContext, guard: string | undefined) {
  switch (action.op) {
    case "End":
      return;
    case "Push":
      for (const value of action.values ?? []) state.stack.push(exprFromPush(value, state));
      return;
    case "Pop":
      state.stack.pop();
      return;
    case "PushDuplicate":
      state.stack.push(state.stack[state.stack.length - 1] ?? unknown("dup"));
      return;
    case "StackSwap": {
      const a = state.stack.pop() ?? unknown();
      const b = state.stack.pop() ?? unknown();
      state.stack.push(a, b);
      return;
    }
    case "StoreRegister":
      if (typeof action.register === "number") state.registers.set(action.register, state.stack[state.stack.length - 1] ?? unknown("register"));
      return;
    case "SetTarget":
      state.currentTarget = action.target || undefined;
      return;
    case "SetTarget2":
      state.currentTarget = pathOf(state.stack.pop() ?? unknown("target")) || undefined;
      return;
    case "GetVariable": {
      const name = state.stack.pop() ?? unknown("var");
      state.stack.push(varExpr(name));
      return;
    }
    case "SetVariable": {
      const value = state.stack.pop() ?? unknown("value");
      const name = state.stack.pop() ?? unknown("name");
      pushAction(state, { command: "setVariable", target: pathOf(name), value: literalValue(value), rawValue: exprToValueSource(value), source: context.source }, guard);
      return;
    }
    case "GetMember": {
      const key = state.stack.pop() ?? unknown("member");
      const object = state.stack.pop() ?? unknown("object");
      state.stack.push({ kind: "member", object, key });
      return;
    }
    case "SetMember": {
      const value = state.stack.pop() ?? unknown("value");
      const key = state.stack.pop() ?? unknown("member");
      const object = state.stack.pop() ?? unknown("object");
      pushAction(state, { command: "setVariable", target: pathOf({ kind: "member", object, key }), value: literalValue(value), rawValue: exprToValueSource(value), source: context.source }, guard);
      return;
    }
    case "DefineLocal": {
      const value = state.stack.pop() ?? unknown("value");
      const name = state.stack.pop() ?? unknown("local");
      pushAction(state, { command: "setVariable", target: pathOf(name), value: literalValue(value), rawValue: exprToValueSource(value), source: context.source }, guard);
      return;
    }
    case "DefineLocal2":
      state.stack.pop();
      return;
    case "GetProperty": {
      const index = state.stack.pop() ?? unknown("property");
      const target = state.stack.pop() ?? unknown("target");
      state.stack.push(propertyExpr(target, index));
      return;
    }
    case "SetProperty": {
      const value = state.stack.pop() ?? unknown("value");
      const index = state.stack.pop() ?? unknown("property");
      const target = state.stack.pop() ?? unknown("target");
      pushAction(state, { command: "setVariable", target: pathOf(propertyExpr(target, index)), value: literalValue(value), rawValue: exprToValueSource(value), source: context.source }, guard);
      return;
    }
    case "Equals":
    case "Equals2":
    case "StringEquals":
      binary(state, "==");
      return;
    case "Less":
    case "Less2":
      binary(state, "<");
      return;
    case "Greater":
      binary(state, ">");
      return;
    case "And":
      binary(state, "&&");
      return;
    case "Or":
      binary(state, "||");
      return;
    case "Add":
    case "Add2":
    case "StringAdd":
      binary(state, "+");
      return;
    case "Subtract":
      binary(state, "-");
      return;
    case "Multiply":
      binary(state, "*");
      return;
    case "Divide":
      binary(state, "/");
      return;
    case "Modulo":
      binary(state, "%");
      return;
    case "Not":
      state.stack.push(notExpr(state.stack.pop() ?? unknown("not")));
      return;
    case "Increment":
      state.stack.push({ kind: "binary", op: "+", left: state.stack.pop() ?? unknown("inc"), right: literal(1) });
      return;
    case "Decrement":
      state.stack.push({ kind: "binary", op: "-", left: state.stack.pop() ?? unknown("dec"), right: literal(1) });
      return;
    case "ToInteger":
      return;
    case "TypeOf":
      state.stack.push({ kind: "call", name: "typeof", args: [state.stack.pop() ?? unknown("typeof")] });
      return;
    case "Trace":
      state.stack.pop();
      return;
    case "GetTime":
      state.stack.push({ kind: "call", name: "getTimer", args: [] });
      return;
    case "InitArray": {
      const count = Number(literalValue(state.stack.pop() ?? literal(0))) || 0;
      const items = popArgs(state, count);
      state.stack.push({ kind: "array", items });
      return;
    }
    case "NewObject": {
      const className = literalValue(state.stack.pop() ?? unknown("class"));
      const count = Number(literalValue(state.stack.pop() ?? literal(0))) || 0;
      state.stack.push({ kind: "object", className: typeof className === "string" ? className : undefined, args: popArgs(state, count) });
      return;
    }
    case "CallFunction": {
      const nameExpr = state.stack.pop() ?? unknown("function");
      const count = Number(literalValue(state.stack.pop() ?? literal(0))) || 0;
      const args = popArgs(state, count);
      const call = actionFromCall(pathOf(nameExpr), state.currentTarget, args, false);
      if (call) pushAction(state, { ...call, source: context.source }, guard);
      state.stack.push({ kind: "call", target: state.currentTarget ? { kind: "var", name: state.currentTarget } : undefined, name: pathOf(nameExpr), args });
      return;
    }
    case "CallMethod": {
      const methodExpr = state.stack.pop() ?? unknown("method");
      const target = state.stack.pop() ?? unknown("target");
      const count = Number(literalValue(state.stack.pop() ?? literal(0))) || 0;
      const args = popArgs(state, count);
      const call = actionFromCall(pathOf(methodExpr), pathOf(target), args, true);
      if (call) pushAction(state, { ...call, source: context.source }, guard);
      state.stack.push({ kind: "call", target, name: pathOf(methodExpr), args });
      return;
    }
    case "GetUrl": {
      const call = actionFromUrl(literal(action.url ?? ""), literal(action.target ?? ""), false);
      if (call) pushAction(state, { ...call, source: context.source }, guard);
      return;
    }
    case "GetUrl2": {
      const target = state.stack.pop() ?? unknown("target");
      const url = state.stack.pop() ?? unknown("url");
      const variableSource = stringValue(url);
      const call = action.loadVariablesFlag
        ? { command: "loadVariables" as const, target: pathOf(target), swf: variableSource, variableSource }
        : actionFromUrl(url, target, Boolean(action.loadTargetFlag));
      if (call) pushAction(state, { ...call, source: context.source }, guard);
      return;
    }
    case "GotoFrame":
      pushAction(state, { command: "gotoAndStop", frame: action.frame ?? 0, frameExpression: String((action.frame ?? 0) + 1), target: activeTarget(state), source: context.source }, guard);
      return;
    case "GoToLabel":
      pushAction(state, { command: "gotoAndStop", label: action.label, target: activeTarget(state), source: context.source }, guard);
      return;
    case "GotoFrame2":
      pushAction(state, makeGoto(action.play ? "gotoAndPlay" : "gotoAndStop", activeTarget(state), state.stack.pop() ?? unknown("frame"), true, context.source), guard);
      return;
    case "NextFrame":
      pushAction(state, { command: "gotoAndStop", frameExpression: "_currentframe + 1", target: activeTarget(state), source: context.source }, guard);
      return;
    case "PrevFrame":
      pushAction(state, { command: "gotoAndStop", frameExpression: "_currentframe - 1", target: activeTarget(state), source: context.source }, guard);
      return;
    case "Play":
      mergePlayStop(state, "play", guard, context.source, activeTarget(state));
      return;
    case "Stop":
      mergePlayStop(state, "stop", guard, context.source, activeTarget(state));
      return;
    case "DefineFunction":
    case "DefineFunction2":
      collectFunction(action, state, context);
      return;
    case "Return":
      state.stack.pop();
      return;
    default:
      return;
  }
}

function collectFunction(action: Avm1Action, state: SummaryState, context: SummaryContext) {
  if (!action.name) return;
  const body = summarizeProgram(action.body ?? [], context);
  const statements = bodyActionsToStatements(body.actions);
  state.definedFunctions.push({
    functionName: action.name,
    parameters: (action.params ?? []).map((p) => p.name).filter(Boolean),
    scope: context.scope,
    spriteId: context.spriteId,
    body: statements,
    calls: statements.filter((s): s is Extract<BodyStatement, { kind: "call" }> => s.kind === "call")
      .map((s) => ({ target: s.target ?? "self", functionName: s.functionName, arguments: s.arguments ?? "" })),
    assignments: statements.filter((s): s is Extract<BodyStatement, { kind: "assign" }> => s.kind === "assign")
      .map((s) => ({ target: s.target, value: s.value, rawValue: s.rawValue })),
    // Browser extraction can recover command actions directly from function bytecode.
    // Player.buildFunctionTable consumes this optional field.
    actions: body.actions,
    source: context.source,
  } as DefinedFunction & { actions?: ControlAction[] });
  state.definedFunctions.push(...body.definedFunctions);
}

function bodyActionsToStatements(actions: ControlAction[]): BodyStatement[] {
  const out: BodyStatement[] = [];
  for (const action of actions) {
    const branchCondition = action.branchCondition ?? action.functionBranchCondition;
    if (action.command === "setVariable" && action.target) {
      out.push({ kind: "assign", target: action.target, value: action.value as string | number | boolean | undefined, rawValue: action.rawValue ?? String(action.value ?? ""), branchCondition });
      continue;
    }
    if (action.command === "callFunctions") {
      for (const call of action.functionCalls ?? []) out.push({ kind: "call", target: call.target, functionName: call.functionName, arguments: call.arguments, branchCondition });
      continue;
    }
    if (TIMELINE_METHODS.has(action.command ?? "")) {
      const arg = action.label !== undefined ? JSON.stringify(action.label) : typeof action.frame === "number" ? String(action.frame + 1) : action.frameExpression ?? "";
      out.push({ kind: "call", target: action.target, functionName: action.command!, arguments: arg, branchCondition });
    }
  }
  return out;
}

function actionFromCall(name: string, target: string | undefined, args: Expr[], method: boolean): ControlAction | null {
  if (!name || name === "undefined") return null;
  if (name === "loadMovieNum") return loadAction("loadMovieNum", args[0], args[1]);
  if (name === "loadMovie") return loadAction("loadMovie", args[0], args[1]);
  if (name === "loadVariables") {
    const variableSource = stringValue(args[0]);
    return { command: "loadVariables", swf: variableSource, variableSource, target: argSource(args[1]) };
  }
  if (name === "gotoAndPlay" || name === "gotoAndStop") return makeGoto(name, target ?? "self", args[0] ?? unknown("frame"), true);
  if (name === "play" || name === "stop") return { command: name, target: target ?? "self" };
  if (name === "doRelease") return { command: "doRelease", swf: stringValue(args[0]) };
  if (name === "start" && target) return { command: "callFunctions", functionCalls: [{ target, functionName: name, arguments: args.map(argSource).join(",") }] };
  return {
    command: "callFunctions",
    functionCalls: [{ target: target ?? "self", functionName: name, arguments: args.map(argSource).join(",") }],
  };
}

function actionFromUrl(url: Expr, target: Expr, loadTargetFlag: boolean): ControlAction | null {
  const swf = stringValue(url);
  const targetPath = pathOf(target);
  if (swf && !/\.swf$/i.test(swf)) return null;
  const level = levelFromTarget(targetPath);
  if (!swf && !loadTargetFlag) return null;
  if (level !== undefined) return { command: "loadMovieNum", swf, level };
  return { command: loadTargetFlag ? "loadMovie" : "loadMovie", swf, target: targetPath };
}

function loadAction(command: "loadMovie" | "loadMovieNum", swfExpr: Expr, targetExpr: Expr): ControlAction {
  const swf = stringValue(swfExpr);
  const level = levelFromExpr(targetExpr);
  if (command === "loadMovieNum" || level !== undefined) return { command: "loadMovieNum", swf, level };
  return { command: "loadMovie", swf, target: pathOf(targetExpr) };
}

function makeGoto(command: "gotoAndPlay" | "gotoAndStop", target: string | undefined, frameExpr: Expr, oneBased: boolean, source?: string): ControlAction {
  const raw = exprToValueSource(frameExpr);
  const value = literalValue(frameExpr);
  const rel = relativeFrameExpression(frameExpr);
  if (rel) return { command, target, frameExpression: rel, source };
  if (typeof value === "number") return { command, target, frame: oneBased ? Math.max(0, value - 1) : value, frameExpression: raw, source };
  if (typeof value === "string" && value !== "") return { command, target, label: value, source };
  return { command, target, frameExpression: raw, source };
}

function mergePlayStop(state: SummaryState, command: "play" | "stop", guard: string | undefined, source?: string, target = "self") {
  const prior = state.actions[state.actions.length - 1];
  const expected = command === "play" ? "gotoAndStop" : "gotoAndPlay";
  const next = command === "play" ? "gotoAndPlay" : "gotoAndStop";
  if (prior?.command === expected && sameGuard(prior, guard) && prior.target === target) {
    prior.command = next;
    return;
  }
  pushAction(state, { command, target, source }, guard);
}

function pushAction(state: SummaryState, action: ControlAction, guard: string | undefined) {
  const guarded = guard
    ? { ...action, branchCondition: guard, functionBranchCondition: guard, executionContext: "branch" }
    : { ...action, executionContext: action.executionContext ?? "timeline" };
  state.actions.push(guarded);
}

function binary(state: SummaryState, op: string) {
  const right = state.stack.pop() ?? unknown("right");
  const left = state.stack.pop() ?? unknown("left");
  state.stack.push({ kind: "binary", op, left, right });
}

function popArgs(state: SummaryState, count: number): Expr[] {
  const args: Expr[] = [];
  for (let i = 0; i < count; i += 1) args.push(state.stack.pop() ?? unknown("arg"));
  return args;
}

function exprFromPush(value: any, state: SummaryState): Expr {
  if (value?.type === "register") return state.registers.get(value.value) ?? unknown(`register${value.value}`);
  return literal(value?.value);
}

function varExpr(name: Expr): Expr {
  if (name.kind !== "literal") return { kind: "call", name: "eval", args: [name] };
  const path = pathOf(name);
  return path ? { kind: "var", name: path } : unknown("var");
}

function propertyExpr(target: Expr, index: Expr): Expr {
  const value = literalValue(index);
  const property = propertyName(Number(value));
  if (property) return { kind: "var", name: property };
  return { kind: "member", object: target, key: index };
}

function propertyName(index: number): string | undefined {
  return {
    0: "_x",
    1: "_y",
    2: "_xscale",
    3: "_yscale",
    4: "_currentframe",
    5: "_totalframes",
    6: "_alpha",
    7: "_visible",
    8: "_width",
    9: "_height",
    10: "_rotation",
    11: "_target",
    12: "_framesloaded",
    13: "_name",
    14: "_droptarget",
    15: "_url",
    16: "_highquality",
    17: "_focusrect",
    18: "_soundbuftime",
    19: "_quality",
    20: "_xmouse",
    21: "_ymouse",
  }[index];
}

function notExpr(value: Expr): Expr {
  if (value.kind === "unary" && value.op === "!") return value.value;
  return { kind: "unary", op: "!", value };
}

function invertExpr(value: Expr): string {
  return condToString(notExpr(value));
}

function condToString(value: Expr): string {
  return exprToCondition(value);
}

function exprToCondition(value: Expr): string {
  if (value.kind === "unary") return `!${wrapCondition(value.value)}`;
  if (value.kind === "binary" && ["==", "<", ">", "<=", ">=", "!=", "&&", "||"].includes(value.op)) {
    const typeOfLeft = typeOfUndefinedCondition(value.left, value.right, value.op);
    if (typeOfLeft) return typeOfLeft;
    const typeOfRight = typeOfUndefinedCondition(value.right, value.left, value.op);
    if (typeOfRight) return typeOfRight;
    return `${wrapCondition(value.left)} ${value.op} ${wrapCondition(value.right)}`;
  }
  return exprToValueSource(value);
}

function typeOfUndefinedCondition(typeExpr: Expr, other: Expr, op: string): string | undefined {
  if (typeExpr.kind !== "call" || typeExpr.name !== "typeof" || typeExpr.args.length !== 1) return undefined;
  if (literalValue(other) !== "undefined" || (op !== "==" && op !== "!=")) return undefined;
  return `${pathOf(typeExpr.args[0])} ${op} undefined`;
}

function wrapCondition(value: Expr): string {
  if (value.kind === "binary") return `(${exprToCondition(value)})`;
  return exprToCondition(value);
}

function exprToValueSource(value: Expr): string {
  switch (value.kind) {
    case "literal":
      return typeof value.value === "string" ? JSON.stringify(value.value) : String(value.value);
    case "var":
      return value.name;
    case "member":
      return pathOf(value);
    case "unary":
      return `!${wrapCondition(value.value)}`;
    case "binary":
      return `${exprToValueSource(value.left)} ${value.op} ${exprToValueSource(value.right)}`;
    case "call":
      return `${value.target ? `${pathOf(value.target)}.` : ""}${value.name}(${value.args.map(argSource).join(",")})`;
    case "array":
      return `[${value.items.map(argSource).join(",")}]`;
    case "object":
      return value.className ? `new ${value.className}()` : "{}";
    case "unknown":
      return value.label ?? "undefined";
  }
}

function argSource(value: Expr | undefined): string {
  return value ? exprToValueSource(value) : "";
}

function pathOf(value: Expr | undefined): string {
  if (!value) return "";
  if (value.kind === "literal") return value.value === undefined ? "" : String(value.value);
  if (value.kind === "var") return value.name;
  if (value.kind === "member") {
    const object = pathOf(value.object);
    const key = pathOf(value.key);
    if (!object) return key;
    if (!key) return object;
    return `${object}.${key}`;
  }
  if (value.kind === "call") return exprToValueSource(value);
  if (value.kind === "binary" && value.op === "+") {
    const left = literalValue(value.left);
    const right = literalValue(value.right);
    if (typeof left === "string" && typeof right === "string") return left + right;
  }
  return exprToValueSource(value);
}

function activeTarget(state: SummaryState): string {
  return state.currentTarget ?? "self";
}

function literalValue(value: Expr): string | number | boolean | undefined {
  if (value.kind === "literal") {
    if (typeof value.value === "string" || typeof value.value === "number" || typeof value.value === "boolean") return value.value;
    return undefined;
  }
  return undefined;
}

function stringValue(value: Expr | undefined): string {
  const literal = value ? literalValue(value) : undefined;
  return literal === undefined ? "" : String(literal);
}

function relativeFrameExpression(value: Expr): string | undefined {
  if (value.kind !== "binary" || (value.op !== "-" && value.op !== "+")) return undefined;
  const left = pathOf(value.left);
  const right = literalValue(value.right);
  if (left === "_currentframe" && typeof right === "number") return `_currentframe ${value.op} ${right}`;
  return undefined;
}

function levelFromExpr(value: Expr | undefined): number | undefined {
  const literal = value ? literalValue(value) : undefined;
  if (typeof literal === "number") return literal;
  return levelFromTarget(pathOf(value));
}

function levelFromTarget(target: string): number | undefined {
  const match = /^_level(\d+)(?:\.|$)/i.exec(target);
  return match ? Number(match[1]) : undefined;
}

function sameGuard(action: ControlAction, guard: string | undefined): boolean {
  return (action.branchCondition ?? action.functionBranchCondition) === guard;
}

function andGuard(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return `(${a}) && (${b})`;
}

function boundedJump(target: number | undefined, fallback: number, end: number): number {
  return typeof target === "number" && target >= 0 && target <= end ? target : fallback;
}

function findForwardJump(program: Avm1Action[], start: number, end: number, max: number): number {
  for (let i = end - 1; i >= start; i -= 1) {
    const jumpTo = program[i].op === "Jump" ? program[i].jumpTo : undefined;
    if (typeof jumpTo === "number" && jumpTo > end && jumpTo <= max) return i;
  }
  return -1;
}

export function combineButtonActions(actions: ControlAction[]): ControlAction | undefined {
  if (!actions.length) return undefined;
  const assignments = actions.flatMap((action) => action.assignments ?? (
    action.command === "setVariable" && action.target ? [{ target: action.target, value: action.value, rawValue: action.rawValue }] : []
  ));
  const primaryIndex = findLastActionIndex(actions, (action) =>
    Boolean(action.command && action.command !== "setVariable" && action.command !== "callFunctions")
  );
  const functionCalls: FunctionCall[] = [];
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    if (i !== primaryIndex) {
      const timelineCall = timelineActionAsCall(action);
      if (timelineCall) functionCalls.push(timelineCall);
    }
    functionCalls.push(...(action.functionCalls ?? []));
  }
  const loads = actions.flatMap((action) =>
    (action.command === "loadMovie" || action.command === "loadMovieNum") && action.swf
      ? [{ swf: action.swf, level: action.level }]
      : action.loads ?? [],
  );
  const primary = primaryIndex >= 0
    ? actions[primaryIndex]
    : actions.find((action) => action.command === "callFunctions") ?? actions[0];
  const merged: ControlAction = { ...primary };
  if (assignments.length) merged.assignments = assignments;
  if (functionCalls.length) merged.functionCalls = functionCalls;
  if (loads.length) {
    merged.loads = loads;
    if (!merged.swf) {
      merged.swf = loads[0].swf;
      merged.level = loads[0].level;
    }
  }
  return merged;
}

function findLastActionIndex(actions: ControlAction[], predicate: (action: ControlAction) => boolean): number {
  for (let i = actions.length - 1; i >= 0; i -= 1) if (predicate(actions[i])) return i;
  return -1;
}

function timelineActionAsCall(action: ControlAction): FunctionCall | undefined {
  if (!action.command || !TIMELINE_METHODS.has(action.command)) return undefined;
  const args =
    action.label !== undefined
      ? JSON.stringify(action.label)
      : typeof action.frame === "number"
        ? String(action.frame + 1)
        : action.frameExpression ?? "";
  return { target: action.target ?? "self", functionName: action.command, arguments: args };
}
