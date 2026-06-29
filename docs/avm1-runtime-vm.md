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

## Stage 6 — section reveal-panel content (DONE)

- **A section's body text stayed invisible.** Each section's content panel
  (`subsectionHolder` → `subsection_N` → `body_txt`) is authored hidden in the SWF
  — placed with a color-transform alpha of 0 — and revealed at runtime when the
  section opens by setting `_alpha = 100`. The flatten *multiplied* the placement's
  design alpha by the runtime clip alpha, but in Flash they are the same property:
  `_alpha` REPLACES the placement alpha. So `design(0) × runtime(100)` stayed 0 and
  the revealed copy never showed. `Player.placedAlpha` now lets a runtime `_alpha`
  override the design alpha (in data-driven app mode; the tour keeps the legacy
  multiply). Opening a section now shows its subsection body text — e.g. the
  Robotics "About" copy — matching Ruffle.

- **The selected top-nav label didn't turn white.** AS2 components restyle fields
  at runtime via `TextField.setTextFormat(...)`; the top-nav whitens the selected
  item's label (and reverts the previous one) with
  `label_txt.setTextFormat({color})`. The VM didn't handle `setTextFormat`, so the
  selected label kept its dark colour — dark-on-blue, which read as "off". A
  `setTextFormat` bridge path now applies the format (color/size/align/leading)
  through the existing text override, so the selected item turns white like Ruffle.

## Stage 7 — robot image matte (DONE)

- **A section's decorative robot bitmap showed a black box instead of a cutout.**
  The Robotics robot arm is char **236**, a `DefineBitsJPEG3` — a JPEG plus a
  *separate* zlib-compressed alpha channel that cuts the arm out of its background.
  (An earlier diagnosis blamed a `clipDepth` mask on char 234/232; that was wrong —
  the image carries its own alpha and needs no mask.) The in-browser compiler's
  `bitmapBytes` (`src/convert/compileScene.ts`) routed *every* JPEG variant through
  `mergeJpeg`, which keeps only the opaque JPEG and discards the JPEG3/4 alpha. So
  the arm rendered as an opaque rectangle — the black JPEG matte — over the leaves.
  `bitmapBytes` now detects alpha JPEGs (`isAlphaJpegBitmap`), decodes them via the
  existing `decodeJpegAlpha` (JPEG → RGBA, then zlib-inflated alpha applied per
  pixel) and emits an RGBA **PNG**, exactly like the lossless path; plain JPEGs with
  no alpha stay JPEG. Verified end-to-end: char 236 now emits `images/236.png`
  (456×309) whose alpha channel is ~62% fully transparent with soft (partial) edges
  and an opaque arm — so the robot shows cut out over the leaf background, matching
  Ruffle. This mirrors `bitmapToDataUrl`, which already handled alpha JPEGs; only the
  compile-to-file path had the gap.

## Stage 8 — Robotics-section text polish (DONE)

Three more text fields in the Robotics section drifted from Ruffle:

- **The "New Robots!" badge truncated to "New Robot" and used the wrong font.** The
  badge label is a *composed* (clipped) text field, rendered by `DomRenderer.svgText`
  inside an SVG `<foreignObject>`. Three things were wrong: (1) the path hardcoded
  `font-family:sans-serif`; (2) the foreignObject clipped text to its own box (a Flash
  field draws past its bounds); (3) most importantly, `svgText` builds the `<div>` as an
  innerHTML string with a **double-quoted** `style=""` attribute, and the resolved family
  stack contains double-quoted names (`"swf-font-43", …`) — so the first quote closed the
  attribute and the whole `font-family` (plus everything after) was silently dropped,
  leaving the label in a system sans. Fix: resolve the embedded face (threaded through
  `maskGroupSvg`/`svgImage`), set `overflow:visible`, and **single-quote the font names**
  so the attribute survives. The badge now renders in its embedded TradeGothic Bold,
  matching Ruffle. (The normal text path was unaffected because it sets
  `element.style.fontFamily` as a DOM property, not an attribute string.)

- **The section-title tab showed a squished sliver instead of "Robotics".** bnl authors
  the title field ~10px wide and lets it autoSize to its text. We rendered the fixed box
  and compressed "Robotics" to fit. `Player.leafNode` now measures a single-line autoSize
  field (flag captured from `DefineEditText` in `editTextStyle`, or set at runtime via
  `leafProps.autoSize`) and grows the box. Note the grow anchor comes from the autoSize
  *direction* ("left"/"center"/"right", `true`=left) — **not** text alignment: an early
  version shifted by text-align, which slid the center-aligned-but-autoSize="left" top-nav
  labels left under their bullets and broke nav spacing. The tab now shows a full-size
  "Robotics" and the nav stays aligned.

