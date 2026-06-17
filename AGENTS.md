# AGENTS.md — mmTour

Orientation for agents/developers working in this repo. Read this before changing
runtime or build code. The README covers the extraction pipeline and what ships in
`public/generated/`; this file covers **what we're building and why**, the runtime
architecture, and the rules that keep it general.

## What we're trying to do

mmTour converts the original **Windows XP Tour** Flash movies into a web‑native player
**without redrawing or faking anything** — every shape, font, sound, frame script and
piece of interaction comes from the SWFs' own decompiled/extracted data. The bar is
**visual and behavioural parity with Ruffle** (the reference SWF player), shown
side‑by‑side in the app: same pauses, loops, hover glows, fonts, navigation, music.

The real goal is bigger than this one tour. The **Decompiled Player** is meant to be a
**general, data‑driven interpreter**: hand it any FFDec‑extracted SWF's timeline +
control‑flow JSON and it should play correctly by *interpreting that data*, not by
running tour‑specific code.

### The one non‑negotiable rule

> **Nothing scene‑specific may be hardcoded.** This is a library that lets *unrelated*
> SWFs be interpreted from their own data.

Concretely: no scene names, character IDs, frame numbers, function names, or
"if this is the nav, do X" branches in the runtime. When you need behaviour, derive it
from the extracted data (frame labels, `globalDefaults`, `definedFunctions`,
`buttonActions`, branch conditions, `overflowsBounds`, OS‑version defaults, …). If the
data doesn't carry what you need, fix the **build step** to extract it, then interpret it
generically. A fix that only works because "segment4 does Y" is a bug, not a fix.

Second rule: **keep files modular.** Small, single‑responsibility modules — not monoliths.

## Render modes

The app shows Ruffle on one side and a selectable renderer on the other (`#renderMode`):

- **`player` — Decompiled Player** *(the focus of almost all work)*: the data‑driven
  AVM1 display‑list runtime. `src/player/*` + `src/app/PlayerController.ts` +
  `src/render/DomRenderer.ts`. This is what "matches Ruffle" must mean.
- **`frame` — Frame SVG (reference)**: a GSAP stepped timeline over FFDec‑rendered
  per‑frame SVGs. High visual fidelity, little interactivity. A fidelity yardstick.
- **`direct` — Direct SWF Renderer**: parses the `.swf` directly (`src/engine/*`,
  `swf-parser`). Experimental/secondary.

When someone says "the player" or "matches Ruffle", they mean **`player`** mode.

## Repository layout

```
public/<scene>.swf            original movies: A-tour, intro, nav, segment1..5
public/<scene>.txt            loadVariables() data (headings, labels, music text…)
public/generated/<scene>/
  timeline.json               assets, per-frame instance lists, frame SVGs, labels, control
  control-flow.json           frame labels/actions, stopFrames, definedFunctions,
                              spriteActions, buttonActions, globalDefaults, dynamicTexts…
scripts/                      build + verification (Node, .mjs)
  export-ffdec.mjs            FFDec/JPEXS extraction
  build-asset-timeline.mjs    extracted assets -> timeline.json (the interpreter's input)
  build-control-flow.mjs      -> control-flow.json
  lib/                        shared pure build helpers (no module state):
    util.mjs / geom.mjs         numeric/string/XML utils; MATRIX + CXFORM converters
    asParse.mjs                 ActionScript source parsers (brace/paren/statement scan)
    svgText.mjs                 SVG asset/text post-processing (reflow, inline embed)
    avm1Disasm.mjs / cfgNodes.mjs  AVM1 bytecode disasm; control-flow-graph node helpers
  verify-*.mjs                Playwright/headless checks
src/
  player/                     the Decompiled Player runtime (see below)
  app/                        the comparison-mode app (main.ts is a thin entry that
                              wires DOM events; everything else lives here):
    dom.ts / state.ts           app-shell DOM refs; shared mutable state + singletons
    modes.ts                    render-mode helpers + Decompiled Player activation
    sceneLoader.ts              scene fetch/activate, fonts, Ruffle + GSAP wiring
    frameMode.ts / buttonOverlays.ts / spriteLoops.ts  Frame-SVG reference mode
    directMode.ts               Direct SWF renderer wiring
    debugPanel.ts               display-list debug panel
    externalLevels.ts           _levelN movie loading + queued cross-level calls
    runtimeActions.ts / runtimeConditions.ts  action selection + branch eval
    timelineQueries.ts / svgUtils.ts / fonts.ts / audio.ts / ruffle.ts  helpers
    frameModeTypes.ts           types for the comparison modes (≠ data/timelineTypes)
    PlayerController.ts         multi-level orchestrator (one Player per Flash _levelN)
  render/DomRenderer.ts        diffs RenderNodes -> DOM; wires button pointer events
  render/TextRenderer.ts       font registry / text
  data/                        timeline types, loader, scene metadata
  engine/                      Direct SWF renderer (secondary)
docs/                         design notes, audits, policies
verification/                 screenshots/artifacts from verify scripts
```

The tour is **multi‑SWF**: the **A‑tour shell** is `_level0`; it `loadMovieNum`s the
intro/segments into **`_level4`** and the nav into **`_level6`**, each on its own stacked
DOM layer. These level numbers come from the SWFs' own load calls — don't hardcode them.

## Decompiled Player architecture

### Pipeline

```
.swf → FFDec extract → timeline.json + control-flow.json   (build time, scripts/)
     → Player interprets that JSON at runtime                (no SWF parsing at runtime)
```

If the runtime can't do something, first ask "is the needed fact in the JSON?" — if not,
extend `build-asset-timeline.mjs` / `build-control-flow.mjs` to emit it.

### Runtime model (`src/player/`)

