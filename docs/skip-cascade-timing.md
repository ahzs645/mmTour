# Skip‑Intro nav‑entrance cascade timing (handoff)

Date: 2026-06-18
Status: **Open / characterized** — pacing differs from Ruffle; order is correct.
Scope: full‑tour shell only (`#sceneSelect = "Tour Shell - A-tour.swf"`, `#renderMode = player`).

> **Update 2026‑06‑18 — Lead #1 investigated, a real generic branch bug fixed (but it was
> *not* the OS functions, and it does *not* change the skip pacing).** The OS‑version arms
> on `startNavEntrance`/`startAddedNav`/`doIntroStart`/`goNavStatic` are extracted as
> **explicit mutually‑exclusive conditions** (`OSVersion == "Pro"` / `OSVersion == "Per"`),
> **not** `else` — so the old per‑action loop already evaluated them correctly (under Pro,
> the `==Pro` arm passes and the `==Per` arm fails). However, the *general* gap the reviewer
> flagged is real: `Player.callFunction`'s `def.actions` loop lacked the **group‑wise `else`**
> and **parameter localization** that `runScript`/`callClipFunction` already have. A scan
> found **22 function‑tagged `else` arms** + **12 parameter‑referencing conditions**
> (`initMusic(whichSection)` per‑section music, `playVO(... !doRamp)`) that the old loop
> mis‑evaluated (a bare `else` reads as `true` and double‑fires; params evaluated against the
> store, not locals). Fixed via `functionActionDecisions` in `src/player/Player.ts`. Verified:
> typecheck clean, the A‑tour Pro menu still builds in the right order (no regression), all 8
> scenes load with zero console errors. Because the OS branch was already correct, **this does
> not change the skip cascade pacing** — see Lead #1 below, now resolved.

This is a handoff for a future agent. It documents the symptom, the exact data‑flow
(frames, functions, flags), **what has already been verified correct so you don't redo
it**, the measurement traps that burned this investigation, and concrete leads to try.

> Frame‑number convention. Extracted source files are `frame_N` where **N is 1‑based**
> (`scripts/frame_72/DoAction.as` ⇒ **0‑based frame 71**). `timeline.json` `labels`,
> `frames[]`, and `stopFrames` are **0‑based**. This doc uses 0‑based frame numbers and
> notes the source path where relevant.

## Symptom

Press **Skip Intro** in the A‑tour shell. The nav's entrance — the 5 colored category
buttons sliding from the top tabs into the right‑hand menu, their labels fading in, and
the bottom toolbar arriving — plays with **different pacing** than Ruffle side‑by‑side:

- In **Ruffle**, the "tabs across the top" beat holds ~1.8 s, the buttons then slide into
  the menu, and the **bottom toolbar arrives last** (after the buttons settle).
- In the **player**, that beat is compressed: the tabs hold ~0.9 s and the **toolbar
  appears early** (while buttons are still sliding), so things that Ruffle reveals
  sequentially arrive nearly together.

**The reveal _order_ is the same in both** (yellow *Best for Business* → red *Safe and
Easy* → green *Unlock Media* → blue *Connected Home* → silver *Basics*; lower labels just
before upper). This reads to the user as "wrong order," but it is a **timing/pacing**
difference, not a sequence inversion. It is cosmetic — the menu, the navigation, and all
interaction are correct.

## The machinery (this is the important part)

### Levels & frame rates

- A‑tour shell = `_level0` (**fps 20**). intro → `_level4` (fps 15). nav → `_level6`
  (fps 15). The cascade runs on the **nav's root timeline**. Each level has its own
  `Ticker` at its own fps (`Player.ts` constructor, `new Ticker(timeline.fps || 20, …)`).

### The skip button

- **Button 109** in `nav`, owned by sprites `[117, 119]` (`mc_skipIntro_Pro`).
  `on(release){ _level0.LoadInitialInteractive(); }` — a **cross‑level call to level0**
  routed through `PlayerController`.
- Its `.player-hit` appears ~4 s into load and has an **empty `data-key`** (matters for probing).

### Two different destinations (skip vs auto)

| Trigger | Function (in A‑tour `_level0`) | `blnIntroMode` | Result |
|--------|-------------------------------|---------------|--------|
| **Skip pressed** | `LoadInitialInteractive()` | set **0** | interactive **menu** ("To begin the Tour, click a button") |
| **Auto (no skip)** | `LoadIntroNav()` | set **1** | **attract demo loop** (full‑screen section previews, cycling) |

`blnIntroMode` is read by the nav's frame‑113 branch (below) to decide loop vs settle.

