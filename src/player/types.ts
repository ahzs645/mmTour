import type { AssetKind, ColorTransform, DynamicText, Matrix, Origin } from "../data/timelineTypes";

/**
 * One resolved item to draw for the current composite frame. Produced by the
 * Player each tick and handed to the DomRenderer, which diffs it against the
 * live DOM by depth.
 */
export type RenderNode = {
  depth: number;
  characterId: number;
  kind: AssetKind;
  name: string;
  /** Current artwork URL for this node (sprite frame, shape, image, button state). */
  src: string;
  origin: Origin;
  matrix: Matrix;
  opacity: number;
  colorTransform?: ColorTransform;
  clipDepth?: number;
  /** Styling + content for dynamic/static text fields. */
  text?: DynamicText;
  /** The clip's own playhead frame, when this node is a sprite (for debug). */
  spriteFrame?: number;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
