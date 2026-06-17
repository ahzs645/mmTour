// Pure RenderNode builders + asset/clip predicates used by the Player's flatten/
// reconcile passes. No Player state — plain functions over assets, clips and matrices.

import { ClipInstance } from "./ClipInstance";
import { clamp, type RenderNode } from "./types";
import type { TimelineAsset, TimelineFrame } from "../data/timelineTypes";

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
    colorTransform: instance.colorTransform,
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
): RenderNode {
  // Buttons whose text is drawn by collectButtonText (editText overlay) must NOT also
  // render their up-state artwork — FFDec bakes that text mispositioned, so it would
  // double the label (e.g. the nav "Skip Intro"). The overlay is the authoritative text.
  const up = renderArtwork && !asset.textFields?.length ? asset.states?.up : undefined;
  return {
    key,
    order,
    characterId: asset.id,
    kind: "button",
    name: instance.name,
    src: up?.src ?? "",
    origin: up?.origin ?? asset.origin,
    matrix,
    opacity: up?.src ? opacity : 1,
    buttonOwnerPath: ownerPath,
  };
}
