/** Timeline control flow: stop frames, label resolution, and goto navigation. */

import type { GsapSceneControl, SceneNavAction } from "./types";

export class ControlFlow {
  private stops: Set<number>;
  private navByFrame: Map<number, SceneNavAction>;
  private labels: Record<string, number>;

  constructor(control: GsapSceneControl | undefined, labels: Record<string, number> | undefined) {
    this.stops = new Set(control?.stopFrames ?? []);
    this.navByFrame = new Map((control?.nav ?? []).map((nav) => [nav.frame, nav]));
    this.labels = labels ?? {};
  }

  isStop(frame: number): boolean {
    return this.stops.has(frame);
  }

  navAt(frame: number): SceneNavAction | undefined {
    return this.navByFrame.get(frame);
  }

  resolveLabel(label: string): number | undefined {
    return this.labels[label];
  }
}
