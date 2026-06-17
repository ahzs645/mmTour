// Pure AVM1 value coercions + variable/property helpers for the Direct SWF renderer.
// No renderer state — plain functions over Avm1 values and the display list.

import type {
  Avm1FunctionDef, Avm1Value, DisplayBinding, DisplayEntry, MovieTimelineState, TimelineState,
} from "./GsapSwfRenderer.types";

export function getAvm1Property(target: Avm1Value, propertyIndex: number, currentFrame: number | undefined): Avm1Value {
  if ((target === '' || target === null || target === undefined) && propertyIndex === 4 && currentFrame !== undefined) {
    return currentFrame + 1;
  }
  return undefined;
}

export function resolveAvm1Variable(
  name: string,
  displayList?: Map<number, DisplayEntry | DisplayBinding>,
  globals?: Map<string, Avm1Value>,
): Avm1Value {
  if (globals?.has(name)) {
    return globals.get(name);
  }

  if (!displayList) return undefined;

  for (const [, entry] of displayList) {
    if (entry.instanceName === name) {
      return entry;
    }
  }

  return undefined;
}

export function setAvm1Variable(name: string, value: Avm1Value, globals?: Map<string, Avm1Value>) {
  if (!globals) return;
  globals.set(name, value);
}

export function clampFrame(frame: number, frameCount: number, wrap = false): number {
  if (frameCount <= 0) return 0;
  if (wrap) {
    return ((frame % frameCount) + frameCount) % frameCount;
  }
  return Math.max(0, Math.min(frame, frameCount - 1));
}

export function toAvm1Boolean(value: Avm1Value): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  return Boolean(value);
}

export function toAvm1Number(value: Avm1Value): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function toAvm1String(value: Avm1Value): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return '';
}

export function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function isDisplayTarget(value: Avm1Value): value is DisplayEntry | DisplayBinding {
  return Boolean(value && typeof value === 'object' && 'characterId' in value && 'depth' in value);
}

export function isAvm1Function(value: Avm1Value): value is Avm1FunctionDef {
  return Boolean(value && typeof value === 'object' && 'body' in value && 'params' in value);
}

export function isMovieTimelineState(state: TimelineState | MovieTimelineState): state is MovieTimelineState {
  return 'globals' in state;
}
