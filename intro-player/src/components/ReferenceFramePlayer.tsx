interface ReferenceFramePlayerProps {
  frame: number;
  totalFrames: number;
}

export function ReferenceFramePlayer({ frame, totalFrames }: ReferenceFramePlayerProps) {
  const clampedFrame = Math.max(0, frame);
  const sourceFrame = clampedFrame + 1;

  return (
    <div className="reference-frame-shell">
      <div className="reference-frame-stage">
        <img
          key={sourceFrame}
          className="reference-frame-image"
          src={`/intro/frames/${sourceFrame}.png`}
          alt={`Extracted reference frame ${clampedFrame}`}
          draggable={false}
        />
        <div className="reference-frame-meta">
          Frame {clampedFrame}
          {totalFrames > 0 ? ` / ${totalFrames - 1}` : ''}
        </div>
      </div>
    </div>
  );
}
