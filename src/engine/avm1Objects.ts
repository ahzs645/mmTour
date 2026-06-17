// AVM1 object member get/set + object predicate for the Direct renderer.

import type { Avm1Object, Avm1Value } from "./GsapSwfRenderer.types";
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
