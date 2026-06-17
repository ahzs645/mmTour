// Movie-level AVM1 timeline-state construction/cloning for the Direct renderer.

import type { Avm1Object, Avm1Value, MovieTimelineState, SpritePlaybackState } from "./GsapSwfRenderer.types";
import { isAvm1Function, isDisplayTarget } from "./avm1Values";

export function createInitialMovieTimelineState(): MovieTimelineState {
  const root: Avm1Object = {};
  const background: Avm1Object = {
    AttractLoopWaitTime: 2000,
    kioskModeWaitTime: 2000,
    kioskModeWaitLong: 5000,
    doKioskMode: true,
    currScene: '',
    VOvol: 100,
    vo: {},
  };
  const nav: Avm1Object = {
    targSection: '',
  };
  const level4: Avm1Object = {};

  root.bkgd = background;
  root.nav = nav;

  const globals = new Map<string, Avm1Value>([
    ['_level0', root],
    ['_root', root],
    ['this', root],
    ['bkgd', background],
    ['nav', nav],
    ['_level4', level4],
  ]);

  return {
    currentFrame: 0,
    isPlaying: true,
    globals,
    playbackOverridesByName: new Map<string, SpritePlaybackState>(),
    timeMarkTick: null,
  };
}

export function cloneMovieTimelineState(state: MovieTimelineState): MovieTimelineState {
  const globals = new Map<string, Avm1Value>();
  const clonedObjects = new Map<Avm1Object, Avm1Object>();

  const cloneValue = (value: Avm1Value): Avm1Value => {
    if (!value || typeof value !== 'object') {
      return value;
    }

    if (isDisplayTarget(value) || isAvm1Function(value)) {
      return value;
    }

    const objectValue = value as Avm1Object;
    if (clonedObjects.has(objectValue)) {
      return clonedObjects.get(objectValue)!;
    }

    const clone: Avm1Object = {};
    clonedObjects.set(objectValue, clone);
    for (const [key, member] of Object.entries(objectValue)) {
      clone[key] = cloneValue(member);
    }
    return clone;
  };

  for (const [key, value] of state.globals) {
    globals.set(key, cloneValue(value));
  }

  return {
    currentFrame: state.currentFrame,
    isPlaying: state.isPlaying,
    globals,
    playbackOverridesByName: new Map(state.playbackOverridesByName),
    timeMarkTick: state.timeMarkTick,
  };
}
