/** Builds real GSAP tween segments that drive a track's matrix + opacity. */

import type { gsap } from "gsap";
import type { GsapSceneKeyframe, RuntimeTrack } from "./types";

export function buildTrackTweens(
  master: gsap.core.Timeline,
  runtime: RuntimeTrack,
  fps: number,
) {
  const { track, state } = runtime;
  const writeState = () => applyState(runtime);
  const first = track.keys[0];

  // Initialise at the track's birth time, then chain a tween per segment.
  master.set(state, { ...stateOf(first), onUpdate: writeState }, track.birthTime);

  for (let i = 0; i < track.keys.length - 1; i += 1) {
    const from = track.keys[i];
    const to = track.keys[i + 1];
    const duration = (to.frame - from.frame) / fps;
    if (duration <= 0) {
      master.set(state, { ...stateOf(to), onUpdate: writeState }, to.frame / fps);
      continue;
    }
    master.to(state, {
      ...stateOf(to),
      duration,
      ease: "none",
      onUpdate: writeState,
    }, from.frame / fps);
  }
}

export function applyState(runtime: RuntimeTrack) {
  const { a, b, c, d, tx, ty, opacity } = runtime.state;
  runtime.element.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`;
  runtime.element.style.opacity = String(opacity);
}

export function stateOf(key: GsapSceneKeyframe | undefined) {
  return {
    a: key?.a ?? 1,
    b: key?.b ?? 0,
    c: key?.c ?? 0,
    d: key?.d ?? 1,
    tx: key?.tx ?? 0,
    ty: key?.ty ?? 0,
    opacity: key?.opacity ?? 1,
  };
}
