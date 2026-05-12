# Direct Renderer Smoke Report

Date: 2026-05-12

Target: `http://127.0.0.1:5174/`

Verification:

- `npm run build`
- Browser smoke test switching every scene to `Direct SWF Renderer`

## Results

| Scene | Result | Direct items | Frame max | Notes |
| --- | ---: | ---: | ---: | --- |
| `A-tour.swf` | Pass | 4 | 2 | Parses and renders. |
| `intro.swf` | Pass | 39 | 585 | Parses and renders. |
| `nav.swf` | Partial | 0 | 437 | Parses and exposes frames, but standalone direct display list is blank. This still needs behavior parity work against the old mmTour menu bootstrap/composition path. |
| `segment1.swf` | Pass | 9 | 134 | Parses and renders. |
| `segment2.swf` | Pass | 9 | 131 | Parses and renders. |
| `segment3.swf` | Pass | 11 | 201 | Parses and renders. |
| `segment4.swf` | Pass | 9 | 141 | Parses and renders. |
| `segment5.swf` | Pass | 10 | 62 | Parses and renders, but is slow; observed around 32.6s in browser smoke. |

## Console

No page errors were observed. The only browser error in the pass was the expected missing `/favicon.ico`. Ruffle emitted autoplay warnings for Web Audio policy, which do not block rendering.

## Remaining Direct Renderer Gaps

- `Frame SVG` mode remains the visual fidelity path.
- `nav.swf` direct rendering needs additional composition/bootstrap work before it can replace the generated nav renderer.
- `segment5.swf` direct parsing is slow enough that future smoke tests should use a 90s timeout.
- Direct mode now reuses generated labels/actions in the debug tabs, but it does not yet expose the full direct renderer AVM1 runtime state.
