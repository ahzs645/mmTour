# Generated Size And Packing Notes

This note records the current bundle-size findings for the Decompiled Player and
the next size experiments worth running. The goal is a web-native player that no
longer needs Ruffle at runtime, while staying data-driven and general.

## Baselines

The original eight SWFs under `public/` total:

```text
19,782,483 bytes
18.87 MiB
~19 MB
```

They are Flash 5 `FWS` files, not `CWS`, so the SWF containers are not zlib
compressed. They are compact because SWF stores reusable definitions, timeline
commands, matrices, color transforms, bytecode, and media in compact binary tag
records.

Current optimized `public/generated/` after tree-player optimization:

```text
74,736,377 bytes
71.27 MiB
du -sh: ~73M
ratio vs SWF bytes: ~3.78x
```

The generated bundle is no longer a frame dump:

```text
root frames/: 0
baked sprite frames: removed except 7 tiny frame-only sprite SVGs
debug scripts/reports: removed
duplicate assets: removed
```

## Current Generated Breakdown

By file type:

```text
svg   29.37 MiB
json  18.74 MiB
png   13.95 MiB
mp3    8.48 MiB
ttf    0.73 MiB
txt    ~0 MiB
wav    ~0 MiB
```

By logical generated folder:

```text
shapes/                       26.19 MiB
timeline.json + control-flow  18.74 MiB
images/                       13.95 MiB
sounds/                        8.49 MiB
buttons/                       3.18 MiB
fonts/                         0.73 MiB
texts/                         ~0 MiB
sprites/                       ~0 MiB
```

The remaining gap versus SWF is mostly representation overhead:

- SWF shape records are compact binary; generated shapes are SVG/XML.
- SWF timeline records are compact binary; generated timelines are JSON.
- SWF stores definitions in one binary container; generated output externalizes
  many files.
- PNG/MP3 media is already compressed, so HTTP compression barely helps it.

## Compression Measurements

Measured over current `public/generated/` using Node `zlib`:

```text
type  raw      gzip-9   brotli-q5  brotli-q8
svg   29.37    16.04    15.86      15.84 MiB
json  18.74     0.92     0.60       0.59 MiB
png   13.95    13.87    13.90      13.90 MiB
mp3    8.48     8.24     8.29       8.29 MiB
ttf    0.73     0.31     0.30       0.30 MiB

total 71.27    39.39    38.95      38.92 MiB
```

Brotli is still worth serving for static assets, but it is not a major unlock
for this bundle. It improves the full generated transfer estimate by only about
`0.47 MiB` versus gzip-9 because the large PNG/MP3 portions and embedded PNG
payloads are already compressed. Brotli's meaningful win is JSON (`0.92 MiB`
gzip -> `0.59 MiB` Brotli q8).

The repo includes an experimental pack generator:

```sh
npm run pack:generated
```

It writes ignored artifacts under `public/generated-packed/`:

```text
<scene>/<scene>.pack
<scene>/<scene>.pack.gz
<scene>/<scene>.pack.br
<scene>/<scene>.shape-dict.json
<scene>/<scene>.shape-dict.json.gz
<scene>/<scene>.shape-dict.json.br
report.json
```

The `.pack` format is a simple binary container: a 4-byte little-endian JSON
header length, a JSON manifest with file paths/content types/offsets, then raw
file bytes. It is not wired into runtime yet; it is for measuring and gives us a
future `fetch(...).arrayBuffer()` load target.

Current totals from `public/generated-packed/report.json`:

```text
binary pack raw:     74,811,180 bytes
binary pack gzip:    41,243,347 bytes
binary pack brotli:  39,557,094 bytes

shape dict raw:      42,671,462 bytes
shape dict gzip:     17,579,168 bytes
shape dict brotli:   16,058,036 bytes
```

The binary pack confirms the earlier compression estimate: packaging the existing
files into one binary blob does not shrink much beyond Brotli/gzip. It mainly
reduces request count and gives a cleaner deployment unit.

