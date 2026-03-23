import type { ReactNode } from 'react';

interface ReferenceFramePlayerProps {
  frame: number;
  totalFrames: number;
  srcBase?: string;
  overlay?: ReactNode;
}

export function ReferenceFramePlayer({
  frame,
  totalFrames,
  srcBase = '/intro/frames',
  overlay,
}: ReferenceFramePlayerProps) {
  const clampedFrame = Math.max(0, frame);
  const sourceFrame = clampedFrame + 1;

  return (
    <div className="reference-frame-shell">
      <div className="reference-frame-stage">
        <img
          key={sourceFrame}
          className="reference-frame-image"
          src={`${srcBase}/${sourceFrame}.png`}
          alt={`Extracted reference frame ${clampedFrame}`}
          draggable={false}
        />
        {overlay}
        <div className="reference-frame-meta">
          Frame {clampedFrame}
          {totalFrames > 0 ? ` / ${totalFrames - 1}` : ''}
        </div>
      </div>
    </div>
  );
}
