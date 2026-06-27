# Rendering data-driven AS2 apps (the bnl case): the runtime AVM1 VM

## The problem

`bnl.swf` ("Buy n Large", the WALL·E promo site) is not a timeline animation — it's a
full **AS2 Model-View-Presenter application** (`com.buynlarge.*` packages, the `mx.*`
framework). It builds its entire UI at runtime in class methods:

- `Model.init()` → `new XML(); xmlData.onLoad = Delegate.create(this, onXMLLoad); xmlData.load("xml/bnl_en.xml")`
- `Model.parseXML()` → walks the XML with `com.xfactorstudio.xml.xpath.XPath.selectSingleNode/selectNodes`
  into data objects (`HomeDO`, `SectionDO`, `SubsectionDO`, …)
- View components (`TopNav`, `News`, `Ticker`, `Section`, …) run loops that `attachMovie`
  each row and fire AS2 setters (`set label(s){ label_txt.text = s; autoSize = true }`)

Nothing is static — no nav bar, headline, subsection title, or ticker item exists until
that code runs. Our **decompiled player** renders the baked chrome (logo, gradient,
footer, robot subnav) but every XML-driven element is blank.

### Why the legacy path can't do it

The player executes a function from a lossy **assign/call** body model
(`BodyStatement = assign | call`). bnl's logic is `while` loops over XPath node lists
that build object arrays via `new ClassName()`, `this[expr]` dynamic targeting, AS2
getters/setters — none of which the assign/call model can represent. Measured coverage:
**8 of 573 functions**; `dynamicTexts: 0` (the fields are addressed by instance path at
runtime, not bound to a variable our build extracts).

The fix is a real **runtime AVM1 bytecode interpreter** wired to the display list.

## Proof it works (de-risked)

A ~200-line VM (extended from `convert/avm1/interp.ts`) ran bnl's **actual `parseXML`
bytecode** against the **actual `bnl_en.xml`** and produced the exact missing content:

```
homeDO.subsectionTitle: "Corporate News"
companyDO.title:        "Our Company"
divisionDO.title:       "Business Divisions"
roboticsDO.title:       "Robotics"
newsDO.title:           "Corporate News"
newsDO.topstory.title:  "Buy n Large Economics Wins Consumer Science Award"
storeDO.title:          "Buy n Large Store"
contactDO.title:        "Contact Us"
…plus futureDO / promiseDO / valuesDO bodies, ticker items, etc.
```

Key things the VM needed beyond the build-time scanner:
- **DefineFunction2 register preload** — `this`/`_root`/… are preloaded into registers
  per the function `flags` (bnl's `parseXML` has `flags 0x29` → `this` in register 1).
- **`new ClassName()`** constructs an object (constructors run / are shimmed).
- **A native XPath shim** for `com.xfactorstudio.xml.xpath.XPath.selectSingleNode/selectNodes`
  over a DOM (`//tag` = descendant search), plus node `.attributes` / `.firstChild.nodeValue`.
- **Array `.push`**, `parseInt`, member get/set on plain objects.

## Entry point (bnl)

The root timeline's `frame_3` runs `com.buynlarge.BuyNLarge.main(this)`, which constructs
the Presenter/Model/View and `attachMovie`s the components onto the root by **linkage
name** (`"topNavButton"`, `"subsectionClip"`, …). `Model.init()` then loads the XML; its
`onLoad` runs `parseXML`, and the View `init`s populate the attached clips' fields.

## Staged plan

- **Stage 1 — emit bytecode (DONE).** `data/avm1Bytecode.ts` defines the canonical
  `Avm1Op`; `avm1Control.ts` keeps each `DefineFunction` body's raw bytecode on its
  `DefinedFunction` (in-browser compile only — shipped tour packs use the separate `.mjs`
  build and are unchanged). bnl now carries bytecode on 470/573 functions.

- **Stage 2 — host-pluggable VM core (DONE).** `src/player/avm1Vm.ts`: a runtime AVM1
  interpreter whose object/clip/property access goes through an `Avm1Host`. Verified
  end-to-end against bnl's real `parseXML` bytecode + real `bnl_en.xml` (extracts every
  nav/section title). Not yet wired into the player.