The `shape-dict` output is a prototype, not a complete runtime package: it packs
timeline/control data and SVG-derived shape/button drawing records, but does not
include the external PNG/MP3/TTF media payload. Its Brotli size (`~15.3 MiB`) is
the useful signal: compact shape/timeline representation can get close to SWF
scale, but only once the runtime can render those records directly.

## Packing Tests

### Tuple-packed timeline JSON

Prototype: convert verbose timeline objects into positional arrays while keeping
the same semantic data.

```text
timeline JSON raw:  13.56 ->  7.67 MiB  save 5.89 MiB
all JSON raw:       18.74 -> 12.85 MiB  save 5.89 MiB

timeline gzip:       0.58 ->  0.49 MiB  save 0.09 MiB
all JSON gzip:       0.92 ->  0.83 MiB  save 0.09 MiB
```

Conclusion: tuple packing helps raw disk size but barely affects transfer size
when gzip/Brotli is enabled. It is not enough by itself.

### Naive SVG-to-command JSON

Prototype: parse SVG tags into JSON draw-command arrays, without converting path
data to binary/structured numbers.

```text
SVG raw:   29.37 -> 27.81 MiB  save 1.56 MiB
SVG gzip:  16.04 -> 15.96 MiB  save 0.08 MiB
```

Conclusion: simple XML-to-JSON conversion is not useful enough. The real weight
is long path `d` strings and embedded base64 PNG data, not just XML tags.

The checked-in `pack:generated` shape-dictionary prototype is a more complete
version of this test across scenes. It is still intentionally naive: path data
stays as SVG `d` strings, gradients/patterns are stored as arrays, and media
payloads are not embedded. It exists so future work can replace path strings
with binary numeric path records and compare against a stable baseline.

## Prior Art

The viable direction is not unique to this project:

- Google Swiffy converted SWF into compact JSON plus a JavaScript runtime that
  rendered with SVG/HTML/CSS, and described the output as nearly as compact as
  the original SWF.
- Adobe Animate's HTML5 Canvas export uses CreateJS and documents spritesheets
  as a way to reduce requests, output size, and improve performance.
- Fanvas-style converters are close to the target architecture: SWF -> compact
  JSON -> Canvas runtime.

Those systems all point at the same shape: keep a compact symbol dictionary and
timeline/action stream, then render it with a purpose-built runtime. Do not emit
one standalone SVG document per shape if the goal is SWF-like size.

## Implemented: bitmap-fill-by-reference + shape records (Phases 1–4)

Measurement revealed the real lever was **not** vector path packing. ~72% of raw
shape SVG bytes — and ~13.7 MiB of the 14.55 MiB brotli shape weight — was a base64
copy of each bitmap fill, byte-identical to the already-extracted `images/<id>` file.
The actual vector geometry brotli's to ~0.8 MiB (already SWF-scale).

**Phase 1 — bitmap-fill-by-reference (shipped, default).** Shapes now reference their
bitmap fills as `generated/<scene>/images/<id>` instead of embedding base64
(`svgEmit.bitmapPatternDef` for the in-browser pipeline; `build-asset-timeline`
content-matches and rewrites FFDec's embedded data URIs, recorded in
`timeline.bitmapFillShapeSrcs`; `dedupe-generated-assets` follows image dedups into
SVG bodies). A sandboxed `<img src=blob>` can't load external `<image>` hrefs, so the
runtime re-inlines the bytes when it builds the shape Blob (`src/data/shapeBitmapInline.ts`):
synchronously from in-memory media for pack/archive/scene-pack, and via a load-time warm
for files/bundle. Rendered output is byte-identical; `verify:player` shows no Ruffle
regression. Measured:

```text
                       before        after
generated/             71.38 MiB  -> 52.61 MiB
shapes/ (brotli)       14.55 MiB  ->  0.81 MiB
pack:generated brotli  39.54 MiB  -> 23.84 MiB
archive xp-tour.pack   39.67 MiB  -> 25.51 MiB
bundle:generated gz    16.5  MiB  ->  2.3  MiB
client .mmtour.pack    54.87 MiB  -> 43.18 MiB  (gzip 26.24 -> 18.47)
```

**Phases 2–3 — compact draw records (built, parity-proven, NOT default).**
`src/convert/shapeRecord.ts` (`shapeToRecord`, from the rasterizer — not by parsing SVG)
and `src/render/shapeRecordToSvg.ts` reconstruct a shape through the *same* stringifier
the emitter uses (`rasterizedToShapeSvg`), so reconstruction is byte-identical:
`verify:shape-records` confirms 409/409 shapes round-trip exactly. But the measurement
kills the size case — once Phase 1 removed the base64, a **JSON** record is *larger* than
the residual SVG:

```text
verbose shape SVG   brotli 0.62 MiB
JSON shape record   brotli 0.87 MiB   (+0.25 MiB — worse)
```

JSON's structural overhead (brackets/commas, numbers as text) exceeds SVG path-string
compactness, and the whole vector budget is already <1 MiB against a ~22 MiB PNG+MP3
floor. So records are kept as a parity-tested capability, **not wired as the default**:
realizing a win from them needs a *binary* (varint) encoding, and even then the upside is
sub-MiB. The next real levers are media (#5/#6 below), not shapes.

## Next Experiments

These are ordered by likely impact.

1. **Pack vector shapes from SWF/FFDec data into compact draw records**

   Avoid SVG entirely for `shapes/`. Store command arrays or a small binary blob:

   ```text
   move/line/curve commands
   fill/stroke style indices
   gradient records
   bitmap fill references
   bounds
   ```

   Runtime renders to Canvas or builds SVG paths from the compact records. This is
   the closest analogue to SWF's compact shape records and the main path toward
   a Swiffy/Fanvas-like package.

2. **Split embedded raster payloads out of SVG pattern fills**

   Some SVGs contain large base64 PNGs inside `<image xlink:href="data:image/png;base64,...">`.
   Extract those images once, reference them by ID/path, and dedupe them with
   `images/`. Expected gain depends on how many embedded PNGs duplicate already
   extracted image files.

3. **Use a compact binary package for timeline/control data**

   Tuple-packed JSON only saves raw bytes; binary arrays/varints may reduce parse
   cost and raw size further. It will not beat gzip/Brotli dramatically, but may
   improve startup and memory.

4. **Bundle scene assets into a small number of compressed packs**

   Pack each scene into one `.json.br`/`.bin.br` plus media. This reduces request
   overhead and gives the runtime explicit lazy-loading boundaries. It is mostly
   deployment ergonomics, not a large byte reduction.

5. **Re-encode suitable PNGs/WebP/AVIF, guarded by visual diff**

   Current PNGs are about `13.95 MiB` and gzip/Brotli cannot reduce them. Lossless
   PNG optimization is safe but likely modest; lossy WebP/AVIF could save more
   but must be verified against Ruffle/player screenshots.

6. **Audio audit**

   MP3 is about `8.48 MiB` and does not compress further. Check whether all
   sounds are reachable, whether duplicate sounds exist across scenes, and
   whether lower bitrate copies remain acceptable.

## Practical Recommendation

Short term:

- Serve `public/generated/**` with Brotli where available and gzip fallback.
- Keep `convert:tree-player` as the default smallest generated mode.
- Do not spend much more time on text minification; it has diminishing returns.

Medium term:

- Build a `packed`/`gsap-packed` experiment that keeps GSAP as the clock but uses
  a compact symbol dictionary and timeline stream instead of SVG files.
- Start with shape packing, because `shapes/` + SVG button art are the largest
  remaining web-native overhead.
