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

## Prior Art

The viable direction is not unique to this project:

- Google Swiffy converted SWF into compact JSON plus a JavaScript runtime that
  rendered with SVG/HTML/CSS, and described the output as nearly as compact as
  the original SWF.
- Adobe Animate's HTML5 Canvas export uses CreateJS and documents spritesheets
  as a way to reduce requests, output size, and improve performance.
- The vendored `tools/Fanvas-master` project is close to the target architecture:
  SWF -> compact JSON -> Canvas runtime.

Those systems all point at the same shape: keep a compact symbol dictionary and
timeline/action stream, then render it with a purpose-built runtime. Do not emit
one standalone SVG document per shape if the goal is SWF-like size.

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