- **Stage 2a — extract symbol linkage (PARTIAL).** `compileScene` now emits a
  `timeline.linkage` (name → id) map and pushes `asset.linkageNames` for exported symbols.
  **Remaining gaps found:** (1) the in-browser compile's `assets` map holds only *leaf*
  assets (shapes/images/text/sounds), not **sprite/clip definitions**, so `attachMovie`
  has no sprite to resolve for `topNavButton` etc. — the in-browser compile needs a sprite
  asset model (the node build has one). (2) `control.registeredClasses` (linkage → class
  path, from `#initclip` `Object.registerClass`) is emitted by the node build but **not**
  the in-browser compile; detect it from the `registerClass` bytecode.

- **Stage 2b integration map (how it plugs in).** The runtime `FunctionDef`
  (`buildFunctionTable`) does **not** carry bytecode yet and merges by `functionName`
  (many classes share `init`/`set label`), so the VM must dispatch by **class**: the
  player already keys class methods in `methodFunctions` by `methodSourceKey(def.source)`
  + name (so `TopNav.init` ≠ `News.init`). Steps: (1) add `bytecode` to the runtime
  `FunctionDef` and populate it per-method in `buildFunctionTable`; (2) emit
  `control.registeredClasses` (linkage → class path) from the `Object.registerClass`
  bytecode so attached clips bind to their class; (3) route a bytecode-carrying method
  call through `Avm1Vm` with a player-backed host; gate on `def.bytecode` so the tour's
  (bytecode-free) functions keep the legacy path untouched.

- **Stage 2b — player host (TODO, runtime).** An `Avm1Host` backed by `ClipInstance`:
  `attachMovie`/`createEmptyMovieClip` create real clips from the library (by linkage),
  run their `#initclip`-registered class constructors; `.text`/`.htmlText`/`autoSize`/
  `setTextFormat` update fields; `_x`/`_y`/`_alpha`/`_width` props; `this[expr]`; the AS2
  class system (`registerClass`/`extends`/`super`/getters-setters); reuse the player's
  `selectXmlNodes` (XPath) + `DOMParser` XML; `mx.utils.Delegate`/`EventDispatcher`/`Tween`.
  **Gated by bytecode presence so the tour path is untouched.**

- **Stage 2b — player host (DONE).** `src/player/avm1App.ts` runs the app through `Avm1Vm`
  against a live display list via a `PlayerBridge` (Player.ts: `attachMovieByLinkage`,
  text leaves, clip props, linkage map). Gated on `initActions` + `frameBytecode`; a tour
  SWF in the studio is verified untouched (no `avm1App` activity, renders normally).

- **Stage 3 — bootstrap + verify (DONE — it renders).** The player advances root to the
  entry frame (so the View container instances exist) and runs `BuyNLarge.main` through the
  VM. **Verified working end-to-end in the player**: 95 `#initclip` programs build the class
  tree, `BuyNLarge.main → Presenter → Model → new XML().load("xml/bnl_en.xml")` fetches the
  real 54 KB XML, `parseXML` builds the data model, the `xmlLoaded`/`populateData`
  EventDispatcher events fire, and every View `init` is invoked with the correct content
  (`topNav.init([7 section DOs])`, `news.init(newsDO)`, `ticker.init([17 items])`, …).

  **Class binding solved.** Placed View clips now bind to their component classes:
  `extractRegisteredClasses` (build) symbolically scans the `#initclip` bytecode for
  `Object.registerClass("linkage", a.b.Class)` and emits `control.registeredClasses`
  (linkage → class path); at runtime the host resolves that path against the *completed*
  class tree, sidestepping the init-order issue where `registerClass` captured the class
  before its namespace finished building. The VM also got a safe string coercion (AS2
  concatenation on our null-prototype instances no longer throws).

  **The `tagFqn` fix made it render.** XPath/EventDispatcher are recognised by a class's
  fully-qualified name; the tagging walk recursed through `_global`/`_root` self-references
  and produced bogus `_global._global.…` prefixes, so those overrides never matched and the
  data objects came back with empty titles. Skipping the circular keys and guarding cycles
  (a `tagged` WeakSet) fixed it. With that, the Decompiled Player shows the live
  XML-driven content: **24 unique dynamic text leaves** — all six nav labels (Our Company,
  Business Divisions, Robotics, World News, Buy n Large Store, Contact Us), the news
  headline + article bodies, the news-link list, robot names, and the contact privacy
  text — matching the Ruffle reference.