- **The "ROBOTICS" wordmark rendered letter-spaced ("R O B O T I C S").** Its font
  (char 240, "Impact") ships *no* `FontAdvanceTable`; `buildTtf` then gave every glyph a
  full-em advance, so each letter sat an em apart. `buildTtf` now derives a glyph's
  advance from its own outline (`xMax` + a small right bearing) when no table is present,
  matching the condensed face. This also tightened the "New Robots!" font (char 43, also
  table-less). Fonts that ship advances are unchanged.

**On the top-nav "pill":** bnl has **no persistent selected state** — the pill is
`topNavButton.background._visible`, set `true` only on rollover and `false` on rollout (no
"selected"/"enabled" gate anywhere in the component). The `TopNavButton` constructor sets
`background._visible = false` up front, so at rest every item is plain text + bullet.

The Robotics section now matches Ruffle: alpha-cutout robot, full-size title, tight
wordmark, the "New Robots!" badge in its embedded face, body text, subnav, and themed
background.

## Stage 8a — the rollover pill was baked on for *every* nav item (DONE)

A later look found the nav rendering **all** items with the blue pill at rest — Ruffle
shows none until hover. Root cause was the **tree-vs-baked** split, not the pill logic:
`topNavButton` (char 63) is a sprite with baked frames and no `overflowsBounds`, so
`flatten` rendered it as **one composited `DefineSprite_63/1.svg`** (pill 3-slice + bullet
+ a placeholder label) and only overlaid the live `label_txt`. The constructor's
`background._visible = false` *did* run and set the child clip's `visible = false`, but the
bake is composited at the SWF's **design-time** state (pill visible), so the runtime hide
never reached the picture. (The constructor runs and the hide lands — confirmed by reading
the background child's `visible` at flatten time — it just couldn't affect a baked frame.)

Fix (`Player.flatten`, generic): a sprite whose subtree holds a **runtime-hidden child
clip** (`visible === false`) is pulled onto the live-tree render path instead of baked, so
the `child.visible === false` skip already in `flatten`/`collectButtons` actually drops it.
New `subtreeHasHiddenChild`, gated on `hasAnyDynamicInstances` like the sibling
dynamic-instance check, so a scene that never mutates its display list keeps baked-frame
fidelity. With it the nav matches Ruffle: plain at rest, and on hover the one hovered item
gets its pill + white label (`background._visible = true` → that subtree no longer hidden →
re-bakes with the pill, sized to the label by `set label`).

## Stage 8b — the Corporate-News "TOP STORY" lede overlaps the headline (DIAGNOSED)

In the news section the `NewsTopStory` panel draws its lede text *on top of* the wrapped
headline (the right-column `NewsStory` renders fine). The component positions each lede
line relative to the headline height:

```as
// NewsTopStory.set lede
this.textClips[0]._y += (this.titleClip.title_txt._height - 25.6) + 2;
```

### Stage 8b — FIXED

Four independent defects stacked up; all four are fixed and the lede now sits below the
headline (verified against the live in-browser-compiled bnl, plus the home/Robotics/
Business-Divisions sections for regressions). An earlier note guessed the blocker was a
bytecode-extraction *truncation* — disassembling the setter disproved that: its 187 ops are
all there, including `textClips[0]._y +=`. The real blocker was a **double-decode** bug
that, together with the array reversal, made the offset read garbage / land on the wrong
field.

1. **`InitArray` reversed every array literal.** `avm1Vm`/`convert/avm1/interp.ts` built the
   array with `arr.unshift(stack.pop())`. AVM1 pushes elements last-first, so the top of the
   stack is element 0 (Ruffle: `array[i] = pop()`); `unshift` flips it, so `[a,b,c][0]` came
   back as `c`. `textClips[0]` (the *first* lede line, the one the `_y` nudge anchors on)
   resolved to the last, unplaced field → the assignment was a no-op. Fix: `arr.push`. Only
   data-driven apps run through this VM (the tour uses the legacy assign/call path), and bnl
   home/sections/ticker were re-verified.
2. **`ActionPush` doubles were decoded with the halves swapped.** The SWF stores a type-6
   double's two 32-bit words **high-word-first**; `parse.ts`/`avm1Disasm.mjs` read them as a
   plain little-endian `getFloat64`, so `25.6` decoded as `-2.353438281290117e-185`
   (`_height - 25.6` ≈ `_height`, throwing the offset off). New `readSwfDouble` assembles
   `[low][high]` first. (`0.0` is symmetric under the swap, which is why most of bnl's 986
   double pushes looked fine and the bug hid for so long — only the non-zero constants like
   25.6 / 0.5 / 87.5 were wrong.)
