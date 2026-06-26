import type { VarValue } from "./VariableStore";
import type { AssetTimeline } from "../data/timelineTypes";

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
  scriptKey: string | undefined;
  constructorRun = false;
  name: string;
  currentFrame = 0;
  playing = true;
  /** Last frame whose frame-script has run, so entry scripts run exactly once. */
  enteredFrame = -1;
  /** depth -> child clip (sprite instances only). */
  readonly childClips = new Map<number, ClipInstance>();
  /** Runtime-created children from AVM1 attachMovie(), keyed by depth. */
  readonly dynamicInstances = new Map<number, {
    depth: number;
    characterId: number;
    placedFrame: number;
    matrix: { a: number; b: number; c: number; d: number; tx: number; ty: number };
    opacity: number;
    name: string;
  }>();
  /** Last non-empty PlaceObject instance name seen at each depth in this clip. */
  readonly depthNames = new Map<number, string>();
  /** Per-clip timeline variables (AVM1 unqualified vars like `btnDown`/`labelHidden` are local
   *  to the clip they're written on; dotted/global paths stay in the shared VariableStore). */
  readonly locals: Record<string, VarValue | undefined> = {};
  /** Arbitrary AS2 fields assigned to this MovieClip (`clip.id`, `clip.buttons`, etc.). */
  readonly props: Record<string, VarValue | undefined> = {};
  /** Runtime display properties for named non-MovieClip children (text/shape/image leaves). */
  readonly leafProps = new Map<string, Record<string, VarValue | undefined>>();
  /** Named leaves whose content/display properties were mutated by runtime AS. */
  readonly mutatedLeaves = new Set<string>();
  /** True once runtime AS creates/removes child display objects under this clip. */
  displayListMutated = false;
  /** Runtime display-object property overrides written by AVM1 (`clip._visible = false`, etc.). */
  visible: boolean | undefined;
  alpha: number | undefined;
  x: number | undefined;
  y: number | undefined;
  placedX = 0;
  placedY = 0;
  rotation: number | undefined;
  width: number | undefined;
  height: number | undefined;
  xscale: number | undefined;
  yscale: number | undefined;
  depthOverride: number | undefined;
  maskClip: ClipInstance | undefined;
  /** Timeline loaded at runtime through MovieClipLoader/loadMovie into this clip. */
  loadedTimeline: AssetTimeline | undefined;
  loadedFrame = 0;
  loadedPlaying = false;

  constructor(characterId: number, name: string, parent: ClipInstance | null) {
    this.characterId = characterId;
    this.name = name;
    this.parent = parent;
  }
}
