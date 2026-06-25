// Pure AVM1 string/identifier helpers, factored out of Player so they stay
// independently testable and the runtime file keeps to stateful behaviour.

import type { VarValue } from "./VariableStore";

export * from "./avm1Paths";
export * from "./avm1Properties";

type Locals = Record<string, VarValue | undefined>;

/** Split a raw AVM1 argument string on top-level commas (respecting quotes and
 *  bracket/paren nesting). Resolving each part to a value is the caller's job. */
export function splitTopLevelArgs(argsRaw: string | undefined): string[] {
  if (!argsRaw?.trim()) return [];
  const parts: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let i = 0; i < argsRaw.length; i++) {
    const c = argsRaw[i];
    if (quote) { if (c === quote && argsRaw[i - 1] !== "\\") quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { parts.push(argsRaw.slice(start, i)); start = i + 1; }
  }
  parts.push(argsRaw.slice(start));
  return parts;
}

/** An AVM1 unqualified variable (`btnDown`, `labelHidden`, `scene`) is local to the clip its
 *  script runs on; a dotted/object path (`bkgd.X`, `nav.X`) or a `_root`/`_levelN`/`_global`
 *  reference is a shared global in the VariableStore. */
export function isLocalVar(name: string): boolean {
  const n = name.trim();
  return /^[A-Za-z_$][\w$]*$/.test(n) && !/^(true|false|null|undefined|this|_root|_global|_parent|_level\d+)$/.test(n);
}

/** Substitute bound parameter names in a condition with their literal values. */
export function localizeCondition(condition: string, locals: Locals): string {
  let out = condition;
  for (const [name, value] of Object.entries(locals)) {
    if (value === undefined) continue;
    const literal = typeof value === "string" ? JSON.stringify(value) : String(value);
    out = out.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), literal);
  }
  return out;
}
