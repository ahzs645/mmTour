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

## Staged plan

- **Stage 1 — emit bytecode (DONE).** `data/avm1Bytecode.ts` defines the canonical
  `Avm1Op`; `avm1Control.ts` keeps each `DefineFunction` body's raw bytecode on its
  `DefinedFunction` (in-browser compile only — shipped tour packs use the separate `.mjs`
  build and are unchanged). bnl now carries bytecode on 470/573 functions.

- **Stage 2 — runtime VM wired to the display list.** `src/player/avm1Vm.ts`, seeded from
  `interp.ts`, executing function bytecode with a host interface backed by `ClipInstance`:
  `attachMovie`/`createEmptyMovieClip` create real clips (by linkage/export name);
  `.text`/`.htmlText`/`autoSize`/`setTextFormat` update fields; `_x`/`_y`/`_alpha`/`_width`
  properties; `this[expr]`; the AS2 class system (`registerClass`/`extends`/`super`/
  getters-setters); reuse the player's existing `selectXmlNodes` (XPath) + `DOMParser`
  XML; `mx.utils.Delegate`, `EventDispatcher`, `Tween`. **Gated by bytecode presence so
  the tour path is untouched.**

- **Stage 3 — bootstrap + verify.** On `new XML().onLoad`, drive `Model.parseXML` + the
  View component `init`s through the VM so nav labels, news, subsections, and ticker
  render. Verify side-by-side against Ruffle in the compare view; iterate. Everything
  data-driven — no bnl-specific branches.

## Non-negotiable

Per `AGENTS.md`: nothing scene-specific is hardcoded. The VM interprets each SWF's own
bytecode + its own XML; the same machinery must work for any data-driven AS2 SWF.