### `LoadInitialInteractive` (A‑tour `scripts/frame_1/DoAction.as`)

```as
function LoadInitialInteractive() {
  if (!bkgd.blnDisableSkip) {
    bkgd.blnDisableSkip = 1;
    bkgd.blnIntroMode  = 0;                 // frame 113 will now route to the menu
    resetMenuStates();
    if (!nav.bln_CoreNavLoading && !nav.bln_ExtendedNavLoading) {   // not mid-entrance
      if (!nav.bln_CoreNavLoaded && !nav.bln_ExtendedNavLoaded)     // hasn't entered yet
        _level6.startNavEntrance();          // full cascade from frame 71
      else
        _level6.startAddedNav();             // toolbar-only from frame 115
    }
    if (bkgd.OSVersion == "Pro") { bkgd.doAttractLoop = 1; loadMovieNum("segment4.swf",4,"GET"); }
    else                        { bkgd.doAttractLoop = 1; loadMovieNum("segment5.swf",4,"GET"); }
  }
}
```

So which branch skip takes is **state‑dependent** on where the nav is when you press it.

### nav entrance functions (root scope, OS‑version branched)

Each is `if (Pro) gotoAndPlay(<proFrame>); else gotoAndPlay(<perFrame>);`:

| function | Pro frame | Personal frame |
|----------|----------:|---------------:|
| `startNavEntrance` | **71** (Pro‑BringNavOnStage+1) | 154 |
| `startAddedNav`    | **115** (Pro‑ToolbarAnim+1)    | 198 |
| `doIntroStart`     | 61 | 144 |
| `goNavStatic`      | 24 | 43 |

In the extracted data these arrive as a `calls` array holding **both** gotoAndPlays with an
**empty `body`** (the OS if/else was flattened by extraction). See *Lead #1* — verify the
player executes only the Pro one.

### nav cascade frames (Pro path) & stops

`nav` `stopFrames = [2, 51, 65, 148]`. Relevant frame actions (0‑based):

| frame | source | action |
|------:|--------|--------|
| 61 | `frame_62` | `mc_skipIntro_Pro.doFade()` (fade the skip button) |
| 65 | `frame_66` | `stop()` — the skip/tabs beat waits here |
| 71 | `frame_72` | `nav.bln_CoreNavLoading = 1` (entrance begins) |
| 113 | `frame_114` | **branch**: `if (_level0.bkgd.blnIntroMode) gotoAndPlay(23) else gotoAndPlay(114)` |
| 114 | `frame_115` | `nav.bln_ExtendedNavLoading = 1` (Pro‑ToolbarAnim) |
| 133 | `frame_134` | `gotoAndPlay(327)` (jump to navAnim_Pro) |
| 196 | `frame_197` | branch (Personal): `if (blnIntroMode) gotoAndStop(42) else gotoAndPlay(197)` |

Pro skip path: `71 → … → 113 → (blnIntroMode 0) → 114 → … → 133 → 327` (navAnim_Pro).

### The four loading flags (nav‑scoped)

- `bln_CoreNavLoading` / `bln_ExtendedNavLoading` — "**currently animating** the entrance."
  Set 1 at frames 71 / 114 (Pro), 154 / 197 (Per). Cleared 0 at the static rest frames
  0 / 17 / 24 / 34 / 42.
- `bln_CoreNavLoaded` / `bln_ExtendedNavLoaded` — "entrance **has completed**." Set 1 at
  17 / 24 / 34 / 42; cleared 0 at frame 0.

These gate `LoadInitialInteractive` (above). They are **not** a load‑wait hold — they
prevent re‑triggering an in‑progress/finished entrance.

### Sprites of interest

- Category groups (baked, `overflowsBounds=false`, ~56–62 internal frames): `107`=yellowPro
  (*Best for Business*), `106`=redPro (*Safe and Easy*), `105`=greenPro (*Unlock Media*),
  `104`=bluePro (*Connected Home*), `103`=silverPro (*Basics*). Placed at root frame 22,
  stageY≈24, stageX 366→596. Rendered as `<img src=".../sprites/DefineSprite_<id>/<frame>.svg">`.
- Toolbar bar = sprite `3` (Pro‑ToolbarAnim, frame 114). Toolbar buttons = sprites `12`,
  `110` (`overflowsBounds=true`, tree‑rendered).

## What has already been verified CORRECT (do not re‑investigate)

1. **The skip gate is evaluated.** `Player.callFunction` (`src/player/Player.ts`, ~L362)
   runs each body statement guarded by `branchPasses(branchCondition)` → `evalCondition`
   (~L471). The nested `(!bln_CoreNavLoading && …) && (!bln_CoreNavLoaded && …)` is honored;
   the player picks `startNavEntrance` / `startAddedNav` / neither correctly.
