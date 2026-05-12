# mmTour Archive Notes

`/Users/ahmadjalil/github/mmTour` was the earlier exploration workspace for this conversion. The current repo keeps the parts that are still useful as active code:

- A GSAP display-list renderer path, adapted to `public/generated/<scene>/timeline.json`.
- A display-list debug panel inspired by `intro-player/src/components/DebugPanel.tsx`.
- A static generated-frame reference panel inspired by `ReferenceFramePlayer.tsx`.
- `scripts/capture-render-mode-frames.mjs`, adapted from `intro-player/scripts/capture-gsap-frames.mjs`.

The following `mmTour` files are intentionally archive-only and should not be copied back into the active pipeline:

- `convert_timeline.py`, `convert_nav.py`, and `nav_shapes_to_svg.py`: superseded by the current Node/FFDec/Open Flash pipeline.
- `intro-animated.html`, `intro.html`, `debug-position.html`, and `test-shapes.html`: useful historical experiments, but not the maintained app.
- Raw extracted `frames/`, `sprites/`, `segement *`, and `SwfFile.java`: large and redundant with normalized `extracted/` and `public/generated/` output.

Renderer ideas still worth mining from `mmTour/intro-player/src/engine/GsapSwfRenderer.ts`:

- Full SVG mask reconstruction for SWF clip-depth ranges.
- More exact color-transform filters when the generator exposes per-placement transform terms.
- Deeper clip-local MovieClip state and ActionScript execution.
- Debuggable AVM1 function-state traces.

The current GSAP renderer has hooks for labels, sprite stop frames, optional clip/color fields, and debug entries. The remaining work is mostly generator support and deeper ActionScript compilation rather than copying the old renderer wholesale.
