# Issue: Decompiled Player images look "washed out" / softer than Ruffle

**Status:** Open / unresolved. Investigated 2026-06-18. Three obvious fixes were
measured and **disproven**. Documented here as a self-contained handoff so the next
person/AI does not repeat the dead ends.

> TL;DR — It is **not a colour problem** (brightness/contrast/RGB match Ruffle to
> within <0.5/255). It is a small, consistent **~12% loss of edge/detail energy**
> (the render looks slightly soft, which reads as "washed out"). That softness is
> **immune** to the CSS stage scale, to supersampling (dpr=2), and to the
> `image-rendering` hint — so it is **not** a simple smoothing knob. It appears to be
> intrinsic to our **DOM + SVG layered** rendering vs Ruffle's **single GPU canvas**.

---

## 1. Context (for someone with zero project background)

- **mmTour** converts the Windows XP Tour Flash SWFs into a web experience. The
  "Decompiled Player" is a data-driven AVM1 runtime that plays the FFDec-extracted
  assets (`public/generated/<scene>/`: SVG shapes, PNG/JPEG bitmaps, `timeline.json`,
  etc.). **No raw `.swf` is parsed at runtime.**
- The app shows a **side-by-side comparison**: our Decompiled Player on the right,
  the **Ruffle** reference player on the left (`#ruffleMount`). Ruffle is the source
  of truth for "what it should look like".
- Our player renders by placing each on-stage instance as a **DOM element**
  (`<img>` / SVG `<image>` / overlaid `<div>` text), positioned with CSS
  `transform: matrix(...)`. Most visible content is a **baked FFDec composited frame
  SVG** (the "HYBRID render" path) that embeds the bitmaps. See
  `src/render/DomRenderer.ts`.
- The whole stage (`#assetStage`, `.asset-stage`) is laid out at **640×480** and then
  CSS-scaled to fit its panel via `transform: scale(var(--stage-scale))`
  (`src/styles.css`), driven by `syncAssetStageScale()` in `src/app/frameMode.ts`.

## 2. The symptom as reported

> "the images seem more washed out than the ones we have in the Ruffle reference —
> are we smoothing it and not just showing it as it is pixel perfect?"

The user also pointed to a sibling project (`/Users/ahmadjalil/github/XPortfolio`)
where Spider Solitaire cards looked washed out until a CSS change fixed it — see §5.

## 3. What was actually measured (reproducible)

Harness: `scripts/compare-player-ruffle.mjs` captures a paused/settled screenshot of
both stages per scene. Run it with:

```bash
PLAYER_RUFFLE_SAMPLES=2 PLAYER_RUFFLE_GAP_MS=300 node scripts/compare-player-ruffle.mjs
# captures land in verification/player-ruffle/<n>-<scene>-{ruffle,player}.png
```

Three metrics were computed over the capture pairs (small throwaway Node scripts using
`pngjs` from the repo — run them from the repo root so `pngjs` resolves):

1. **mean luminance** and **per-channel mean/stdev (contrast)** over opaque pixels.
2. **sharpness** = mean absolute luminance gradient (high-frequency energy proxy;
   horizontal + vertical neighbour differences).

### Finding A — it is NOT colour

Across every settled scene, and even when restricted to just the differing
content region (ignoring the white UI):

| Metric | Ruffle vs Player |
|---|---|
| mean luminance Δ | within **±0.3** (out of 255) |
| contrast (stdev) Δ | within **±0.6** |
| mean RGB (content region, segment3) | ruffle `[237.5, 240.8, 249.4]` vs player `[237.1, 240.5, 249.5]` |

→ No lightening, no desaturation, no contrast loss. The "washed out" perception is
**not** a colour/exposure issue.

### Finding B — there IS a consistent ~12% softness

Per-pixel sharpness ratio (player ÷ ruffle), captured at equal display size (both
~679×511, dpr=1):

| Scene | sharpness ratio |
|---|---|
| Tour Shell | 0.88 |
| Segment 1 | 0.87 |
| Segment 3 | 0.90 |
| Segment 4 | 0.86 |
| Basics | 0.89 |

→ Our render carries ~10–14% less edge energy. Consistent across scenes ⇒ a real
systematic softness, not noise. **Caveat:** the two players render independently, so
some of this gap is sub-pixel misalignment / slightly different state, not literal
blur — the *true* visible softness may be smaller than 12%.

## 4. Fixes that were TRIED and DISPROVEN (do not retry these)

All three were measured. None moved the sharpness ratio.

| Lever | Hypothesis | Result |
|---|---|---|
| **Integer stage scale** | The fractional `transform: scale(~1.06×)` on `#assetStage` bilinear-blurs the whole stage. Snap to integer (1×). | Sharpness **unchanged** (raw 1.45 → 1.48). The 1.06× upscale is too small (6%) to matter. The change also shrank our stage to 640 vs Ruffle's 679 (broke size parity), so it was **reverted**. |
| **Supersample (render at dpr=2)** | Render at higher internal resolution like Ruffle's GPU canvas. | Captured both at dpr=2 (player 1280px wide, ruffle 1358px). Ratio stayed **0.89**. Higher resolution does **not** close the gap. |
| **`image-rendering` hint** | FFDec stamps `image-rendering:optimizeQuality` on all ~9385 embedded images; maybe forcing `pixelated`/`crisp-edges` sharpens. | Tested `auto` / `optimizequality` / `pixelated` / `crisp-edges` injected over `#assetStage img, image, svg image`. **0.000 difference** — all identical (1.475). |

