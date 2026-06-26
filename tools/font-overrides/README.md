# Font overrides

Hand-repaired TTFs that replace broken FFDec font exports at build time.

`build-asset-timeline.mjs` copies `tools/font-overrides/<scene>/<file>.ttf` over the
FFDec-extracted `extracted/<scene>/fonts/<file>.ttf` **before** asset discovery, so the
repaired metrics/cmap drive both `fontLoadable` detection and the copied
`public/generated/<scene>/fonts/` output. The override filename must match the
FFDec-exported filename exactly (e.g. `35_TradeGothic Bold.ttf`).

## bnl/35_TradeGothic Bold.ttf

bnl.swf's font 35 (TradeGothic Bold) is the site's primary face — nav labels, section
titles, headlines (49 text fields). FFDec exports it as a 2.1 MB TTF whose format-4
`cmap` computes an out-of-range `glyphIdArray` index, so Chrome logs *"Failed to decode
downloaded font"* and the player falls back to Arial. The build then flags it
`fontLoadable: false`.

This override is the original design font (TradeGothic Bold, 233 glyphs, valid `glyf`
outlines + standard PostScript glyph names) with a freshly rebuilt Unicode cmap — 48 KB,
browser-loadable. It was produced with:

    python3 tools/font-overrides/repair-cmap.py "<source>/35_TradeGothic Bold.ttf" "tools/font-overrides/bnl/35_TradeGothic Bold.ttf"

See `repair-cmap.py` for the how/why. To regenerate, point it at a TradeGothic Bold TTF
that has valid glyph names (e.g. the original BuyNLarge design assets).
