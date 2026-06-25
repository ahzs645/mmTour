// Pure timeline structure builders: per-frame display lists, sprite sub-timelines,
// overflow detection, entry-frame resolution. Operate on the parsed FFDec tags/assets.

import { asArray, compactObject } from "./util.mjs";
import { identityMatrix, matrixFromTag, opacityFromTag, colorTransformFromTag } from "./geom.mjs";

export function buildFrames(allTags) {
  const displayList = new Map();
  const snapshots = [];
  let label = "";

  for (const tag of allTags) {
    if (!tag?.type) continue;

    if (tag.type === "FrameLabelTag") {
      label = tag.name ?? label;
      continue;
    }

    if (tag.type === "RemoveObject2Tag") {
      displayList.delete(Number(tag.depth));
      continue;
    }

    if (tag.type === "PlaceObject2Tag") {
      const depth = Number(tag.depth);
      const existing = displayList.get(depth) ?? { depth, characterId: 0, matrix: identityMatrix(), opacity: 1, name: "" };
      const characterId = Number(tag.characterId);
      const hasNewCharacter = characterId > 0;
      const clipDepth = Number(tag.clipDepth) || 0;
      const next = {
        ...existing,
        depth,
        characterId: hasNewCharacter ? characterId : existing.characterId,
        placedFrame: hasNewCharacter ? snapshots.length : existing.placedFrame ?? snapshots.length,
        name: tag.name ?? existing.name,
        matrix: tag.matrix ? matrixFromTag(tag.matrix) : existing.matrix,
        opacity: tag.colorTransform ? opacityFromTag(tag.colorTransform) : existing.opacity,
        // Colour tint (RGB mult+add) lives on the placement, separate from alpha.
        colorTransform: tag.colorTransform ? colorTransformFromTag(tag.colorTransform) : existing.colorTransform,
        // A PlaceObject2 with clipDepth > 0 is a mask clipping depths (depth, clipDepth].
        clipDepth: clipDepth > 0 ? clipDepth : hasNewCharacter ? undefined : existing.clipDepth,
      };
      displayList.set(depth, next);
      continue;
    }

    if (tag.type === "ShowFrameTag") {
      snapshots.push({
        index: snapshots.length,
        label,
        instances: [...displayList.values()]
          .filter((instance) => instance.characterId > 0)
          .sort((a, b) => a.depth - b.depth),
      });
      label = "";
    }
  }

  return snapshots;
}

export /**
 * Extract each DefineSprite's internal display-list timeline (the same way the
 * root timeline is built) and attach it to the sprite asset. This preserves the
 * nested MovieClip structure FFDec otherwise flattens into baked per-frame SVGs,
 * giving the runtime the data it needs to drive nested playheads and _parent/
 * _root navigation. Baked `frames[]` SVGs are kept for leaf rendering.
 */
function attachSpriteTimelines(assetDefs, allTags) {
  for (const tag of allTags) {
    if (tag?.type !== "DefineSpriteTag" || !tag.spriteId) continue;
    const id = String(tag.spriteId);
    const asset = assetDefs[id];
    if (!asset || asset.kind !== "sprite") continue;

    const subTags = asArray(tag.subTags?.item);
    const spriteFrames = buildFrames(subTags);
    // Only attach when there is an actual nested display list (placed children),
    // so trivial single-shape sprites don't bloat the timeline JSON.
    if (!spriteFrames.some((frame) => frame.instances.length)) continue;

    asset.timeline = spriteFrames.map((frame) => compactObject({
      index: frame.index,
      label: frame.label || undefined,
      instances: frame.instances,
    }));
  }
}

export /**
 * Flag sprites whose animated content slides OUTSIDE their own bounds — FFDec bakes each
 * frame clipped to the sprite bounds, so moving content (e.g. the nav cascade buttons
 * sliding vertically through their ~28px-tall *ProAnim sprites) gets dropped from the baked
 * frame, making it flicker. The runtime renders these from the display-list tree instead
 * (the instances persist there, unclipped). Skip sprites that use a clip-mask (clipDepth) —
 * those rely on the baked composite, which the tree can't reproduce.
 */
function markOverflowingSprites(assetDefs) {
  for (const asset of Object.values(assetDefs)) {
    if (asset?.kind !== "sprite" || !asset.timeline?.length || !asset.frames?.length) continue;
    const b = asset.origin;
    if (!b || !b.width || !b.height) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, hasMask = false, any = false;
    for (const frame of asset.timeline) {
      for (const ins of frame.instances ?? []) {
        if (ins.clipDepth) hasMask = true;
        const child = assetDefs[String(ins.characterId)] ?? assetDefs[`button:${ins.characterId}`];
        const o = child?.origin;
        if (!o || (!o.width && !o.height)) continue;
        const m = ins.matrix ?? { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
        for (const [cx, cy] of [[o.x, o.y], [o.x + o.width, o.y], [o.x, o.y + o.height], [o.x + o.width, o.y + o.height]]) {
          const x = m.a * cx + m.c * cy + m.tx;
          const y = m.b * cx + m.d * cy + m.ty;
          minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); any = true;
        }
      }
    }
    if (!any || hasMask) continue;
    const T = 20; // tolerance for minor/rounding overflow
    if (minX < b.x - T || minY < b.y - T || maxX > b.x + b.width + T || maxY > b.y + b.height + T) {
      asset.overflowsBounds = true;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const asset of Object.values(assetDefs)) {
      if (asset?.kind !== "sprite" || asset.overflowsBounds || !asset.timeline?.length) continue;
      const hasLiveChild = asset.timeline.some((frame) =>
        (frame.instances ?? []).some((ins) => assetDefs[String(ins.characterId)]?.overflowsBounds),
      );
      if (!hasLiveChild) continue;
      asset.overflowsBounds = true;
      changed = true;
    }
  }
}

export function discoverEntryFrame(frameLabels) {
  for (const label of ["noKiosk", "segStart", "desktop", "Code Setup"]) {
    if (label in frameLabels) return frameLabels[label];
  }
  return 0;
}
