# A‑tour bottom‑title occlusion (multi‑level compositing)

Date: 2026-06-17
Status: **Known limitation** — full‑tour shell only; not yet fixed.

## Symptom

In the **Decompiled Player** (`renderMode = "player"`), when a segment is viewed
**through the A‑tour shell** (select a category in the nav → a sub‑section), the
bottom purple bar shows the controls (refresh / X / music) but the **sub‑section
title is missing** (e.g. "Multiple Users: A Cinch to Switch" for segment3's
"Connected Home and Office" → Multiple Users).

Ruffle, side‑by‑side, shows that title centered on the bar.

It is **not** a text bug:

- The same scene loaded **directly** (pick "Segment 3"/etc. in `#sceneSelect`)
  renders the title correctly. So the field, its font, its variable, and its
  position are all fine.
- In the tour shell the title field **does render** — white, opacity 1, font
  loaded, at its correct coordinates (level4, top≈471). It is simply **painted
  over** by another layer.

## Root cause: the nav's opaque bar (level6) covers the segment's title (level4)

The tour is multi‑SWF and stacks each movie on its own layer
(`src/app/PlayerController.ts` → `layer.style.zIndex = String(level)`, higher
level on top):

| Level | Loaded movie | Bottom‑bar contribution |
|------:|--------------|-------------------------|
| 0 | A‑tour shell | (none at the bottom) |
| 4 | intro / **segment** | the segment's own periwinkle bar (`shapes/27`) **+ the sub‑section title** (`ss_textN` editText) |
| 6 | **nav** | its own bottom bar `proToolbar` (`DefineSprite_3`) + refresh/X/music |

`_level6` (nav) renders above `_level4` (segment), so the nav's bottom bar paints
over the segment's title. Standalone has no nav layer, so the title shows.

This level assignment is the SWFs' own, not a guess:

- The A‑tour's frame‑0 `loadMovieNum` calls: `nav.swf → level 6`,
  `segment*.swf / intro.swf → level 4`.
- The nav's own `scripts/frame_2/DoAction.as`: `intMovieTargLevel = 4;` then
  `loadMovieNum(strTarget, intMovieTargLevel)` — the nav loads the chosen segment
  into level 4 itself.

So the player composites exactly as Flash level semantics dictate.

### Evidence (player DOM at the segment3 → Multiple Users tour state)

Bottom band grouped by `.player-level` layer:

```
level=4  img  shapes/27.svg        top=466 h=47 w=721   (segment's bar)
level=4  text "Multiple Users…"    top=471 h=21 w=419   (THE TITLE — occluded)
level=6  img  DefineSprite_3/2.svg top=465 h=43 w=730   (nav's bar — opaque, on top)
level=6  img  DefineButton2_5/10/17 …                   (refresh / X / music)
```

- The title element checks out: `color rgb(255,255,255)`, `opacity 1`,
  `visibility visible`, `font swf-font-36` (loaded), not occluded *within* its own
  level — it's the **layer above** that covers it.
- `DefineSprite_3/2.svg` is a single solid rect: `<path … fill="#6687ff" …>`
  spanning x≈74–590, y≈0–41 (placed at ty=458 ⇒ stage y≈458–499), fully covering
  the title's y≈471. Its placement opacity is `1.00` at every frame, incl. the
  exit frames.

## The contradiction

For Ruffle to show the title, the segment's title (level4) would have to paint
**above** the nav's opaque bar (level6) — a reversal of level‑z ordering. Nothing
in the extracted data explains how that happens; the player is doing the
Flash‑correct thing and still loses the title behind the nav bar.

## Ruled out during the investigation

- **Not a font/FOIT issue** — `swf-font-36` is loaded; `document.fonts.check` passes;
  the element has non‑zero width (glyphs laid out).
- **Not occlusion *within* level4** — `elementFromPoint` and per‑level z dumps
  confirm nothing in the segment's own layer covers the title.
- **Not `loadVariables` timing** — the sub‑section *labels* (same variables) render,
  so the level‑4 vars load. (An earlier "show the baked value as a fallback" commit,
  `fb04518`, was based on this wrong hypothesis and has been **reverted**, `76d3923`.)
- **The nav has no sub‑section title field** — its editText fields are only the
  control labels (`t_restartTour`, `t_close`, `t_music`), category headings
  (`h_SegmentN`, `TextField8`), `skipIntro`, and `t_attractLoopMain`. No script sets
  any field's `.text`. So the title can only be the segment's.
- **The nav bar doesn't fade** — `DefineSprite_3` instance opacity is 1.00 across the
  toolbar, `navAnim_*` and `navAnim_*_Exit` frames.

## Remaining unverified lead

The nav's exit sequence ends in a branch loop
(`navAnim_Pro_Exit = 384` … frame 437 `gotoAndPlay` toward `Pro-Static`/`segStart`).
It is *possible* Ruffle's nav settles on a frame where `proToolbar` (the bar
background) is no longer placed — letting the segment's bar+title show — while the
player's nav settles on a frame that still places it. The timeline data shows
`DefineSprite_3` placed across all those frames, so confirming this needs a
frame‑by‑frame trace of the nav's exit‑loop playhead against Ruffle's actual
playback. Not closed.

## Why there is no clean fix yet

- A **compositing heuristic** (paint a content level's text over an upper level's
  opaque bar in the bottom band) would work but is exactly the kind of
  scene/position‑specific special‑casing the project forbids (`AGENTS.md`: nothing
  hardcoded, data‑driven only), and it risks regressing other overlaps.
- The **nav‑exit‑frame trace** is open‑ended and may not pan out.

## Reproduce / verify

1. `npm run dev`, open the app, `#sceneSelect = "Tour Shell - A-tour.swf"`,
   `#renderMode = player`.
2. Click **Skip Intro**, then a category section button, then a sub‑section icon.
3. The bottom bar shows controls but no title (vs. Ruffle on the left).
4. For contrast, pick the segment directly in `#sceneSelect` and select the same
   sub‑section — the title renders.

Per‑level inspection: dump `#playerLayer .player-level` layers and group elements
by the layer's computed `z-index` (= the Flash level); the title sits in the
`z-index:4` layer and `DefineSprite_3` in the `z-index:6` layer.

## Scope

Cosmetic, **full‑tour shell only**. Every other Decompiled‑Player fix from this
work — section navigation, the Replay icon, title wrap/style/centering/vertical,
the section demos playing (VO‑hold for nested clips), Skip Intro, segment1 icon
deselect/stacking — is in place and verified, and the standalone scene renders this
title correctly.
