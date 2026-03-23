/**
 * RuffleLoader - Initializes Ruffle Flash emulator and provides player creation.
 *
 * Ruffle renders SWF files faithfully including ActionScript, sound,
 * buttons, text, and the Flash level system. GSAP handles orchestration.
 */

// Ruffle types (simplified from @ruffle-rs/ruffle)
export interface RufflePlayer extends HTMLElement {
  load(options: { url: string } | { data: ArrayBuffer }): Promise<void>;
  play(): void;
  pause(): void;
  suspend(): void;
  resume(): void;
  get isPlaying(): boolean;
  set volume(v: number);
  get volume(): number;
  get readyState(): number;
  destroy(): void;
}

interface RuffleAPI {
  newest?(): { createPlayer(): RufflePlayer } | null;
  config?: Record<string, unknown>;
}

declare global {
  interface Window {
    RufflePlayer?: RuffleAPI;
  }
}

let ruffleLoaded = false;
let loadPromise: Promise<void> | null = null;
const RUFFLE_SCRIPT_SRC = '/node_modules/@ruffle-rs/ruffle/ruffle.js';

/**
 * Load the Ruffle WASM module. Call this once at startup.
 * Returns a promise that resolves when Ruffle is ready.
 */
export async function initRuffle(): Promise<void> {
  if (ruffleLoaded) return;
  if (window.RufflePlayer?.newest?.()) {
    ruffleLoaded = true;
    return;
  }
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    // Configure Ruffle before loading
    window.RufflePlayer = window.RufflePlayer || {};
    window.RufflePlayer.config = {
      autoplay: 'on',
      unmuteOverlay: 'hidden',
      contextMenu: 'off',
      showSwfDownload: false,
      openUrlMode: 'deny',
      letterbox: 'on',
      warnOnUnsupportedContent: false,
      logLevel: 'warn',
    };

    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[data-ruffle-loader="true"][src="${RUFFLE_SCRIPT_SRC}"]`
      );

      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Failed to load Ruffle script')), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = RUFFLE_SCRIPT_SRC;
      script.async = true;
      script.dataset.ruffleLoader = 'true';
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new Error('Failed to load Ruffle script')), { once: true });
      document.head.appendChild(script);
    });

    if (!window.RufflePlayer?.newest?.()) {
      throw new Error('Ruffle script loaded but API is unavailable.');
    }

    ruffleLoaded = true;
  })();

  return loadPromise;
}

/**
 * Create a new Ruffle player element. Must call initRuffle() first.
 */
export function createRufflePlayer(): RufflePlayer {
  const ruffle = (window as unknown as { RufflePlayer: RuffleAPI }).RufflePlayer;
  const api = ruffle?.newest?.() as { createPlayer: () => RufflePlayer } | null | undefined;
  if (!api) {
    throw new Error('Ruffle not loaded. Call initRuffle() first.');
  }
  return api.createPlayer();
}