## Stage 4 — rendering fidelity (DONE — the home view matches Ruffle)

Four fidelity bugs that made the working render diverge from Ruffle, each fixed
generically (no scene-specific code):

- **Embedded fonts were all rejected → everything fell back to Arial.** SWF
  `DefineFont3` uses a 20480-unit em square, but OpenType/OTS (Chrome's font
  sanitizer) caps `unitsPerEm` at 16384, so every in-browser-built bnl face
  ("TradeGothic Bold" for the nav/headlines, the Frutiger faces, …) failed to
  decode and the browser silently used Arial — losing the bold weight and the
  correct glyph metrics. `convert/fontBuilder.ts` now scales any oversized font
  (outlines + advances + vertical metrics) down to a valid 2048-unit em. This was
  the dominant visible defect; with it the text renders in the real faces.

- **The top-nav overflowed ("Contact Us" fell off the bar).** The nav positions
  each item by the previous item's `_width`/`textWidth` (autoSize), which the
  player estimated as `0.62 × fontHeight × chars`. TradeGothic Bold is condensed,
  so every label was over-measured and the drift accumulated. `Player` now measures
  with the field's real embedded font via canvas (advance widths, like Flash's
  `textWidth`), gated on the face having loaded.

- **The privacy footer lost three of its four lines.** Flash's soft break
  `<sbr />` is an unknown, non-void tag; the HTML parser nested every following
  sibling inside it and the serializer dropped them. `render/DomRenderer.ts`
  normalizes `<sbr>` to a real void `<br>` first.

- **The robotics roster leaked onto the home view.** Section reveal panels are
  placed on the timeline and bound to their AS2 component classes, but only
  `attachMovie`'d clips ran their constructor — and the constructor is where a
  Section hides itself until activated. `player/avm1App.ts` now runs the AS2
  constructor once for any timeline-placed class-linked clip (matching Flash's
  instantiation semantics), so the robotics section stays hidden until opened and
  the top-right panel is empty, as in Ruffle.

## Stage 5 — frame-locked animation + interactive navigation (DONE)

- **Animations ran on wall-clock, not the frame clock.** The app drove its timers,
  tweens and `onEnterFrame` from `setTimeout`/`setInterval`/`Date.now`, decoupled
  from the SWF frame rate, so its phase drifted from Ruffle; repeating timers were
  disabled outright; and frame-based tweens snapped to their end instead of
  animating. `runDataDrivenApp` now returns an `enterFrame(dtMs)` hook the Player
  calls from `onTick`, and a frame-locked scheduler advances everything in lockstep
  with the frame rate: timeouts/intervals fire off an accumulated frame clock
  (`getTimer` returns it), `mx.transitions.Tween` animates over its real duration
  with its easing applied, clip `onEnterFrame` handlers run each frame, and per-tick
  mutations coalesce into the Player's single post-tick render. Repeating intervals
  are re-enabled, so the background feature rotation runs as in Flash.

- **The top-nav layout could drift on a font-load race.** The nav lays out once
  from `textWidth`; if the embedded face hadn't loaded yet, the measurement fell
  back to the char-count estimate and the bar stayed mis-spaced. `FontRegistry`
  now exposes `ready()` and the data-driven bootstrap waits on it, so the layout
  always measures the real face — matching Ruffle's bullets to within a pixel.

With these, **section navigation works and animates**: clicking a top-nav item
transitions to that section with its left subnav, header and themed background, as
in Ruffle (verified against Ruffle for the Robotics section).

**Remaining (section content, not blocking):** inside an opened section the reveal
panel's subsection body text isn't routed to the visible content area yet (the data
is present in the tree but several sections' subsection clips overlap at the same
position and the active one isn't surfaced), and a section's robot/preview bitmap
renders with an opaque matte instead of its alpha. These are section-content
routing/image-alpha refinements on top of a home view and navigation that now match
Ruffle.

## Non-negotiable

Per `AGENTS.md`: nothing scene-specific is hardcoded. The VM interprets each SWF's own
bytecode + its own XML; the same machinery must work for any data-driven AS2 SWF.
