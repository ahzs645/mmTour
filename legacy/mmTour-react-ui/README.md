# mmTour React UI Import

This folder preserves the reusable React comparison UI files from `/Users/ahmadjalil/github/mmTour/intro-player` without wiring them into the current app build.

The current `windows-xp_tour` workspace is a vanilla TypeScript/Vite app. Keeping these TSX files outside `src/` avoids adding React as a runtime dependency before there is a deliberate React migration.

Imported candidates:

- `components/GsapTourPlayer.tsx`
- `components/GsapPlayer.tsx`
- `components/RufflePlayer.tsx`
- `components/ReferenceFramePlayer.tsx`
- `components/NavOverlay.tsx`
- `components/NavOverlay.css`
- `components/navSegments.ts`
- `scripts/capture-gsap-frames.mjs`

Already wired into the live app:

- `src/engine/SwfParser.ts`
- `src/engine/GsapSwfRenderer.ts`
- The `Direct SWF Renderer` render mode in `src/main.ts`

To fully migrate the React UI, first decide to convert `src/main.ts` to a React root and add `react`, `react-dom`, and React TypeScript settings. Until then, this folder is the source-preserved migration staging area.
