import type { AssetKind, ColorTransform, DynamicText, Matrix, Origin } from "../data/timelineTypes";

/**
 * One resolved leaf to draw for the current composite frame. The Player walks
 * the nested clip tree, composes matrices to stage space, and emits these in
 * paint order. The DomRenderer diffs them by `key` (a stable tree path).
 */
export type RenderNode = {
  /** Stable identity across frames: the tree path of depths, e.g. "0/2/6". */
  key: string;
  /** Paint order (z-index) = tree traversal order. */
  order: number;
  characterId: number;
  kind: AssetKind;
  name: string;
  /** Current artwork URL (sprite frame, shape, image, button state). */
  src: string;
  origin: Origin;
  /** World matrix (composed parent→child) in stage space. */
  matrix: Matrix;
  opacity: number;
  colorTransform?: ColorTransform;
  clipDepth?: number;
  /** Styling + content for dynamic/static text fields. */
  text?: DynamicText;
  /** For buttons: the tree path of the owning clip, used to dispatch actions. */
  buttonOwnerPath?: string;
  /** The clip's own playhead frame, when this node is a sprite (for debug). */
  spriteFrame?: number;
  /**
   * When set, this node is a mask group: `mask` is the clipping shape and `items`
   * are the instances clipped to it (SWF clipDepth). Rendered as an inline SVG
   * alpha-mask. Matrices are already in stage space.
   */
  maskGroup?: {
    mask: MaskVisual;
    items: MaskVisual[];
  };
};

export type MaskVisual = {
  characterId: number;
  src: string;
  origin: { x: number; y: number; width: number; height: number };
  matrix: import("../data/timelineTypes").Matrix;
  opacity: number;
  colorTransform?: ColorTransform;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