3. **A text leaf's `_x`/`_y` weren't readable.** `Player.getAppTextProp` handled
   `_width`/`_height`/`textColor` but returned `undefined` for `_x`/`_y`, so
   `text_txt._y += …` computed `undefined + n = NaN` and never moved the field. A leaf's
   `_x`/`_y` now default to its placement matrix `tx`/`ty` (pixels), like a clip's
   `placedX`/`placedY` (`textLeafPlacement`).
4. **Wrapped-text height was under-measured for the headline font.** Line height was
   `fontHeight + leading`, but Flash advances lines by the font's real **ascent+descent**.
   For TradeGothic Bold (the headline face) that's ~1.17× the em, so the 2-line title
   measured ~39px vs Flash's ~47, and the `_height - 25.6` offset under-shot. `lineHeightBase`
   measures the embedded face's `fontBoundingBox{Ascent,Descent}` via canvas (≈21px@18px vs
   fontHeight 18) and feeds both the metric and the rendered line spacing; fonts where it
   equals the em (the Frutiger body faces, so the news-link separators from Stage 9) are
   unchanged. Gated on `hasAnyDynamicInstances`, so non-data-driven scenes keep their
   baseline.

## Stage 9 — left-subnav vertical spacing (DONE)

The left-column subnav (e.g. Business Divisions → SYNOPSIS / BUSINESS COMMUNITIES /
BUSINESS ETHICS) stacked ~3px too tight per item, so the labels crept upward relative
to their separator lines and drifted further with each row. `LeftNav.populate` stacks
the attached `left nav button` clips by each one's `_height` (`_loc6_ += _loc2_._height`),
and `LeftNavButton.set title` first sets `title_txt._y = 8`, then
`bottomBar._y = title_txt._height + 15` — so a button's height is defined by its
runtime-moved `bottomBar`. Our `liveClipBounds` (which backs the `_height` the component
reads) measured each child from its **static** `instance.matrix`, ignoring the runtime
`bottomBar._y` override, so every button reported ~30px instead of ~33px. Fix:
`liveClipBounds` now applies `applyClipMatrixOverrides(instance.matrix, child)` — the same
runtime child transform the `flatten()` render path already uses — so the reported height
reflects the moved `bottomBar`. The separator lines now land exactly on Ruffle's and the
per-row drift is gone. (The `title_txt._y = 8` itself was already honored.) This is a
general bounds-vs-render consistency fix, not a bnl-specific tweak.

A second, smaller offset remained after that: every dynamic field sat ~2px high and ~2px
left of Ruffle. Flash insets an editText field's content by a fixed **2px gutter** inside
its bounds, on all four sides; our box is derived straight from the SWF `DefineEditText`
bounds (`editTextStyle` sets `x/y = bounds.{x,y}Min/20`) and omitted it — the field's
`_height`/autoSize metrics already budgeted the gutter (`textWidth + 4`), only the drawn
position lacked it. `DomRenderer.styleText` now applies a symmetric `box-sizing:border-box`
+ `padding:2px` on the flowing-text path, which reproduces the gutter without disturbing
center/right alignment or the wrap width. Static `DefineText` (the wordmark, section
titles) carries its own per-record positions via `staticLineHtml` and is left untouched.
Subnav labels now match Ruffle's baseline (and left edge exactly); nav labels, news
headlines, and body copy are unaffected (the inset moves them onto Ruffle, not off it).

Finally, the separators stopped tracking *content amount*: a Corporate-News headline that
wraps onto three lines got the same cell as a two-line one, so its rule cut close to the
text. `liveTextMetrics` had estimated the wrapped line count as `ceil(textWidth /
wrapWidth)`, which divides total text width and ignores word boundaries — a 3-line headline
measured as 2. It now lays the text out in a cached hidden `<div>` at the renderer's content
width (box − gutter) with the embedded face and reads the real wrapped height, so the
field's `_height` — and thus `bottomBar._y` — grows with the actual line count. One subtlety:
a CSS line box adds `leading` below *every* line incl. the last, but Flash's `textHeight`
omits the trailing leading on multi-line fields, so the DOM height is one `leading` too tall
for 2+ lines; subtract it (a single-line floor leaves 1-line items untouched). The news
separators now land on Ruffle's to the pixel (`[13,53,96,138,193,235]`), the 3-line item
included, and the single-line subnav is unchanged.

## Non-negotiable

Per `AGENTS.md`: nothing scene-specific is hardcoded. The VM interprets each SWF's own
bytecode + its own XML; the same machinery must work for any data-driven AS2 SWF.
