// AVM1 object member get/set + object predicate for the Direct renderer.

import type { Avm1Object, Avm1Primitive, Avm1Value } from "./GsapSwfRenderer.types";
import { isAvm1Function, isDisplayTarget } from "./avm1Values";

export function getAvm1Member(target: Avm1Value, memberName: string): Avm1Value {
  if (!target || typeof target !== 'object' || isAvm1Function(target)) {
    return undefined;
  }

  if (isDisplayTarget(target)) {
    return undefined;
  }

  return (target as Avm1Object)[memberName];
}

export function setAvm1Member(target: Avm1Value, memberName: string, value: Avm1Value) {
  if (!target || typeof target !== 'object' || isAvm1Function(target)) {
    return;
  }

  if (isDisplayTarget(target)) {
    return;
  }

  (target as Avm1Object)[memberName] = value;
}

export function isAvm1Object(value: Avm1Value): value is Avm1Object {
  return Boolean(value && typeof value === 'object' && !isDisplayTarget(value) && !isAvm1Function(value));
}

export function assignAvm1Global(globals: Map<string, Avm1Value>, path: string, value: Avm1Primitive) {
  const segments = path.split('.').filter(Boolean);
  if (segments.length === 0) return;

  if (segments.length === 1) {
    globals.set(segments[0], value);
    return;
  }

  const [rootName, ...memberPath] = segments;
  let target = globals.get(rootName);
  if (!isAvm1Object(target)) {
    target = {};
    globals.set(rootName, target);
  }

  let objectTarget = target as Avm1Object;
  for (const segment of memberPath.slice(0, -1)) {
    const next = objectTarget[segment];
    if (!isAvm1Object(next)) {
      objectTarget[segment] = {};
    }
    objectTarget = objectTarget[segment] as Avm1Object;
  }

  objectTarget[memberPath[memberPath.length - 1]] = value;
}