**Why `image-rendering` having zero effect is the key clue:** if the bitmaps were
being *scaled* at the element level, the nearest-neighbour modes would have changed
the pixels. They didn't ⇒ **our bitmaps already render ~1:1.** There is no bitmap
resampling to "fix". So the residual softness is not in the image sampler at all.

## 5. Why the XPortfolio / Spider Solitaire CSS fix does NOT apply here

In XPortfolio (`/Users/ahmadjalil/github/XPortfolio`, commit `5e2175a`
"update Solitaire build script and CSS for improved scaling"), the cards were blurry
because the game was CSS-upscaled by a **large** factor:

```css
/* before (blurry) */
@media (min-width: 1200px) { .solitaire { transform: scale(1.8) !important; } }
/* after (crisp): render at native pixel size, no transform scale */
.solitaire { width: 660px !important; height: 440px !important; }
```

That worked there because the upscale was **1.2×–1.8×** (big, visible bilinear blur),
and the fix was to render the game canvas at native size in a fixed-size window.

In mmTour the analogous stage upscale is only **~1.06×**, and (per §4) our content
already renders ~1:1. So the same remedy removes a blur that is not actually present.
The two situations *look* identical ("washed out, fixed by CSS") but the underlying
cause is different.

## 6. Current best explanation (unconfirmed root cause)

The softness is immune to resolution and to image-sampling hints, which points away
from "we are scaling a bitmap badly" and toward the **rendering architecture**:

- **Ruffle** composites the entire frame into **one GPU canvas** at the target
  resolution, with its own anti-aliaser/sampler, drawing vectors and bitmaps fresh
  each frame.
- **We** stack many **separately-rasterised DOM/SVG layers** (each
  `.player-instance` is its own element with `will-change: transform` ⇒ its own
  compositor layer), placed with **sub-pixel** `transform: matrix(...)` offsets, and
  much content is a **pre-baked FFDec SVG** frame. Per-layer rasterisation +
  sub-pixel layer compositing + browser SVG/text AA is slightly softer than Ruffle's
  single-buffer render. This is resolution-independent, which fits the dpr=2 result.

This is a hypothesis consistent with all measurements; it has **not** been proven by
isolating a single layer.

## 7. Options / recommended next steps

1. **Accept it (recommended).** Colour is exact; the softness is subtle (~12%, likely
   less in practice) and not addressable by any CSS knob tried.
2. **Localise the softness before any big change.** Measure sharpness contribution of
   each layer type separately — overlaid `<div>` text vs baked-sprite SVGs vs raw
   `<img>` bitmaps — to see if there is a cheap localized win. This is the cheapest
   *un-tried* probe.
3. **Match Ruffle properly = composite to a single `<canvas>`** at device resolution
   instead of DOM/SVG layers. This is the only thing likely to truly close the gap
   (it is literally what Ruffle does), but it is a rendering-architecture change, not
   a CSS tweak. Large effort; only worth it if the softness genuinely matters.

## 8. Key files & pointers

- `src/render/DomRenderer.ts` — how instances become DOM (`<img>` / SVG `<image>` /
  text), the baked-sprite path, mask groups.
- `src/render/colorTransform.ts` — SWF colour transform via `feComponentTransfer`
  (relevant to colour, which is *fine* — ruled out here).
- `src/styles.css` — `.asset-stage { transform: scale(var(--stage-scale)) }`,
  `.player-instance { will-change: transform, opacity }`.
- `src/app/frameMode.ts` — `syncAssetStageScale()` (the stage scale; currently the
  original fractional `Math.min(...)`, after the integer-scale experiment was reverted).
- `scripts/compare-player-ruffle.mjs` + `scripts/lib/visualDiff.mjs` +
  `scripts/lib/playerProbe.mjs` — the comparison harness used for all measurements.
- FFDec-embedded images carry `image-rendering:optimizeQuality` (~9385 occurrences in
  `public/generated/**/*.svg`); confirmed irrelevant to the softness.

## 9. One-paragraph summary to paste to another AI

> In the mmTour project, the Decompiled Player's images look slightly "washed out"
> compared to the Ruffle reference shown side-by-side. Measurement shows it is **not**
> colour (brightness/contrast/RGB match Ruffle within <0.5/255) — it is a consistent
> **~12% loss of edge sharpness**. We already proved this is **not** fixed by: (a)
> snapping the stage `transform: scale` to an integer, (b) rendering at dpr=2
> (supersampling), or (c) any `image-rendering` value — `image-rendering` has *zero*
> effect, which proves our bitmaps already render ~1:1 (no scaling to fix). The likely
> cause is that we render via stacked DOM/SVG layers with sub-pixel transforms and
> pre-baked FFDec SVG frames, whereas Ruffle composites everything into one GPU canvas
> at target resolution. Do not re-try the CSS scale / dpr / image-rendering fixes.
> Cheapest next probe: isolate which layer type (overlaid text vs baked SVG vs raw
> img) carries the softness. Full write-up: `docs/image-sharpness-vs-ruffle.md`.
