// Pure AVM1 target/path helpers. These describe how a target was written and
// what scope it starts from; resolving the segments to ClipInstances stays in
// Player so path parsing remains independently testable.

export type Avm1PathBase =
  | { kind: "relative" }
  | { kind: "this" }
  | { kind: "parent" }
  | { kind: "root" }
  | { kind: "global" }
  | { kind: "level"; level: number };

export type Avm1PathSegment =
  | { kind: "name"; name: string }
  | { kind: "parent" };

export type Avm1PathSyntax = "empty" | "bare" | "dot" | "slash";

export type Avm1TargetPath = {
  raw: string;
  /** The part before a target:label separator. Empty when the input is only a label. */
  target: string;
  /** Frame label from AVM1 target:label syntax, if present. */
  label?: string;
  syntax: Avm1PathSyntax;
  base: Avm1PathBase;
  segments: Avm1PathSegment[];
};

export type Avm1TargetLabel = {
  target: string;
  label?: string;
};

const LEVEL_SEGMENT = /^_level(\d+)$/i;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Split an AVM1 target string into target and optional frame label.
 *
 * Flash accepts values such as `_level4:segStart` and `/nav/pro:over`.
 * The colon is only recognized outside quotes and bracket/paren nesting, which
 * keeps this helper usable on raw extracted expressions as well as literals.
 */
export function splitAvm1TargetLabel(raw: string | undefined): Avm1TargetLabel {
  const text = stripOuterQuotes(raw ?? "").trim();
  if (!text) return { target: "" };

  let quote = "";
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[") depth += 1;
    else if ((c === ")" || c === "]") && depth > 0) depth -= 1;
    else if (c === ":" && depth === 0) {
      const target = text.slice(0, i).trim();
      const label = text.slice(i + 1).trim();
      return label ? { target, label } : { target };
    }
  }
  return { target: text };
}

/** Parse an AVM1 display-object target path without resolving it.
 *
 * Supports dot paths (`_root.nav.button`), slash paths (`/nav/button`,
 * `../label`), scope aliases (`this`, `_root`, `_parent`, `_global`),
 * absolute levels (`_level6.nav`), parent traversal (`..`) and target:label.
 */
export function parseAvm1TargetPath(raw: string | undefined): Avm1TargetPath {
  const original = raw ?? "";
  const { target, label } = splitAvm1TargetLabel(original);
  const syntax = pathSyntax(target);
  const tokens = syntax === "slash" ? tokenizeSlashPath(target) : tokenizeDotPath(target);
  const startsAtRoot = syntax === "slash" && target.trim().startsWith("/");
  const { base, offset } = parseBase(tokens, startsAtRoot);
  const segments = tokens.slice(offset).flatMap(parseSegment);
  return {
    raw: original,
    target,
    label,
    syntax,
    base,
    segments,
  };
}

export function isAvm1LevelName(name: string): boolean {
  return LEVEL_SEGMENT.test(name.trim());
}

export function parseAvm1LevelName(name: string): number | undefined {
  const match = LEVEL_SEGMENT.exec(name.trim());
  if (!match) return undefined;
  const level = Number(match[1]);
  return Number.isSafeInteger(level) && level >= 0 ? level : undefined;
}

export function isAvm1RelativePath(path: Avm1TargetPath): boolean {
  return path.base.kind === "relative" || path.base.kind === "this" || path.base.kind === "parent";
}

export function isAvm1AbsolutePath(path: Avm1TargetPath): boolean {
  return !isAvm1RelativePath(path);
}

export function isAvm1SelfTarget(raw: string | undefined): boolean {
  const path = parseAvm1TargetPath(raw);
  return !path.label && path.segments.length === 0 && (path.base.kind === "relative" || path.base.kind === "this");
}

export function avm1PathBaseEquals(a: Avm1PathBase, b: Avm1PathBase): boolean {
  return a.kind === b.kind && (a.kind !== "level" || (b.kind === "level" && a.level === b.level));
}

/** Convert a parsed path back to a canonical dot-style target string. */
export function serializeAvm1TargetPath(path: Avm1TargetPath, includeLabel = true): string {
  const parts = [
    ...baseParts(path.base),
    ...path.segments.map((segment) => segment.kind === "parent" ? ".." : segment.name),
  ];
  const target = parts.join(".");
  return includeLabel && path.label ? `${target}:${path.label}` : target;
}

/** Return a normalized path value for stable comparisons in callers/tests. */
export function normalizeAvm1TargetPath(raw: string | undefined): string {
  return serializeAvm1TargetPath(parseAvm1TargetPath(raw));
}

export function avm1PathNames(path: Avm1TargetPath): string[] {
  return path.segments.flatMap((segment) => segment.kind === "name" ? [segment.name] : []);
}

export function isSimpleAvm1Name(value: string): boolean {
  return IDENTIFIER.test(value.trim());
}

function pathSyntax(target: string): Avm1PathSyntax {
  const text = target.trim();
  if (!text) return "empty";
  if (text.includes("/")) return "slash";
  if (text.includes(".")) return "dot";
  return "bare";
}

function tokenizeSlashPath(target: string): string[] {
  return target.trim().split("/").map((part) => part.trim()).filter(Boolean);
}

function tokenizeDotPath(target: string): string[] {
  const text = target.trim();
  if (!text) return [];
  if (text === ".") return [];
  if (text === "..") return [".."];
  return text.split(".").map((part) => part.trim()).filter(Boolean);
}

function parseBase(tokens: string[], startsAtRoot: boolean): { base: Avm1PathBase; offset: number } {
  if (startsAtRoot) return { base: { kind: "root" }, offset: 0 };
  const first = tokens[0] ?? "";
  const level = parseAvm1LevelName(first);
  if (level !== undefined) return { base: { kind: "level", level }, offset: 1 };

  switch (first.toLowerCase()) {
    case "":
      return { base: { kind: "relative" }, offset: 0 };
    case "self":
    case "this":
      return { base: { kind: "this" }, offset: 1 };
    case "root":
    case "_root":
      return { base: { kind: "root" }, offset: 1 };
    case "_global":
      return { base: { kind: "global" }, offset: 1 };
    case "_parent":
    case "..":
      return { base: { kind: "parent" }, offset: 1 };
    default:
      return { base: { kind: "relative" }, offset: 0 };
  }
}

function parseSegment(token: string): Avm1PathSegment[] {
  if (!token || token === "." || token.toLowerCase() === "this" || token.toLowerCase() === "self") return [];
  if (token === ".." || token.toLowerCase() === "_parent") return [{ kind: "parent" }];
  return [{ kind: "name", name: token }];
}

function baseParts(base: Avm1PathBase): string[] {
  switch (base.kind) {
    case "relative":
      return [];
    case "this":
      return ["this"];
    case "parent":
      return [".."];
    case "root":
      return ["_root"];
    case "global":
      return ["_global"];
    case "level":
      return [`_level${base.level}`];
  }
}

function stripOuterQuotes(value: string): string {
  const text = value.trim();
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1);
  return text;
}