- **`ClipInstance`** — one node in the live display tree (root or a placed sprite). Holds
  its own playhead (`currentFrame`/`playing`), its persistent child clips (keyed by
  depth), and per‑clip **`locals`** (unqualified AVM1 vars like `btnDown`/`labelHidden`
  are clip‑local; dotted/`_root`/`_levelN`/`_parent` paths are global).
- **`Player`** — owns the timeline data and drives everything: `tickClip` advances
  playheads, `reconcile` creates/prunes child clips, `runScript` runs a frame's actions,
  then `flatten` walks the tree into stage‑space **`RenderNode`s** (matrices composed,
  masks resolved). Also the AVM1 function engine (`buildFunctionTable`, `callFunction`,
  `callClipFunction`, `runCallFunctions`) and button events (`handleButtonEvent`).
- **`DomRenderer`** — diffs the `RenderNode` list against the DOM by key, creating/
  updating `<img>`/SVG/text and transparent button **hit areas** (`.player-hit`,
  `pointer-events:auto`; everything else is `pointer-events:none`). Button pointer
  events route back to the owning Player.
- **`VariableStore`** — flat AVM1 variable store, **shared across all levels**. Normalizes
  `_levelN.` / `_root.` / `_parent.` prefixes to one slot (the store is flat; relative
  *clip targeting* is separate, via `Player.resolveTarget`).
- **`conditions.ts`** — `evalCondition`, a safe mini‑evaluator for the SWFs'
  `functionBranchCondition` strings (`== != < > <= >= ! && ||`, quoted strings, `else`,
  bare truthiness).
- `Ticker`, `matrix`, `types` — frame clock, matrix math, shared types.

### How behaviour is reconstructed (data‑driven AVM1)

The tour's orchestration lives in named AVM1 functions gated by flags like
`bkgd.OSVersion`. We rebuild each function from the extracted data — its variable
`assignments` (`definedFunctions`) plus its gated timeline commands (`frameActions`
tagged with the same `functionName` + a `functionBranchCondition`) — and execute them
against the shared `VariableStore`. Key, easy‑to‑get‑wrong details:

- **Group‑wise if/else.** Inline scripts mix unconditional actions with the arms of
  if/else chains. An `else` arm fires only when **no real‑condition arm in its group**
  matched — evaluating an `"else"` guard in isolation reads as `true` and double‑fires.
  This applies in both `runScript` and `callClipFunction` (the latter runs a flat list
  merged from a sprite's defined‑function body *and* its frame‑tagged actions).
- **AVM1 "if‑once" guard order.** `callFunction` decides body guards against the store as
  it was on **entry** (an `if(!flag){ flag=1; … }` block must fire once, then self‑block),
  with unconditional simple‑name assigns overlaid so a later guard in the same body can
  read them.
- **Sprite‑scoped functions** (a control's `over()/out()`, a button's `hideMe/showMe`)
  run on their clip via `callClipFunction`, with guards resolved against that clip's scope
  (so per‑clip `btnDown`/`labelHidden` work).
- **Cross‑level calls/commands** (`_level0.toggleMusic()`, `_level6.yellowPro.gotoAndPlay("over")`,
  `_level4.gotoAndPlay("segStart")`) route through `PlayerController` to the target level's
  Player; pending calls queue until that level loads.
- **Dynamic text** bound to a `loadVariables()` variable reads the per‑Player `textVars`
  map; a frame‑script assignment to such a variable is mirrored into `textVars` so the
  field re‑renders.
- **Tree vs baked sprites.** A sprite whose animation stays within its baked frame is
  rendered as one composited SVG (with transparent hit overlays); a sprite flagged
  `overflowsBounds` (moving content that would clip) is rendered from the live tree.

## Build & run

FFDec/JPEXS needs Java on PATH first:

```sh
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
```

- **Regenerate everything:** `npm run convert`
  (`extract` → `build:flasm` → `build:timelines` → `build:control-flow` → `build:secondary-cli`).
- **One scene** (after editing the build): `node scripts/export-ffdec.mjs public/<scene>.swf`
  then `node scripts/build-asset-timeline.mjs <scene>`. **`A-tour` is capitalised**; the
  rest are lowercase (`intro`, `nav`, `segment1`…). Remove `extracted/` afterward.
- **Dev server:** `npm run dev` → http://127.0.0.1:5173/. (`Player.ts`/renderer edits hot‑
  reload; no rebuild needed unless you changed a build script or the JSON.)
- **Typecheck:** `npx tsc --noEmit`. **Full build:** `npm run build`.
- **Verify:** `npm run verify:hover` / `verify:runtime` / `verify:text` / `verify:artifacts`,
  plus ad‑hoc Playwright scripts.

## Verifying player behaviour (the practical loop)

Most player bugs are verified with headless Chromium (Playwright):

1. Load the app, pick the scene in `#sceneSelect`, set `#renderMode` to `player`.
2. Drive interaction by dispatching pointer events on `.player-hit` elements (or
   `page.mouse.click()` for real hit‑testing), screenshot `#playerLayer`, and inspect the
   `.player-hit` list (char id, level z‑index, position) — compare against Ruffle.

Gotchas that have burned us:
- The A‑tour view **cycles** after a category click (cascade → toolbar slide‑in →
  settled section → attract‑loop auto‑advance). Sample over time or pause before asserting.
- The player layer often sits **below the fold**; `elementFromPoint`/real clicks need it
  scrolled into view.
- Character IDs are per‑SWF, so the same number means different things across levels —
  always note the level (`z-index`) too.
- Keep throwaway probe scripts out of the tree (delete them); land only real changes.

## Conventions

- Data‑driven over special‑casing; modular files over monoliths (see the two rules above).
- Match surrounding style; comments explain the *why* (especially the AVM1 quirks).
- Commit only when asked. The default branch is `main`.
