import type { CompiledScene } from "./compileScene.ts";

const enc = new TextEncoder();

type Primitive = string | number | boolean;

/**
 * Propagate stable, primitive root defaults through a compiled SWF dependency graph.
 * A child SWF only inherits when it has no own global defaults and its control data
 * references the inherited key. This mirrors Flash's shared _level0 state without
 * assuming any particular tour scene names.
 */
export function applyInheritedDefaultsGraph(root: CompiledScene, scenes: Iterable<CompiledScene>): boolean {
  const byScene = new Map<string, CompiledScene>();
  for (const scene of scenes) byScene.set(canonical(scene.scene), scene);

  let changed = false;
  const visited = new Set<string>();
  const visit = (scene: CompiledScene, inherited: Record<string, Primitive>) => {
    const key = canonical(scene.scene);
    if (visited.has(key)) return;
    visited.add(key);

    const carried = { ...inherited, ...collectInheritableGlobalDefaults(scene) };
    const startup = startupDependencyKeys(scene);
    for (const dep of scene.dependencies ?? []) {
      const child = byScene.get(canonical(dep.swf));
      if (!child) continue;
      if (!startup.has(canonical(dep.swf)) && applyInheritedGlobalDefaults(child, carried)) changed = true;
      visit(child, carried);
    }
  };

  visit(root, {});
  return changed;
}

export function collectInheritableGlobalDefaults(compiled: CompiledScene): Record<string, Primitive> {
  const defaults = compiled.timeline?.control?.globalDefaults ?? {};
  const out: Record<string, Primitive> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (!isPrimitive(value) || !isSimpleDottedName(key)) continue;
    out[key] = value;
  }
  return out;
}

export function applyInheritedGlobalDefaults(compiled: CompiledScene, inherited: Record<string, Primitive>): boolean {
  if (!Object.keys(inherited).length) return false;

  const control = (compiled.timeline.control ??= {});
  const existing = control.globalDefaults ?? {};
  if (Object.keys(existing).length) return false;

  const serializedControl = JSON.stringify(control);
  const namespaces = new Set<string>();
  for (const [key, value] of Object.entries(inherited)) {
    if (referencesKey(serializedControl, key)) namespaces.add(namespaceOf(key));
  }
  if (!namespaces.size) return false;

  const next: Record<string, Primitive> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (namespaces.has(namespaceOf(key))) next[key] = value;
  }
  if (!Object.keys(next).length) return false;

  control.globalDefaults = next;
  syncTimelineFile(compiled);
  return true;
}

function syncTimelineFile(compiled: CompiledScene) {
  compiled.files.set("timeline.json", {
    type: "application/json",
    bytes: enc.encode(JSON.stringify(compiled.timeline)),
  });
}

function referencesKey(serialized: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])(?:_level\\d+\\.|_root\\.)?${escaped}(?=$|[^A-Za-z0-9_$])`).test(serialized);
}

function namespaceOf(key: string): string {
  return key.split(".")[0] ?? key;
}

function startupDependencyKeys(compiled: CompiledScene): Set<string> {
  return new Set((compiled.timeline?.control?.frameActions ?? [])
    .flatMap((frame: any) => frame.actions ?? [])
    .filter((action: any) => action.swf && !action.functionName)
    .map((action: any) => canonical(String(action.swf))));
}

function isPrimitive(value: unknown): value is Primitive {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isSimpleDottedName(key: string): boolean {
  return /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(key);
}

function canonical(name: string): string {
  return name.replace(/\.swf$/i, "").replace(/[^\w.-]+/g, "-").toLowerCase();
}
