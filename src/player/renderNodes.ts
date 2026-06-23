// Pure RenderNode builders + asset/clip predicates used by the Player's flatten/
// reconcile passes. No Player state — plain functions over assets, clips and matrices.

import { ClipInstance } from "./ClipInstance";
import { clamp, type RenderNode } from "./types";
import type { TimelineAsset, TimelineFrame } from "../data/timelineTypes";

export type ButtonVisualState = "up" | "over" | "down";

export function findChildByName(clip: ClipInstance, name: string): ClipInstance | null {
  for (const child of clip.childClips.values()) {
    if (child.name === name) return child;
  }
  return null;
}

export function isClipAsset(asset: TimelineAsset): boolean {
  return asset.kind === "sprite" && Boolean(asset.timeline?.length || asset.frames?.length);
}

/** The artwork URL an instance would render (for use as a mask shape or masked item). */
export function visualSrc(asset: TimelineAsset, child: ClipInstance | undefined): string {
  if (asset.kind === "sprite" && asset.frames?.length) {
    const frameIndex = child ? clamp(child.currentFrame, 0, asset.frames.length - 1) : 0;
    return asset.frames[frameIndex] ?? "";
  }
  if (asset.kind === "button") return asset.states?.up?.src ?? asset.src ?? "";
  return asset.src ?? "";
}

export function spriteNode(
  key: string,
  order: number,
  asset: TimelineAsset,
  src: string,
  matrix: RenderNode["matrix"],
  opacity: number,
  instance: TimelineFrame["instances"][number],
  spriteFrame?: number,
  colorTransform: RenderNode["colorTransform"] = instance.colorTransform,
): RenderNode {
  return {
    key,
    order,
    characterId: asset.id,
    kind: asset.kind,
    name: instance.name,
    src,
    origin: asset.origin,
    matrix,
    opacity,
    colorTransform,
    clipDepth: instance.clipDepth,
    spriteFrame,
  };
}

/**
 * A sized, interactive button node. In the baked path (collectButtons) the button's
 * visual is already in the composited sprite frame, so this is just a transparent hit
 * area (renderArtwork=false). In the tree path (flatten) there is no baked frame behind
 * it, so it carries its up-state artwork as the visual (renderArtwork=true) — buttons
 * whose up-state is empty (pure hit areas, e.g. the nav section buttons whose art is a
 * sibling shape) simply draw nothing, while buttons that ARE their own art (the kiosk
 * play/exit/sound icons) draw it. The owning clip's playhead still drives any rollover/
 * press animation via gotoAndPlay, so the artwork follows the live frame transform.
 */
export function buttonNode(
  key: string,
  order: number,
  asset: TimelineAsset,
  matrix: RenderNode["matrix"],
  instance: TimelineFrame["instances"][number],
  ownerPath: string,
  renderArtwork: boolean,
  opacity = 1,
  visualState?: ButtonVisualState,
  colorTransform: RenderNode["colorTransform"] = instance.colorTransform,
): RenderNode {
  // Tree path (renderArtwork=true): render the button's current artwork — normally its up-state
  // icon, switching to extracted over/down states while the pointer is active. The build
  // strips any embedded editText glyphs from that SVG (FFDec bakes them clipped/mispositioned),
  // so a button that wraps a bound field (segment5's Replay icon, the nav "Skip Intro") draws
  // just its icon here, and the caller overlays the live field value via collectButtonText —
  // giving icon + correct label with no doubling. Baked path passes renderArtwork=false: the
  // normal visual is already in the composited sprite frame, but pointer-active over/down art is
  // overlaid so SimpleButton-native highlights still appear.
  const active =
    visualState === "down"
      ? (asset.states?.down ?? asset.states?.over ?? asset.states?.up)
      : visualState === "over"
        ? (asset.states?.over ?? asset.states?.up)
        : asset.states?.up;
  const visual = renderArtwork || visualState ? active : undefined;
  return {
    key,
    order,
    characterId: asset.id,
    kind: "button",
    name: instance.name,
    src: visual?.src ?? "",
    origin: visual?.origin ?? asset.origin,
    matrix,
    opacity: visual?.src ? opacity : 1,
    colorTransform,
    buttonOwnerPath: ownerPath,
  };
}
