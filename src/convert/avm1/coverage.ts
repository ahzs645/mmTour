import type { Avm1Action } from "./parse.ts";

export type Avm1CoverageSource =
  | "rootFrame"
  | "spriteFrame"
  | "buttonAction"
  | "functionBody";

export type Avm1CoverageLocation = {
  source: Avm1CoverageSource;
  scope?: "root" | "sprite" | "button";
  frame?: number;
  spriteId?: number;
  buttonId?: number;
  events?: string[];
  functionName?: string;
  path: string;
};

export type Avm1CoverageUnsupported = {
  op: string;
  code?: number;
  count: number;
  locations: Avm1CoverageLocation[];
};

export type Avm1Coverage = {
  schemaVersion: 1;
  opcodeCounts: Record<string, number>;
  opcodeCodes: Record<string, number>;
  unsupportedOpcodes: Avm1CoverageUnsupported[];
  sourceCounts: Record<Avm1CoverageSource, number>;
  totalActions: number;
  supportedActions: number;
  unsupportedActions: number;
};

const SUPPORTED_SUMMARY_OPS = new Set([
  "End",
  "Push",
  "Pop",
  "PushDuplicate",
  "StackSwap",
  "StoreRegister",
  "SetTarget",
  "SetTarget2",
  "GetVariable",
  "SetVariable",
  "GetMember",
  "SetMember",
  "DefineLocal",
  "DefineLocal2",
  "GetProperty",
  "SetProperty",
  "Equals",
  "Equals2",
  "StringEquals",
  "Less",
  "Less2",
  "Greater",
  "And",
  "Or",
  "Add",
  "Add2",
  "StringAdd",
  "Subtract",
  "Multiply",
  "Divide",
  "Modulo",
  "Not",
  "Increment",
  "Decrement",
  "ToInteger",
  "TypeOf",
  "Trace",
  "GetTime",
  "InitArray",
  "NewObject",
  "CallFunction",
  "CallMethod",
  "GetUrl",
  "GetUrl2",
  "GotoFrame",
  "GoToLabel",
  "GotoFrame2",
  "NextFrame",
  "PrevFrame",
  "Play",
  "Stop",
  "DefineFunction",
  "DefineFunction2",
  "Return",
  "If",
  "Jump",
  "ConstantPool",
]);

export function createAvm1Coverage(): Avm1Coverage {
  return {
    schemaVersion: 1,
    opcodeCounts: {},
    opcodeCodes: {},
    unsupportedOpcodes: [],
    sourceCounts: {
      rootFrame: 0,
      spriteFrame: 0,
      buttonAction: 0,
      functionBody: 0,
    },
    totalActions: 0,
    supportedActions: 0,
    unsupportedActions: 0,
  };
}

export function addProgramCoverage(
  coverage: Avm1Coverage,
  program: Avm1Action[],
  location: Avm1CoverageLocation,
) {
  scanProgram(coverage, program, location, location.path);
  coverage.unsupportedOpcodes.sort((a, b) => b.count - a.count || a.op.localeCompare(b.op));
}

function scanProgram(
  coverage: Avm1Coverage,
  program: Avm1Action[],
  location: Avm1CoverageLocation,
  path: string,
) {
  for (let index = 0; index < program.length; index += 1) {
    const action = program[index];
    const op = action.op || `Op${action.code?.toString(16) ?? "unknown"}`;
    coverage.totalActions += 1;
    coverage.sourceCounts[location.source] += 1;
    coverage.opcodeCounts[op] = (coverage.opcodeCounts[op] ?? 0) + 1;
    if (typeof action.code === "number") coverage.opcodeCodes[op] ??= action.code;

    if (SUPPORTED_SUMMARY_OPS.has(op)) {
      coverage.supportedActions += 1;
    } else {
      coverage.unsupportedActions += 1;
      addUnsupported(coverage, op, action.code, { ...location, path: `${path}/${index}:${op}` });
    }

    if ((action.op === "DefineFunction" || action.op === "DefineFunction2") && action.body?.length) {
      scanProgram(coverage, action.body, {
        ...location,
        source: "functionBody",
        functionName: action.name || location.functionName,
        path: `${path}/${index}:${op}`,
      }, `${path}/${index}:${op}`);
    }
  }
}

function addUnsupported(
  coverage: Avm1Coverage,
  op: string,
  code: number | undefined,
  location: Avm1CoverageLocation,
) {
  let entry = coverage.unsupportedOpcodes.find((candidate) => candidate.op === op);
  if (!entry) {
    entry = { op, code, count: 0, locations: [] };
    coverage.unsupportedOpcodes.push(entry);
  }
  entry.count += 1;
  if (entry.locations.length < 25) entry.locations.push(location);
}