2. **The flags unify across levels.** nav writes `nav.bln_CoreNavLoading`; level0 reads
   `_level6.nav.bln_CoreNavLoading`. `VariableStore.normalizeVarName` strips a leading
   `_levelN.`, so both map to the **same slot** `nav.bln_CoreNavLoading`. (A scope mismatch
   was suspected here — there is none.)
3. **The flags are maintained.** The nav's `setVariable` frame actions (71/114/… set,
   0/17/24/34/42 clear) run as the nav plays, so the gate sees real values.
4. **Per‑level fps is correct.** nav ticks at 15 fps via its own `Ticker`; the cascade
   `71→113` takes the right ~2.8 s — it is **not** compressed by a wrong clock.
5. **Nested category sprites are gated, not free‑running.** A trace showed 107/106/…/103
   first render at internal frame ~2 when revealed (not mid‑animation), i.e. they don't
   advance from their frame‑22 placement. *(Worth a quick re‑confirm via `spriteStopFrames`
   for ids 103–107 in `nav/timeline.json` — see Lead #3.)*

Net: the **data‑driven gating that was proposed as the fix is already in place.** The
residual difference is the **clock** the engines run on — the player resolves the
intro + async timeline/segment fetches on a different schedule than Ruffle decodes the
SWFs, so the nav sits at a *different frame* when Skip is pressed and routes through a
different (but gate‑correct) branch. The order is faithful; absolute pacing tracks each
engine's own load/intro timing.

## Measurement traps (these burned the first pass)

- **Non‑determinism.** Run‑to‑run timing varies a lot; a single capture is not evidence.
- **Auto‑entrance overlaps skip.** By the time the skip `.player-hit` is clickable (~4 s),
  the nav has often **already auto‑entered** (via `LoadIntroNav`), so clicking skip
  re‑triggers / lands at a later state. "Press skip, then measure" does **not** isolate
  the skip cascade. Auto‑play and skip gave *opposite* results (auto‑play: player lags;
  skip: player ahead) — likely this confound, not two real bugs.
- **DOM presence ≠ visual appearance.** Baked sprites are *placed* early (their `<img>`
  exists) but slide into view via matrix animation. Detecting
  `img[src*="DefineSprite_<id>/"]` presence does **not** capture the visual cascade timing —
  everything showed "present at ~105 ms."
- **The skip `.player-hit` has an empty `data-key`** — select it positionally, not by key.
- **Ruffle is a `<canvas>`** — you cannot read its DOM. Compare by screenshots/montage only.

## How to reproduce / probe

Dev server on `:5173`. Player stage = `#assetStage`; Ruffle stage = `#ruffleMount`
(same size, side by side). Scene value `0` = A‑tour; set `#renderMode` = `player`.

Click Ruffle's skip by mapping the player skip hit‑area's **stage‑relative** position onto
`#ruffleMount` and issuing `mouse.move` + `down` + `up`. Capture paired screenshots over
the cascade window and montage with ffmpeg (`/opt/homebrew/bin/ffmpeg`, `xstack`).

Reusable skeleton (Playwright; delete after use per repo convention):

```js
import { chromium } from "playwright";
const page = await (await chromium.launch()).newPage({ viewport: { width: 1500, height: 1000 } });
await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded" });
await page.selectOption("#sceneSelect", "0");
await page.selectOption("#renderMode", "player");
for (let i = 0; i < 60; i++) { await page.waitForTimeout(200); if (await page.locator(".player-hit").count()) break; }
const loc = await page.evaluate(() => {                       // map skip hit → ruffle stage
  const h = document.querySelector(".player-hit").getBoundingClientRect();
  const s = document.querySelector("#assetStage").getBoundingClientRect();
  const r = document.querySelector("#ruffleMount").getBoundingClientRect();
  return { x: r.x + ((h.x + h.width/2 - s.x)/s.width)*r.width, y: r.y + ((h.y + h.height/2 - s.y)/s.height)*r.height };
});
await page.locator(".player-hit").first().click();
await page.mouse.move(loc.x, loc.y); await page.mouse.down(); await page.mouse.up();
for (let i = 0; i < 12; i++) {                                // capture both cascades
  await page.locator("#assetStage").screenshot({ path: `verification/_x/player_${i}.png` });
  await page.locator("#ruffleMount").screenshot({ path: `verification/_x/ruffle_${i}.png` });
  await page.waitForTimeout(450);
}
```

Montage: `ffmpeg -i player_00.png … -filter_complex "…xstack=inputs=12:layout=…" grid.png`.

Inspect the data with `node -e` over `public/generated/{nav,A-tour}/timeline.json`
(`control.definedFunctions`, `control.frameActions`, `control.stopFrames`,
`control.buttonActions`, `labels`). To read real `.as`, re‑extract:
`export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"; node scripts/export-ffdec.mjs public/nav.swf`
(and `A-tour.swf`), then `rm -rf extracted` when done.

## Leads to try (highest value first)

1. **OS‑version branch on the entrance functions. — RESOLVED 2026‑06‑18.** The `calls`
   array on these `definedFunctions` (two unguarded `gotoAndPlay`s, empty `body`) is **not**
   what the runtime executes: `buildFunctionTable` (`Player.ts` ~L283) pulls only `def.body`
   and function‑tagged `frameActions` into the function table. Those frame‑tagged actions
   carry **explicit** `OSVersion == "Pro"` / `OSVersion == "Per"` conditions (verified in
   `nav/timeline.json` `control.frameActions`), so the player already enters only the Pro
   frame. The associated *generic* bug — `callFunction` not doing group‑wise `else` /
   localization — **was real elsewhere and is now fixed** (see the Status update at the top
   and `functionActionDecisions` in `Player.ts`). Re‑testing showed the nav still builds
   correctly and the skip pacing is unchanged, so this lead is **not** the pacing cause.
2. **Instrument, then compare — don't eyeball.** Add a temporary hook exposing the nav
   (`_level6`) `currentFrame` and a store snapshot (the 4 `bln_*` flags + `blnIntroMode`)
   each tick. Log, at the exact moment `LoadInitialInteractive` runs: the nav frame and
   which branch fired. Run several times. This tells you whether the skip path is even the
   same branch as Ruffle, and whether the difference reproduces.
3. **Re‑confirm nested‑sprite gating.** Check `nav/timeline.json`
   `control.spriteStopFrames` for ids 103–107: do they `stop()` at internal frame ~1 until
   the entrance plays them, or free‑run from placement (frame 22)? If they free‑run in the
   player but Ruffle holds them, the cascade compresses. (The frame‑2 trace suggests gated,
   but verify.)
4. **intro → nav handoff timing.** When does the intro (`_level4`) call `LoadIntroNav` /
   `LoadInitialInteractive`? If the player's intro is shorter, the nav enters earlier and
   skip lands later. Inspect `intro/timeline.json` frame actions for these calls and any
   VO‑hold gating them.
5. **Attract‑loop (auto‑play) lag — separate issue.** Without skip, the player's attract
   demo cycle (`LoadIntroNav`, `blnIntroMode=1`, nav loops `23→113→23`) lagged Ruffle by
   ~1 section over ~5 s. Investigate per‑iteration timing and any VO/timer hold —
   `Player.evalGuard` (L452) resolves `timeMarkDone(inc)` against `bkgd.timeTarg`
   (set by `_level0.setTimeMark`), which is what holds the attract loop. Verify the hold
   duration matches Ruffle.
6. **`doFade` on skip (minor/cosmetic).** Frame 61 calls `mc_skipIntro_Pro.doFade()`. On
   skip, does the skip button fade out (Ruffle) or vanish instantly (player)?

## Files to review

- `src/player/Player.ts` — `callFunction` (L362), `branchPasses` (L471), `runBodyStatement`
  (L476), `runCallFunctions` (L561), `callClipFunction` (~L590), `evalGuard` (L452),
  `handleButtonEvent` (~L210), `tickClip` (L682), constructor `new Ticker` (~L146).
- `src/player/VariableStore.ts` — `normalizeVarName` (level‑prefix stripping).
- `src/player/Ticker.ts` — the GSAP‑tween clock (per level).
- `src/app/PlayerController.ts` — `handleNavigate`, `createLevel`, cross‑level calls
  (`flushPendingCalls`, `pendingCalls`), `checkWaiters`/waiters.
- `scripts/lib/actionscript.mjs` — function/call extraction, the OS‑branch flattening.
- `public/generated/nav/timeline.json`, `public/generated/A-tour/timeline.json`.

## Recommendation

Treat as a **documented known limitation** unless Lead #1 or #3 turns up a real data gap.
The gates are honored, fps is right, flags are right; a pixel‑for‑pixel Ruffle timing match
would require artificially pacing the nav to Ruffle's clock — the scene‑specific hardcoding
the project forbids (`AGENTS.md`) — and risks regressing the working multi‑level nav.
