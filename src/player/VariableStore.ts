/**
 * A flat key/value store for the AVM1 variables a tour reads at runtime
 * (e.g. `bkgd.OSVersion`, `bkgd.blnDisableSkip`). Seeded from each timeline's
 * extracted `control.globalDefaults`, it lets the player evaluate the SWF's own
 * `functionBranchCondition`s instead of hard-coding scene behaviour — so an
 * unrelated SWF with different defaults is interpreted from its own data.
 *
 * Names are normalised by stripping a leading `_levelN.`, `_root.` or `_parent.`
 * so that `_level0.bkgd.OSVersion`, `_root.bkgd.OSVersion` and `bkgd.OSVersion`
 * are the same slot. Tour globals live on `_level0`, which every level references,
 * so a single shared store mirrors the runtime's shared global scope. `_parent.` is
 * stripped too: the store is flat (no per-clip nesting), so a clip reading
 * `_parent.t_musicOn` resolves the same root-level variable (clip targeting, which
 * IS relative, goes through resolveTarget — not the store).
 */
export type VarValue = string | number | boolean;

const LEVEL_PREFIX = /^_(?:level\d+|root|parent)\./;

export function normalizeVarName(name: string): string {
  let out = name.trim();
  // Collapse repeated level prefixes (`_level0._level0.x` is malformed but cheap to guard).
  while (LEVEL_PREFIX.test(out)) out = out.replace(LEVEL_PREFIX, "");
  return out;
}

export class VariableStore {
  private readonly values = new Map<string, VarValue>();

  /** Merge a timeline's `globalDefaults` (does not overwrite already-set vars). */
  seed(defaults: Record<string, unknown> | undefined) {
    if (!defaults) return;
    for (const [key, value] of Object.entries(defaults)) {
      const name = normalizeVarName(key);
      if (!this.values.has(name) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
        this.values.set(name, value);
      }
    }
  }

  get(name: string): VarValue | undefined {
    return this.values.get(normalizeVarName(name));
  }

  set(name: string, value: VarValue) {
    this.values.set(normalizeVarName(name), value);
  }

  has(name: string): boolean {
    return this.values.has(normalizeVarName(name));
  }

  /** Drop every variable (when switching tours). */
  reset() {
    this.values.clear();
  }
}
