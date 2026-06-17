// Sprite playback timing + timeline/ratio-sync predicates.

import type { SpritePlaybackState } from "./GsapSwfRenderer.types";
import type { SwfSpriteChar } from "./SwfParser";

export function getSpritePlaybackTick(
  currentRawFrame: number,
  placedAtFrame: number,
  ratio?: number,
): number {
  const startFrame = ratio !== undefined ? Math.floor(ratio) : placedAtFrame;
  return Math.max(0, currentRawFrame - startFrame);
}

export function getSpritePlaybackTickFromOverride(
  currentTick: number,
  playback: SpritePlaybackState,
): number {
  return Math.max(0, currentTick - playback.startedAtTick);
}

export function spriteForcesTimelineChildren(char: SwfSpriteChar): boolean {
  return [124, 131, 137, 144, 153, 159].includes(char.id);
}

export function spriteUsesRatioFrameSync(char: SwfSpriteChar): boolean {
  return [104, 105, 106, 110, 115].includes(char.id);
}
