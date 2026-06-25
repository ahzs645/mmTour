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

- **Stage 3 — bootstrap + verify (IN PROGRESS).** The player now advances root to the
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
  concatenation on our null-prototype instances no longer throws). With these, the whole
  app **executes to completion** — `TopNav.init`/`News.init`/etc. run their real bodies
  (`attachMovie` + AS2 `set label`/`set title` setters → text fields).

  **Remaining (rendering-detail bugs):** the dynamic text isn't visually correct yet — some
  fields get wrong values (e.g. a static label overwritten with `undefined`) and the
  `attachMovie`-created buttons' `label_txt` overrides aren't surfacing in the flatten/
  render path. These are execution/render-plumbing bugs to chase next (value correctness in
  the View loops; rendering text overrides on runtime-attached clips), not architectural.

## Non-negotiable

Per `AGENTS.md`: nothing scene-specific is hardcoded. The VM interprets each SWF's own
bytecode + its own XML; the same machinery must work for any data-driven AS2 SWF.
