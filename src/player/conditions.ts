import type { VariableStore, VarValue } from "./VariableStore";

/**
 * Evaluate an extracted AVM1 `functionBranchCondition` against a VariableStore.
 * Supports the operators the tour actually uses — `==`, `!=`, `<`, `>`, `<=`,
 * `>=`, `!`, `&&`, `||`, quoted strings, numbers, and bare variable truthiness —
 * plus the sentinel `"else"` (the fallback branch) and empty/undefined (an
 * unconditional action). This is a safe mini-evaluator (no `eval`); anything it
 * can't parse resolves to `false` so unknown gates simply don't fire.
 */
export function evalCondition(expr: string | undefined, store: VariableStore): boolean {
  if (!expr) return true; // unconditional
  const trimmed = expr.trim();
  if (trimmed === "" || trimmed === "else" || trimmed === "true") return true;
  if (trimmed === "false") return false;
  return evalOr(trimmed, store);
}

function evalOr(expr: string, store: VariableStore): boolean {
  const parts = splitTop(expr, "||");
  if (parts.length > 1) return parts.some((p) => evalAnd(p, store));
  return evalAnd(expr, store);
}

function evalAnd(expr: string, store: VariableStore): boolean {
  const parts = splitTop(expr, "&&");
  if (parts.length > 1) return parts.every((p) => evalFactor(p, store));
  return evalFactor(expr, store);
}

function evalFactor(expr: string, store: VariableStore): boolean {
  let e = expr.trim();
  // Strip a wrapping paren group: (….)
  while (e.startsWith("(") && matchingParen(e) === e.length - 1) e = e.slice(1, -1).trim();
  // Re-enter the precedence chain for any top-level boolean ops BEFORE handling `!`
  // (which binds tighter than `&&`/`||`) — so `!(a && b) && c` parses as `(!(a&&b)) && c`,
  // not `!((a&&b) && c)`. A stripped group like `(a == "Pro" && b)` is handled here too.
  if (splitTop(e, "||").length > 1) return evalOr(e, store);
  if (splitTop(e, "&&").length > 1) return evalAnd(e, store);
  if (e.startsWith("!")) return !evalFactor(e.slice(1), store);

  for (const op of ["==", "!=", "<=", ">=", "<", ">"] as const) {
    const at = findTopOperator(e, op);
    if (at >= 0) {
      const left = resolveValue(e.slice(0, at), store);
      const right = resolveValue(e.slice(at + op.length), store);
      return compare(left, right, op);
    }
  }
  return truthy(resolveValue(e, store));
}

function compare(a: VarValue | undefined, b: VarValue | undefined, op: string): boolean {
  const an = numeric(a);
  const bn = numeric(b);
  if (an !== undefined && bn !== undefined) {
    switch (op) {
      case "==": return an === bn;
      case "!=": return an !== bn;
      case "<": return an < bn;
      case ">": return an > bn;
      case "<=": return an <= bn;
      case ">=": return an >= bn;
    }
  }
  const as = a === undefined ? "" : String(a);
  const bs = b === undefined ? "" : String(b);
  switch (op) {
    case "==": return as === bs;
    case "!=": return as !== bs;
    case "<": return as < bs;
    case ">": return as > bs;
    case "<=": return as <= bs;
    case ">=": return as >= bs;
    default: return false;
  }
}

function resolveValue(token: string, store: VariableStore): VarValue | undefined {
  const t = token.trim();
  if (t === "") return undefined;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return store.get(t);
}

function truthy(v: VarValue | undefined): boolean {
  return v !== undefined && v !== false && v !== 0 && v !== "" && v !== "0";
}

function numeric(v: VarValue | undefined): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
}

/** Split on a top-level operator (not inside quotes or parens). */
function splitTop(expr: string, op: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let last = 0;
  for (let i = 0; i <= expr.length - op.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && expr.startsWith(op, i)) {
      out.push(expr.slice(last, i));
      i += op.length - 1;
      last = i + 1;
    }
  }
  out.push(expr.slice(last));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function findTopOperator(expr: string, op: string): number {
  let depth = 0;
  let quote = "";
  for (let i = 0; i <= expr.length - op.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && expr.startsWith(op, i)) {
      // Don't mistake "<=" / ">=" / "==" / "!=" for the shorter "<" / ">".
      if ((op === "<" || op === ">") && expr[i + 1] === "=") continue;
      return i;
    }
  }
  return -1;
}

function matchingParen(expr: string): number {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
