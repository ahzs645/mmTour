# Windows XP Tour GSAP Conversion Lab

This workspace now contains a web-native conversion prototype for the bundled Windows XP Tour SWFs.

## What is included

- Ruffle reference playback for the original `.swf` files.
- FFDec/JPEXS extraction scripts for shapes, sprites, button state SVGs, bitmap images, fonts, sounds, text, scripts, and SWF XML.
- Generated frame SVGs and asset timelines under `public/generated/<scene>/`.
- Generated `control-flow.json` files with FFDec-derived frame labels/actions plus Open Flash `swf-parser` validation data: AVM kind, stop frames, auto-play ranges, bytecode frame actions, nested sprite actions, sound actions, button definitions, button state records, hit-test/clickable regions, segment navigation targets, and explicit root/sprite/function/button control-flow graphs.
- Secondary `swf-parser-report.json` files for every SWF under `public/generated/<scene>/`.
- A default GSAP frame-SVG renderer for high visual fidelity.
- An inspection renderer that keeps each extracted SWF symbol as its own DOM asset and applies Flash matrix/depth/alpha data per frame.
- Scene metadata derived from the archive XML and transcript text files.

Run it with:

```sh
npm install
npm run dev -- --port 5173
```

Open:

```text
http://127.0.0.1:5173/
```

If that port is already in use, the current verified dev server is on:

```text
http://127.0.0.1:5174/
```

## Current conversion approach

The current implementation has two conversion modes:

```text
Original SWF files
  -> FFDec/JPEXS export
  -> root frame SVGs + SVG shapes + sprite-frame SVGs + button state SVGs + PNG images + fonts + sounds + text + XML timeline tags
  -> normalized timeline JSON + control-flow JSON
  -> GSAP stepped timeline over root frame SVGs for visual fidelity
  -> extracted stop/goto/button handling for root timeline choices and waiting loops
  -> optional DOM/SVG asset timeline for converter inspection
```

This avoids custom replacement artwork and avoids screenshot-only playback. The default `Frame SVG` mode uses FFDec-rendered SVG frames from the SWF's own vectors/bitmaps/text. The generated output is large because root frames, sprite frames, button states, fonts, sounds, and bitmap assets are retained.

Regenerate the extracted assets, timelines, and secondary control-flow reports with:

```sh
npm run convert
```

The conversion command now also writes SWFTools and swfmill cross-checks for every SWF:

```text
public/generated/<scene>/secondary/swfdump.txt
public/generated/<scene>/secondary/swfextract.txt
public/generated/<scene>/secondary/swfmill.xml
public/generated/<scene>/secondary/flasm.flm
```

Verify that every bundled SWF has matching FFDec exports, sound/font/button assets when the source tags exist, Open Flash parser reports, generated timelines, and control-flow artifacts with:

```sh
npm run verify:artifacts
```

This writes:

```text
public/generated/verification-report.json
```

The verifier currently passes for all eight SWFs and confirms that each file is AVM1. FFDec, Open Flash `swf-parser`, Flasm, SWFTools, and swfmill reports are generated locally. RABCDAsm is skipped because no AVM2 bytecode is present.

Flasm is vendored under `tools/flasm-src` and rebuilt into `tools/flasm-bin/flasm` by:

```sh
npm run build:flasm
```

Run a browser/Ruffle runtime smoke check with:

```sh
npm run verify:runtime
```

This starts an isolated Vite dev server, loads the comparison app in Playwright, verifies that Ruffle and the generated frame-SVG renderer are both present for every scene, captures reference/generated screenshots and simple visual-difference metrics, exercises generated pointer overlays for every scene that exposes them on load, verifies the segment 4 menu hold at `noKiosk`, clicks an extracted overlay, and verifies the next hold at `robust`. It writes evidence under:

```text
verification/ruffle-runtime/
```

The FFDec runtime used by the scripts lives at:

```text
tools/ffdec-runtime/ffdec_26.0.0/ffdec-cli.jar
```

The secondary parser stage uses the Open Flash npm packages:

```text
swf-parser, swf-types, avm1-types
```

Each generated `control-flow.json` and `timeline.json.control` now includes `controlFlowGraphs`:

```text
controlFlowGraphs.root       root-frame nodes and extracted action edges
controlFlowGraphs.sprites    per-MovieClip frame nodes and action edges
controlFlowGraphs.functions  extracted AVM1 function call/assignment edges
controlFlowGraphs.buttons    SimpleButton event nodes with release/hover action edges
```

All bundled SWFs currently classify as AVM1/ActionScript 1-2. No `DoABC`/AVM2 bytecode was found, so RABCDAsm is not required for the current files.

