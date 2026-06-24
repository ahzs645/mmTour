// Pure RenderNode builders + asset/clip predicates used by the Player's flatten/
// reconcile passes. No Player state — plain functions over assets, clips and matrices.

import { ClipInstance } from "./ClipInstance";
import { clamp, type RenderNode, type RenderPlacementMetadata } from "./types";
import type { ColorTransform, TimelineAsset, TimelineFrame } from "../data/timelineTypes";

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

export function renderMetadataFromInstance(instance: TimelineFrame["instances"][number]): RenderPlacementMetadata {
  const metadata: RenderPlacementMetadata = {};
  if (instance.visible !== undefined) metadata.visible = instance.visible;
  if (instance.blendMode !== undefined) metadata.blendMode = instance.blendMode;
  if (instance.filters !== undefined) metadata.filters = instance.filters;
  if (instance.cacheAsBitmap !== undefined) metadata.cacheAsBitmap = instance.cacheAsBitmap;
  if (instance.className !== undefined) metadata.className = instance.className;
  if (instance.clipActions !== undefined) metadata.clipActions = instance.clipActions;
  return metadata;
}

export function composeRenderColorTransform(parent: ColorTransform | undefined, child: ColorTransform | undefined): ColorTransform | undefined {
  if (!parent) return child;
  if (!child) return parent;
  const rm = (child.rm ?? 1) * (parent.rm ?? 1);
  const gm = (child.gm ?? 1) * (parent.gm ?? 1);
  const bm = (child.bm ?? 1) * (parent.bm ?? 1);
  const am = (child.am ?? 1) * (parent.am ?? 1);
  const ra = (child.ra ?? 0) * (parent.rm ?? 1) + (parent.ra ?? 0);
  const ga = (child.ga ?? 0) * (parent.gm ?? 1) + (parent.ga ?? 0);
  const ba = (child.ba ?? 0) * (parent.bm ?? 1) + (parent.ba ?? 0);
  const aa = (child.aa ?? 0) * (parent.am ?? 1) + (parent.aa ?? 0);
  if (rm === 1 && gm === 1 && bm === 1 && am === 1 && ra === 0 && ga === 0 && ba === 0 && aa === 0) return undefined;
  return { rm, gm, bm, am, ra, ga, ba, aa };
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
    ...renderMetadataFromInstance(instance),
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
    ...renderMetadataFromInstance(instance),
    buttonOwnerPath: ownerPath,
  };
}
