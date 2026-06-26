#!/usr/bin/env python3
"""Repair a TrueType font whose `cmap` is malformed (browsers reject it) by
rebuilding a clean Unicode cmap from the font's PostScript glyph names.

Why this exists
---------------
Some SWF-embedded fonts decompile to a TTF whose format-4 cmap is broken — e.g.
bnl.swf's font 35 (TradeGothic Bold). FFDec's export of it produces a 2.1 MB file
whose cmap computes an out-of-range glyphIdArray index, so the browser logs
"Failed to decode downloaded font" and the player falls back to Arial. The build
then marks it `fontLoadable: false` (see scripts/lib/assets.mjs:isCmapTableLoadable).

The *original design* TTF (TradeGothic Bold, ~161 KB, 233 glyphs, standard glyph
names) has the same cmap defect but valid `glyf` outlines and a valid `post` table.
This script keeps those outlines and rebuilds the cmap by mapping each glyph name
to a codepoint via the Adobe Glyph List, producing a small, browser-loadable TTF.

The repaired output is committed under tools/font-overrides/<scene>/ and copied
over the FFDec export at build time (build-asset-timeline.mjs:applyFontOverrides).

Usage
-----
    python3 tools/font-overrides/repair-cmap.py <source.ttf> <out.ttf>

Requires: fontTools (`pip install fonttools`).
"""
import sys
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._c_m_a_p import cmap_format_4
from fontTools import agl


def repair(src: str, out: str) -> None:
    f = TTFont(src, lazy=True)  # lazy: don't auto-decompile the broken cmap
    mapping: dict[int, str] = {}
    for gname in f.getGlyphOrder():
        if gname in (".notdef", ".null", "nonmarkingreturn"):
            continue
        uni = agl.toUnicode(gname)  # "" if the name isn't a standard AGL name
        if uni and len(uni) == 1 and ord(uni) not in mapping:
            mapping[ord(uni)] = gname

    if not mapping:
        raise SystemExit(f"{src}: no glyph names map to Unicode — cannot rebuild cmap")

    def subtable(platform_id: int, enc_id: int) -> cmap_format_4:
        s = cmap_format_4(4)
        s.platformID, s.platEncID, s.language = platform_id, enc_id, 0
        s.cmap = dict(mapping)
        return s

    f["cmap"].tableVersion = 0
    f["cmap"].tables = [subtable(0, 3), subtable(3, 1)]  # Unicode + Windows BMP
    f.save(out)

    # Verify the rebuilt cmap decompiles cleanly.
    chars = len(TTFont(out).getBestCmap())
    print(f"repaired {src} -> {out}  ({chars} mapped codepoints)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    repair(sys.argv[1], sys.argv[2])
