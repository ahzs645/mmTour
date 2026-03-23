import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRufflePlayer, initRuffle, type RufflePlayer as RufflePlayerElement } from '../engine/RuffleLoader';

interface RufflePlayerProps {
  swfUrl: string;
  overlay?: ReactNode;
}

export function RufflePlayer({ swfUrl, overlay }: RufflePlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<RufflePlayerElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);

        await initRuffle();
        if (cancelled || !hostRef.current) return;

        const host = hostRef.current;
        host.innerHTML = '';

        const player = createRufflePlayer();
        player.style.width = '100%';
        player.style.height = '100%';
        player.style.display = 'block';
        player.style.background = '#ffffff';
        playerRef.current = player;
        host.appendChild(player);

        await player.load({ url: swfUrl });
        if (cancelled) return;

        player.play();
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load Ruffle');
        setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        playerRef.current.destroy();
      } else if (playerRef.current) {
        playerRef.current.remove();
      }
      playerRef.current = null;
      if (hostRef.current) {
        hostRef.current.innerHTML = '';
      }
    };
  }, [swfUrl]);

  return (
    <div className="ruffle-shell">
      <div className="ruffle-stage-frame">
        <div ref={hostRef} className="ruffle-stage-host" />
        {overlay}

        {loading && (
          <div className="ruffle-overlay">
            <div className="ruffle-overlay-title">Loading original Flash tour...</div>
            <div className="ruffle-overlay-copy">Ruffle is booting and streaming the SWF.</div>
          </div>
        )}

        {error && (
          <div className="ruffle-overlay ruffle-overlay-error">
            <div className="ruffle-overlay-title">Ruffle failed to start</div>
            <div className="ruffle-overlay-copy">{error}</div>
          </div>
        )}
      </div>
    </div>
  );
}
