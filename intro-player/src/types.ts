// Timeline data types

export interface Transform {
  sx: number;  // scaleX
  sy: number;  // scaleY
  r0: number;  // rotateSkew0
  r1: number;  // rotateSkew1
  tx: number;  // translateX (pixels)
  ty: number;  // translateY (pixels)
}

export interface ColorTransform {
  am?: number; // alpha multiplier (0-1)
  rm?: number; // red multiplier (0-1)
  gm?: number; // green multiplier (0-1)
  bm?: number; // blue multiplier (0-1)
  // Additive terms (raw 0-255 values, can be negative)
  aa?: number; // alpha add
  ra?: number; // red add
  ga?: number; // green add
  ba?: number; // blue add
}

export interface PlaceCommand {
  d: number;   // depth
  c?: string;  // characterId
  m?: number;  // move flag (update existing)
  t?: Transform;
  ct?: ColorTransform;
  cd?: number; // clipDepth (if this is a mask)
}

export interface FrameData {
  place: PlaceCommand[];
  remove: number[];
}

export interface TimelineMeta {
  fps: number;
  frames: number;
  width: number;
  height: number;
}

export interface CharacterData {
  type: string;
  id: string;
  contains?: string;  // For sprites: the shape ID contained within
  innerTransform?: Transform;  // For sprites: the internal transform
  text?: string;
  color?: string;
  fontSize?: number;
  align?: string | number;
  width?: number;
  height?: number;
}

export interface TimelineData {
  meta: TimelineMeta;
  characters: Record<string, CharacterData>;
  timeline: FrameData[];
  assets: {
    shapes: string[];
    images: { id: string; ext: string }[];
  };
}

export interface DisplayObject {
  characterId: string;
  transform: Transform;
  colorTransform?: ColorTransform;
  clipDepth?: number;
  element?: HTMLDivElement | null;
}

export interface ClipRange {
  start: number;
  end: number;
  maskTransform?: Transform;
}
