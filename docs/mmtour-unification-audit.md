# mmTour Unification Audit

Source checked:

- Current workspace: `/Users/ahmadjalil/Downloads/windows-xp_tour`
- Candidate repo: `/Users/ahmadjalil/github/mmTour`
- Candidate git remote: `https://github.com/ahzs645/mmTour.git`
- Candidate HEAD: `d3fb3c2 Improve GSAP business and menu scene comparisons`

## Current Workspace

`windows-xp_tour` is not currently a git repository. It is the more complete conversion workspace:

- Vite/TypeScript app without React.
- Full extraction/conversion pipeline in `scripts/`.
- Generated timelines, control-flow reports, frame SVGs, fonts, sounds, button assets, and secondary parser output under `public/generated/<scene>/`.
- Original SWFs and transcript/XML metadata under `public/`.
- Verification scripts for artifacts, text/fonts, hover behavior, and Ruffle runtime checks.
- Size: about `3.7G`, mostly repeated `public`, `extracted`, and `dist` trees.

## mmTour Repo

`mmTour` is a clean git repo with two commits and no local dirty changes. It contains:

- Root-level historical extraction files and experiments.
- Nested `intro-player/` React/Vite app.
- A direct SWF parser/renderer path using `swf-parser`.
- Focused comparison UI for business/menu scenes.
- Curated PNG segment assets under `intro-player/public/segment-assets/{1,3,4,5}`.
- Size: about `1.1G`; `intro-player` is about `360M`, with `334M` of segment assets.

## Bring Over

Highest-value candidates:

1. `intro-player/src/engine/SwfParser.ts`
   - Direct binary SWF parsing into a renderable movie model.
   - Useful as a debug/inspection renderer alongside the generated FFDec timeline path.

2. `intro-player/src/engine/GsapSwfRenderer.ts`
   - More ambitious live display-list renderer than the current `src/gsap-display-list-renderer.ts`.
   - Handles nested sprite playback, labels, simple AVM1 state, clipping, fonts, and root bootstrap behavior.

3. `intro-player/src/components/RufflePlayer.tsx`
   - Clean wrapper for reference playback if the current app is moved to React.

4. `intro-player/src/components/GsapTourPlayer.tsx`
   - Useful logic for coordinating `nav.swf` and `intro.swf`.
   - The menu bootstrap behavior is especially worth preserving.

5. `intro-player/src/components/NavOverlay.tsx`, `navSegments.ts`, and related CSS
   - Reusable XP chrome/menu overlay work.
   - Should be reconciled with the generated button overlay runtime rather than replacing it.

6. `intro-player/src/components/ReferenceFramePlayer.tsx`
   - Useful for fixed-frame visual comparisons.

7. `intro-player/scripts/capture-gsap-frames.mjs`
   - Useful if adapted to current verification output directories.

## Leave Behind

Do not bulk-copy these into the current workspace:

- `intro-player/public/segment-assets/*`
  - Large and only covers segments `1`, `3`, `4`, and `5`.
  - Current workspace already has generated assets for `A-tour`, `intro`, `nav`, and segments `1` through `5` under `public/generated/`.

- Root-level `frames/`, `images/`, `shapes/`, `fonts/`, `*.xml`, and standalone HTML experiments in `mmTour`.
  - These appear to be earlier extraction/debug artifacts.
  - Current extraction pipeline supersedes them.

- `intro-player` package configuration as-is.
  - It pins older Vite/TypeScript/Ruffle versions and duplicates the current app setup.

## Recommended Unification Path

1. Make `windows-xp_tour` the canonical workspace.
   - It has the fuller extraction pipeline and verification story.
   - Initialize git here or move this content into the `mmTour` repo intentionally.

2. Do not run `git pull` from `mmTour` into `windows-xp_tour`.
   - The current folder is not a git repo, and the asset layouts differ.
   - A blind merge would mix duplicate generated artifacts and old experiments.

3. Create an `archive/mmTour/` or `docs/archive/mmTour/` note only if historical artifacts need to be preserved.
   - Prefer documentation over copying gigabytes of duplicate assets.

4. Port the reusable React/player code selectively.
   - Either convert the current app to React and place code under `src/components` / `src/engine`, or keep the current DOM app and port only renderer logic into TypeScript modules.
   - If React is chosen, add `react`, `react-dom`, and React typings to the current package.

5. Normalize asset addressing before importing renderer code.
   - Current generated assets live at `public/generated/<scene>/...`.
   - `intro-player` expects paths like `/segment-assets/4/frames`.
   - Any imported code should read from the current generated asset layout.

6. Keep current verification scripts as the acceptance gate.
   - After each port, run `npm run build`, `npm run verify:artifacts`, and relevant runtime verification.

## Practical First Import

The best first slice is a new experimental renderer mode based on:

- `intro-player/src/engine/SwfParser.ts`
- `intro-player/src/engine/GsapSwfRenderer.ts`

Wire it as a third display mode beside the current frame-SVG and asset-timeline modes. This keeps the proven generated pipeline intact while letting the direct SWF renderer be compared against Ruffle and the generated artifacts.