OpenFL SWF is used as an architecture reference for MovieClip/SimpleButton/display-list concepts; see:

```text
docs/openfl-swf-reference.md
```

## GSAP scene converter and player

The newest path converts each SWF into a self-contained, web-native scene
format and runs it with a real GSAP timeline, with no SWF and no Ruffle at
runtime.

```text
timeline.json (per-frame symbol snapshots)
  -> scripts/build-gsap-scene.mjs
  -> gsap-scene.json (one tween track per symbol instance)
  -> src/gsap-scene-player.ts builds a gsap.timeline() of real gsap.to() tweens
```

The converter splits the timeline into per-instance tracks (one per
depth/character span), then compresses constant-velocity runs into keyframes so
linear interpolation between them reproduces the original Flash frame data
exactly at every integer frame. Sprite cell changes are emitted as discrete
source swaps; symbol motion (matrix and opacity) becomes component-wise GSAP
tweens that scrub and play smoothly.

Build the scene files (also part of `npm run convert`):

```sh
npm run build:gsap-scenes
```

Run the standalone player at:

```text
http://127.0.0.1:5173/scene-player.html
```

The player is modular under `src/gsap-scene/`:

```text
types.ts          shared scene/track/runtime types
media.ts          DOM element + media creation (shape/image/sprite/text/button)
tweens.ts         real gsap.to() segments driving matrix + opacity
color-transform.ts exact feColorMatrix filters (multiply + add)
masking.ts        clipDepth masking via affine-mapped clip-path polygons
control-flow.ts   stop frames, label resolution, goto navigation
player.ts         orchestrator composing the modules
```

It now drives the timeline like Flash: stop frames pause playback, timeline
gotos retime the timeline, and button releases navigate (gotoAndPlay parks on a
destination stop). Color transforms (full CXFORMWITHALPHA multiply + add) and
clip-depth masks are extracted by `build-asset-timeline` and applied by the
player. It is available both on the standalone page and as the **GSAP Scene
(tweens)** render mode in the main comparison app beside Ruffle.

Smoke-check the player against every converted scene (screenshots + metrics):

```sh
npm run verify:gsap-scene
```

Remaining work is nested sprite timelines (sprite cells are frame-stepped, deep
nested clips are not yet tweened), non-rectangular mask shapes (approximated by
their bounding box today), and cross-SWF level navigation.

## Flash to GSAP mapping

The conversion target should normalize SWF concepts into web concepts like this:

| Flash/SWF concept | GSAP/web equivalent |
| --- | --- |
| MovieClip | Root-frame SVG now; exported sprite-frame SVG and generated nested timeline metadata |
| Shape | Exported SVG asset |
| Bitmap | Extracted PNG asset |
| Button states | Exported button SVGs plus Open Flash `buttonDefinitions[].states` |
| Sound | Extracted MP3/WAV assets plus generated `playVO` / `attachSound` / `markSndSegment` action metadata |
| Font | Extracted TTF assets plus FFDec-rendered text in frame SVGs |
| Frame | FFDec frame SVG + GSAP stepped timeline timestamp |
| Tween | Currently frame snapshots; can be compacted into `gsap.to()` / `gsap.fromTo()` runs |
| Symbol instance | Absolutely positioned DOM element |
| Transform matrix | CSS `matrix(a, b, c, d, tx, ty)` |
| ActionScript | Extracted `stop()`, labels, root frame `gotoAndPlay/Stop`, SWF release navigation, button release actions, and nested MovieClip target metadata |

## Limits

`Frame SVG` mode is the fidelity path. `Asset Timeline` mode is intentionally less exact today; it is there to inspect extracted symbols and movement while working toward a deeper nested MovieClip/ActionScript compiler.

