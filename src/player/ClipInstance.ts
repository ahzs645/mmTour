import type { VarValue } from "./VariableStore";

/**
 * A node in the live display tree: one placed MovieClip (or the root). Holds its
 * own playhead and its persistent child clips (keyed by depth, so a child keeps
 * animating across its parent's frames). Leaves (shapes/images/text/buttons) are
 * not ClipInstances — they're re-read from the owning clip's frame at render
 * time. The Player owns all timeline data and drives advance/reconcile/scripts.
 */
export class ClipInstance {
  /** Sprite character id, or -1 for the root timeline. */
  readonly characterId: number;
  readonly parent: ClipInstance | null;
  name: string;
  currentFrame = 0;
  playing = true;
  /** Last frame whose frame-script has run, so entry scripts run exactly once. */
  enteredFrame = -1;
  /** depth -> child clip (sprite instances only). */
  readonly childClips = new Map<number, ClipInstance>();
  /** Last non-empty PlaceObject instance name seen at each depth in this clip. */
  readonly depthNames = new Map<number, string>();
  /** Per-clip timeline variables (AVM1 unqualified vars like `btnDown`/`labelHidden` are local
   *  to the clip they're written on; dotted/global paths stay in the shared VariableStore). */
  readonly locals: Record<string, VarValue | undefined> = {};

  constructor(characterId: number, name: string, parent: ClipInstance | null) {
    this.characterId = characterId;
    this.name = name;
    this.parent = parent;
  }
}
