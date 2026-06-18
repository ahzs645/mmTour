# Section-change "bottom bar flashes white" (Tour Shell)

Date: 2026-06-18
Status: **Fixed** (prefetch) — verified headlessly for prefetch timing; visual
confirmation is browser-only (see "Why headless can't show it").

## Symptom

In the **A-tour Tour Shell**, after Skip Intro, clicking a category in the nav
menu made the **bottom bar flash white for ~a second** before the section
appeared. Ruffle (reference) shows no white — just a *slight, quick height
change* of the bar.

## Root cause — a load race, not a compositing bug

Three facts, each verified:

1. **The nav genuinely removes its own toolbar mid-exit.** Clicking a category
   plays `navAnim_Pro_Exit` (frame 384). The raw `nav.swf` has a
   `RemoveObject depth=1` (the `proToolbar`, char 3) at **frame 432**; it is
   re-placed only when the root loops back to `Pro-Static` (frame 15) at frame
   437. So the nav's bar is genuinely off-stage for frames 432–436 (~0.33s at
   15fps). This is in the SWF — Ruffle does it too. (Confirmed by parsing the
   binary with `swf-parser`, and by rendering frames 431 vs 435.)

2. **The incoming segment's own bar is what covers that gap.** Each segment has
   its own periwinkle bottom bar (`shapes/27` etc.). In Ruffle the bar appears
   continuous with a slight height blip — the nav's bar (~43px) handing off to
   the segment's bar (~47px). So Ruffle has the segment's bar **already painted**
   when the nav strips its toolbar.

3. **We lost the race.** Ruffle loads segments instantly from local SWF; we fetch
   a multi-MB `timeline.json` + SVGs on click. On a cold load the segment hasn't
   painted by frame 432, so the bare stage (white) shows through for the gap —
   stretched from Ruffle's imperceptible ~0.33s to "a second."

Not the cause (ruled out): the nav incorrectly stripping the bar (it's faithful
to the SWF); Ruffle keeping old level content (Ruffle clears a level immediately
on `loadMovie`, `ruffle/core/src/loader.rs`); level-4 being a reload-churn blank
(segment4 is blank at the bottom during the menu anyway — it `stop()`s at frame 4
under `doAttractLoop`).

## Fix — prefetch referenced scenes (`src/data/prefetch.ts`)

When a level loads, warm the cache for the scenes it can navigate to (the nav's
five section buttons → `segmentN.swf`): fetch each scene's `timeline.json` (the
multi-MB dominant cost) plus its first-frame images. Fully data-driven —
`collectReferencedSwfs()` reads the targets out of the timeline's own button/frame
actions, nothing hardcoded. Wired in `PlayerController.createLevel` via
`prefetchReferenced()`, deduped by `this.prefetched`, reset in `deactivate()`.

By the time the nav menu is interactive, all five segments are already warm, so a
section change loads from cache and paints near-instantly — the segment's bar
covers the nav's toolbar gap, like Ruffle.

Also hardened `TimelineLoader.loadTimeline` to return `null` (not throw) when a
referenced scene has no generated assets — Vite answers such a request with
`index.html` (200), which used to crash `JSON.parse`. Surfaced by prefetching the
restart button's `mslogo.swf` (no generated scene); also guards the case-sensitive
path 404.

## Why headless can't show the white

Headless throttles rAF, which slows the nav exit enough that even a cold segment
load wins the race — `scripts/trace-section-flash.mjs` reports 0 uncovered frames
on both old and new code, even with image responses throttled (`SLOW=700`). The
race only bites when the segment load is slower than the (real-time) nav exit.

## Verify

- `node scripts/verify-prefetch.mjs` — drives A-tour → Skip Intro and confirms all
  five segment `timeline.json`s are fetched early (≈0.5s) — well before a category
  is clickable (≈9s) — with no console errors.
- Visual: open the shell in a real browser (ideally a cold cache / throttled
  network) side-by-side with Ruffle and confirm the bottom bar no longer flashes
  white on a section change.