The current runtime pauses on extracted root `stop()` frames, recognizes extracted two-frame user-choice loops, keeps original sprite-frame animation alive while awaiting a choice, and wires supported button release actions from the original SWF scripts. It also handles supported SWF-to-SWF release navigation where the target maps to one of the bundled scenes. Root-level `bkgd.*` defaults are extracted from `A-tour.swf` initialization code and used to evaluate simple branch conditions such as `bkgd.OSVersion == "Pro"` instead of ignoring every branch body. Top-level literal assignments in `DefineSprite` scripts are exported as `spriteLocalDefaults`, allowing simple local flag branches like `isFaded`, `btnDown`, and `labelHidden` to be evaluated from generated data. Branch-scoped `stop()`, self/root/parent `gotoAndPlay/Stop`, and root/sprite-level `doRelease/loadMovieNum` actions are marked supported only when the generated runtime has a concrete execution path for them. Object method calls such as `_root.s1.stop()` are parsed as generated `stopSound` actions instead of timeline `stop()` controls, so the verifier no longer confuses sound-channel cleanup with unresolved frame control flow. Navigation buttons that set `nav.targSection` and call `exitAnim()` are compiled into generated `exitNavigation` actions: the runtime plays the extracted exit range, stores the extracted `nav.targSection` value, and follows the selected root-frame branch action when the exit frame is reached. Flash level 4 is modeled as the currently loaded segment SWF, so extracted `_level4.gotoAndPlay("segStart")` branch actions resume the generated segment timeline at its own exported label. Root function calls with direct navigation effects, such as `_level0.restartTour()` and `_level0.LoadInitialInteractive()`, are resolved from the extracted `A-tour.swf` function bodies and carry `rootFunctionNavigation` provenance that is verified against the original `A-tour` ActionScript. This provenance is now generated for both button releases and root frame-script branches, so intro frame playback can follow the extracted `_level0.LoadInitialInteractive()` branch into the generated segment timeline. Direct `_level0.initMusic("...")` frame-script calls are resolved through the extracted `A-tour.initMusic` body into exported music-loop `attachSound` actions, and the runtime plays them on a separate looping music channel when browser audio policy allows. Button releases, hover actions, root frame scripts, and local root helper calls such as `setSelect()` are exported as `functionCalls`; the runtime resolves the target instance or root function table and applies extracted self-goto/sound/targeted MovieClip actions when extracted branch conditions evaluate true. Recursive generated `callFunctions` actions are supported for nested method bodies such as Segment 1 `activate()` calling `hideShots()` and `unSelect()`, and nested target placement metadata lets screenshot child sprites such as `inst_sShots_faster.start()` render from their extracted MovieClip frames. Root-level function calls such as `_parent.rampVOout()` are resolved against extracted frame-script functions for supported sound cleanup. This covers Segment 1 screenshot choice buttons such as `mc_faster.showShots()` and preserves nav hover method calls such as `hideMe()`/`showMe()` with their original `btnDown`/`labelHidden` guards. Nested sprite buttons are resolved by walking visible frame-SVG `<use>` references into FFDec definitions, mapping Open Flash button hit-test records back to their owning button IDs, overlaying transparent hit rectangles on the rendered frame, and displaying extracted FFDec button `over`/`down` state SVGs when available. Root-frame and nested-sprite `playVO` actions are mapped to extracted sound assets and played opportunistically by the web runtime when browser audio policy allows. Clip-local nested sprite `gotoAndPlay/Stop` actions are honored for numeric targets, nested sprite labels, and `_currentframe +/- n` loops during waiting-section playback. Root-frame named MovieClip actions are applied cumulatively to named sprite instances when they become visible by overlaying the extracted target sprite frame. Nested sprite-frame actions that target a named child instance now carry FFDec-derived `targetPlacement` metadata and render the target child sprite frame as an overlay during waiting-loop playback. Nested `_parent.gotoAndPlay/Stop` actions that resolve to root labels are compiled into root timeline transitions.

External `loadVariables()` calls are resolved against exported scene variable files. Exact filenames are preferred; the missing Segment 3 `segment3_loc.fla` reference is documented in generated control-flow as a compatibility mapping to `segment3.txt`, which is present in the source package and contains the matching Segment 3 dynamic text keys.

Remaining gaps are mostly full nested MovieClip action compilation. Some nested section targets, `_parent` label transitions, clip-local self loops, and immediate named child-instance gotos are compiled into runtime behavior today; lower-level cross-clip actions such as `_parent.mc_screenshot_1.gotoAndPlay(1)` are listed explicitly in each `control-flow.json` instead of being hidden. Extracted actions are tagged as immediate timeline actions, branch-scoped actions, or function-scoped actions, so the runtime does not accidentally execute code that only appears inside ActionScript branches or function definitions. The artifact verifier reports unsupported goto and sound totals split by timeline/branch/function scope, classifies unsupported actions into risk buckets such as `immediateNavigation`, `deferredNavigation`, `immediateSpritePlay`, and `dataLoads`, and fails if immediate unsupported navigation or addressable named-target gotos remain. Immediate sprite-scope `play()` actions are treated as supported because generated sprite timelines already advance while active; root, function-scoped, and unresolved cross-clip actions remain audited.

## Implementation TODO

- Compile cross-clip nested MovieClip control flow from the generated `spriteActions` arrays.
- Compile branch/function invocation paths for extracted ActionScript bodies.
- Keep using Ruffle as the behavior oracle for frame and interaction comparisons.
