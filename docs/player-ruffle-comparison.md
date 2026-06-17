# Decompiled Player ↔ Ruffle comparison

`npm run verify:player` (`scripts/compare-player-ruffle.mjs`) diffs the **Decompiled
Player** — the data-driven AVM1 runtime that is the focus of the project — against the
**Ruffle** reference, scene by scene.

This fills a gap: the older `npm run verify:runtime` compares Ruffle against the
**frame-SVG** reference and waits on frame-mode DOM (`#frameStageInline svg`,
`.flash-button-overlay`), none of which exists in `player` mode. So until now nothing
diffed the player itself against Ruffle.

## Why two signals

Pixel-diffing two independently free-running Flash renderers is noisy. The harness
separates content divergence (what we care about) from timing noise (what we don't):

- **settle diff** — once the player's root playhead holds (a `stop()` / waiting loop),
  both sides show the same static state. Captured with the player paused on its held
  frame. This is the trustworthy, low-noise signal and the one used for held scenes.
- **min-residual** — for a scene that *never* settles (a continuous animation like the
  intro), the harness captures a short Ruffle/Player time-series with the player
  **playing** and matches each player frame to its *closest* Ruffle frame. The residual
  measures content/layout divergence while cancelling animation timing phase.

The reported `signal` per scene is the settle diff when the scene settled, else the
min-residual median.

## Methodology caveats (read before "fixing" a divergence)

- **Seeking is not playback.** Dragging `#frameScrubber` rebuilds the root at that frame
  and re-enters every nested clip at frame 0, so a baked animation sprite (e.g.
  `mc_screenshot_3`) renders blank where the baked frame-SVG shows it mid-animation.
  That is a *seek artifact*, not a runtime bug — this harness compares under **natural
  playback** (no seeking) precisely to avoid it.
- **Standalone vs composite.** The tour is multi-SWF: A-tour (`_level0`) loads the intro
  into `_level4` and the nav into `_level6`. `nav.swf` on its own is blank in Ruffle until
  the shell loads it, so it is an expected skip (`EXPECTED_RUFFLE_BLANK`). A-tour compares
  as the composite the player assembles.
- **Animated scenes drift.** A high min-residual on a continuously-animating scene is
  usually timing phase over a coarse sampling window, not missing content — confirm by
  eye (the worst pair is saved) before treating it as a bug.

## Running

```sh
npm run verify:player                      # starts its own Vite dev server
VERIFY_URL=http://127.0.0.1:5190/ npm run verify:player   # reuse a running server
```

Tunables (env): `PLAYER_RUFFLE_SAMPLES`, `PLAYER_RUFFLE_GAP_MS`, `VERIFY_PORT`, and
`PLAYER_RUFFLE_STRICT=<MAD>` to make divergence above a threshold a hard failure
(otherwise the harness is report-only and exits non-zero only on a structural breakage
— no Ruffle embed, or the player rendering nothing). Output (screenshots +
`player-ruffle-report.json`, gitignored) lands in `verification/player-ruffle/`.

## Baseline findings (2026-06)

Player fidelity against Ruffle is strong. Mean-absolute pixel difference (0–255/channel):

| Scene | signal | state | note |
| --- | --- | --- | --- |
| Basics (segment5) | 0.37 | settled | ~identical |
| Segment 1 | 1.52 | settled | |
| A-tour shell | 1.73 | settled | composite (intro logo + Skip Intro) matches |
| Segment 4 | 2.12 | settled | `noKiosk` hold |
| Segment 2 | 2.16 | settled | |
| Segment 3 | 2.64 | settled | |
| Navigation | — | — | expected skip (standalone Ruffle blank) |
| Intro | 12.34 | running | continuous logo zoom; content matches, residual is timing phase |

The only scene above the segment baseline is the intro, and inspection of the worst
captured pair shows the same logo + reflection in both — the residual is the two
renderers being at different points of the zoom, not missing content. No content-level
divergence is currently captured; this harness is the guard that will catch one if a
runtime change introduces it.
