// Display-list debug panel rendering for the comparison modes.

import {
  assetStage, debugList, debugSummary, frameScrubber, liveDetail, liveFilters, liveFreeze, liveHideEmpty,
  liveKind, liveLevelChips, liveSearch, playerLayer, referenceFrameMeta, renderModeSelect, select,
  traceBar, traceClear, traceCopy, traceRecord, traceStatus,
} from "./dom";
import { playerController, state as appState } from "./state";
import { escapeHtml } from "./svgUtils";
import { isDirectRenderMode } from "./modes";
import { goToFrame } from "./frameMode";
import { frameActionsAt } from "./runtimeActions";
import type { GsapDisplayDebugEntry } from "../gsap-display-list-renderer";
import type { AssetTimeline } from "./frameModeTypes";

/** Single source of truth for the auxiliary debug bars: each shows only on its own tab. Called by
 *  every render path so the bars stay correct regardless of which (possibly stale) caller triggered
 *  the render — the Live filters/sidebar on "live", the Trace recorder bar on "trace", else hidden. */
function syncDebugBars() {
  const tab = appState.activeDebugTab;
  liveFilters.hidden = tab !== "live";
  liveDetail.hidden = tab !== "live";
  traceBar.hidden = tab !== "trace";
}

export function updateDebugPanel(
  assetTimeline = appState.activeAssetTimeline,
  frameIndex = Number(frameScrubber.value),
  gsapEntries?: GsapDisplayDebugEntry[],
) {
  syncDebugBars();
  // "Live" / "Trace" inspect the live player, not the frame-SVG timeline — handle them first.
  if (appState.activeDebugTab === "live") { renderLiveDebug(); return; }
  if (appState.activeDebugTab === "trace") { renderTraceDebug(); return; }

  if (!assetTimeline) {
    debugSummary.textContent = "";
    debugList.replaceChildren();
    return;
  }

  const frame = assetTimeline.frames[frameIndex];
  const entries = gsapEntries ?? debugEntriesForFrame(assetTimeline, frameIndex);
  debugSummary.textContent = `${entries.length} items`;

  if (appState.activeDebugTab === "labels") {
    renderLabelDebug(assetTimeline, frameIndex);
  } else if (appState.activeDebugTab === "actions") {
    renderActionDebug(assetTimeline, frameIndex);
  } else {
    renderStageDebug(assetTimeline, entries);
  }

  referenceFrameMeta.textContent = `Frame ${frameIndex}${frame?.label ? ` - ${frame.label}` : ""}`;
  applyDepthHighlight();
}

export function debugEntriesForFrame(assetTimeline: AssetTimeline, frameIndex: number): GsapDisplayDebugEntry[] {
  const frame = assetTimeline.frames[frameIndex];
  if (!frame) return [];

  const masks = frame.instances.filter((instance) => instance.clipDepth !== undefined);
  return frame.instances.map((instance) => {
    const asset = assetTimeline.assets[String(instance.characterId)];
    const spriteFrame = asset?.kind === "sprite" && asset.frames?.length
      ? Math.max(0, frame.index - instance.placedFrame) % asset.frames.length
      : undefined;
    const clippingMask = masks.find((mask) => instance.depth > mask.depth && instance.depth <= mask.clipDepth!);
    return {
      depth: instance.depth,
      characterId: instance.characterId,
      kind: asset?.kind ?? "shape",
      name: instance.name,
      placedFrame: instance.placedFrame,
      spriteFrame,
      clipDepth: instance.clipDepth,
      isMask: Boolean(instance.clipDepth),
      clippedBy: clippingMask?.depth,
      opacity: instance.opacity,
      src: asset?.src ?? asset?.frames?.[spriteFrame ?? 0] ?? "",
    };
  });
}

export function renderStageDebug(assetTimeline: AssetTimeline | null, entries: GsapDisplayDebugEntry[]) {
  debugList.replaceChildren();
  if (!entries.length) {
    debugList.append(emptyDebugMessage("No display-list entries on this frame."));
    return;
  }

  for (const entry of entries.sort((a, b) => a.depth - b.depth)) {
    const button = document.createElement("button");
    button.className = "debug-item";
    button.type = "button";
    button.classList.toggle("is-highlighted", appState.highlightedDepth === entry.depth);
    button.classList.toggle("is-mask", entry.isMask);
    button.classList.toggle("is-clipped", entry.clippedBy !== undefined);
    button.innerHTML = `
      <span class="debug-depth">${entry.depth}</span>
      <span class="debug-main">
        <strong>${entry.kind} ${entry.characterId}</strong>
        <small>${[
          entry.name ? `name: ${escapeHtml(entry.name)}` : "",
          entry.spriteFrame !== undefined ? `sprite frame: ${entry.spriteFrame}` : "",
          entry.clippedBy !== undefined ? `clipped by depth ${entry.clippedBy}` : "",
          entry.clipDepth !== undefined ? `masks to ${entry.clipDepth}` : "",
        ].filter(Boolean).join(" | ") || "root display object"}</small>
      </span>
      <span class="debug-opacity">${Math.round(entry.opacity * 100)}%</span>
    `;
    button.addEventListener("click", () => {
      appState.highlightedDepth = appState.highlightedDepth === entry.depth ? null : entry.depth;
      applyDepthHighlight();
      renderStageDebug(assetTimeline, entries);
    });
    debugList.append(button);
  }
}

export function renderLabelDebug(assetTimeline: AssetTimeline, frameIndex: number) {
  debugList.replaceChildren();
  const labels = Object.entries(assetTimeline.labels ?? {}).sort((a, b) => a[1] - b[1]);
  if (!labels.length) {
    debugList.append(emptyDebugMessage("No labels were extracted for this scene."));
    return;
  }

  for (const [label, frame] of labels) {
    const button = document.createElement("button");
    button.className = "debug-item debug-label-item";
    button.type = "button";
    button.classList.toggle("is-highlighted", frame === frameIndex);
    button.innerHTML = `
      <span class="debug-depth">${frame}</span>
      <span class="debug-main"><strong>${escapeHtml(label)}</strong><small>${frame === frameIndex ? "current frame" : "click to seek"}</small></span>
    `;
    button.addEventListener("click", () => goToFrame(frame, false));
    debugList.append(button);
  }
}

export function renderActionDebug(assetTimeline: AssetTimeline, frameIndex: number) {
  debugList.replaceChildren();
  const rootActions = frameActionsAt(assetTimeline, frameIndex);
  const exactFrameRootActions = assetTimeline.control?.frameActions
    ?.filter((entry) => entry.frame === frameIndex)
    .flatMap((entry) => entry.actions) ?? [];
  const functionScopedActions = exactFrameRootActions.filter((action) => action.executionContext === "function" || action.functionName);
  const branchScopedActions = exactFrameRootActions.filter((action) => action.executionContext === "branch" || action.branchCondition || action.functionBranchCondition);
  const spriteActionCount = assetTimeline.control?.spriteActions
    ?.filter((entry) => entry.frame === frameIndex)
    .flatMap((entry) => entry.actions).length ?? 0;

  const rows = [
    ...rootActions.map((action) => ({
      title: action.command ?? action.functionName ?? "action",
      detail: action.source,
      supported: action.supported,
    })),
    ...(isDirectRenderMode() && functionScopedActions.length
      ? [{ title: "function-scope actions", detail: `${functionScopedActions.length} extracted function action(s) reference this frame`, supported: true }]
      : []),
    ...(isDirectRenderMode() && branchScopedActions.length
      ? [{ title: "branch-scope actions", detail: `${branchScopedActions.length} extracted branch action(s) reference this frame`, supported: true }]
      : []),
    ...(spriteActionCount ? [{ title: "sprite actions", detail: `${spriteActionCount} sprite-frame actions share this local frame number`, supported: true }] : []),
  ];

  if (!rows.length) {
    debugList.append(emptyDebugMessage("No root frame actions at this frame."));
    return;
  }

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "debug-item debug-action-item";
    item.innerHTML = `
      <span class="debug-depth">${row.supported === false ? "!" : "ok"}</span>
      <span class="debug-main"><strong>${escapeHtml(String(row.title))}</strong><small>${escapeHtml(row.detail ?? "")}</small></span>
    `;
    debugList.append(item);
  }
}

export function emptyDebugMessage(message: string) {
  const element = document.createElement("div");
  element.className = "debug-empty";
  element.textContent = message;
  return element;
}

export function applyDepthHighlight() {
  assetStage.querySelectorAll(".depth-highlight").forEach((node) => node.classList.remove("depth-highlight"));
  if (appState.highlightedDepth === null) return;
  assetStage.querySelectorAll<HTMLElement>(`[data-depth="${appState.highlightedDepth}"]`).forEach((node) => {
    node.classList.add("depth-highlight");
  });
}

// --- Live player-DOM inspector --------------------------------------------
// The Decompiled Player renders to live DOM across stacked `_levelN` layers, which the
// frame-SVG views above never capture. This view enumerates the live nodes in PAINT ORDER
// (Flash level first, then z within the level) and, for a selected node, reports exactly
// what is painted ON TOP of it (overlapping + higher in paint order) — e.g. a `_level6` nav
// bar over a `_level4` segment title. Occlusion is geometric (rect overlap + paint order),
// not `elementFromPoint`, so `pointer-events:none` text/art is still detected.

type LiveNode = {
  el: HTMLElement; level: number; z: number; key: string; char: string;
  kind: string; isHit: boolean; fullStage: boolean; text: string;
  x: number; y: number; w: number; h: number; opacity: number; visible: boolean;
};

function collectLiveNodes(): LiveNode[] {
  const stage = assetStage.getBoundingClientRect();
  return [...playerLayer.querySelectorAll<HTMLElement>(".player-instance")].map((el) => {
    const levelEl = el.closest<HTMLElement>(".player-level");
    const media = el.querySelector<HTMLElement>(".player-media") ?? (el.firstElementChild as HTMLElement | null);
    const isHit = Boolean(media?.classList.contains("player-hit"));
    const isText = Boolean(media?.classList.contains("player-text"));
    const hasImg = media?.tagName === "IMG" || Boolean(media?.querySelector("img"));
    const kind = isText ? "text" : isHit ? "hit" : hasImg ? "img" : el.innerHTML.includes("<svg") ? "svg" : "node";
    // Measure the media child: the `.player-instance` wrapper has no intrinsic size (the visual
    // box lives on its child), and the child's rect already reflects the wrapper's transform.
    const r = (media ?? el).getBoundingClientRect();
    const cs = getComputedStyle(el);
    const opacity = Number(cs.opacity);
    return {
      el, level: Number(levelEl?.style.zIndex ?? "0"), z: Number(el.style.zIndex || "0"),
      key: el.dataset.key ?? "", char: el.dataset.character ?? "?",
      kind, isHit,
      // A node whose box spans (nearly) the whole stage is almost always a transparent overlay
      // (the SVG draws only a few shapes), so it overlaps everything geometrically without
      // visually covering it — flag it so it doesn't read as a real occluder.
      fullStage: r.width >= stage.width * 0.95 && r.height >= stage.height * 0.95,
      text: isText ? (el.textContent ?? "").trim() : "",
      x: Math.round(r.left - stage.left), y: Math.round(r.top - stage.top),
      w: Math.round(r.width), h: Math.round(r.height),
      opacity, visible: cs.visibility !== "hidden" && opacity > 0,
    };
  });
}

const paintOrder = (n: LiveNode) => n.level * 1e6 + n.z; // level dominates, then z within a level
const overlaps = (a: LiveNode, b: LiveNode) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function occludersOf(target: LiveNode, all: LiveNode[]): LiveNode[] {
  if (!target.w || !target.h) return [];
  return all
    .filter((n) => n !== target && n.visible && paintOrder(n) > paintOrder(target) && overlaps(target, n))
    .sort((a, b) => paintOrder(a) - paintOrder(b));
}

export function clearLiveHighlights() {
  playerLayer.querySelectorAll<HTMLElement>(".player-instance").forEach((e) => { e.style.outline = ""; e.style.outlineOffset = ""; });
}

const liveLabel = (n: LiveNode) => n.text ? `text "${escapeHtml(n.text.slice(0, 28))}"` : `${n.kind} ${escapeHtml(n.char)}`;

// Live-view filter state (persisted across the throttled re-renders). Occlusion is always
// computed against the FULL node set, so hiding noise here never hides a real occluder.
const liveFilter = { search: "", kind: "", hideEmpty: true, level: null as number | null };
let liveFiltersWired = false;
// The auto-refresh rebuilds the list, which steals clicks. Pause it whenever the pointer is over
// the panel (so it freezes exactly when you reach in to click) and/or when "freeze" is ticked.
let livePointerInside = false;

/** Attach the filter-bar + freeze/hover listeners once (the inputs live in the app shell). */
export function initLiveFilters() {
  if (liveFiltersWired) return;
  liveFiltersWired = true;
  liveSearch.addEventListener("input", () => { liveFilter.search = liveSearch.value.trim().toLowerCase(); renderLiveDebug(); });
  liveKind.addEventListener("change", () => { liveFilter.kind = liveKind.value; renderLiveDebug(); });
  liveHideEmpty.addEventListener("change", () => { liveFilter.hideEmpty = liveHideEmpty.checked; renderLiveDebug(); });
  liveFreeze.addEventListener("change", () => { if (!liveFreeze.checked) renderLiveDebug(); }); // refresh on un-freeze
  const panel = liveSearch.closest<HTMLElement>(".debug-panel");
  panel?.addEventListener("pointerenter", () => { livePointerInside = true; });
  panel?.addEventListener("pointerleave", () => { livePointerInside = false; });
}

function renderLevelChips(levels: number[]) {
  liveLevelChips.replaceChildren();
  const chip = (label: string, level: number | null) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "live-chip";
    b.classList.toggle("is-active", liveFilter.level === level);
    b.textContent = label;
    b.addEventListener("click", () => { liveFilter.level = liveFilter.level === level ? null : level; renderLiveDebug(); });
    return b;
  };
  liveLevelChips.append(chip("all", null), ...levels.map((l) => chip(`L${l}`, l)));
}

function passesFilter(n: LiveNode): boolean {
  if (n.key === appState.selectedLiveKey) return true; // never hide the inspected node
  if (liveFilter.hideEmpty && (!n.w || !n.h)) return false;
  if (liveFilter.level !== null && n.level !== liveFilter.level) return false;
  if (liveFilter.kind && n.kind !== liveFilter.kind) return false;
  if (liveFilter.search && !n.char.toLowerCase().includes(liveFilter.search) && !n.text.toLowerCase().includes(liveFilter.search)) return false;
  return true;
}

export function renderLiveDebug() {
  syncDebugBars(); // robust against a stale main.ts handler
  const prevScroll = debugList.scrollTop;
  const all = collectLiveNodes();
  clearLiveHighlights();
  debugList.replaceChildren();

  const selected = all.find((n) => n.key === appState.selectedLiveKey) ?? null;
  if (selected) { selected.el.style.outline = "2px solid #ff2bd6"; selected.el.style.outlineOffset = "1px"; }
  renderLiveDetail(selected, all);

  if (!all.length) {
    debugSummary.textContent = "";
    liveLevelChips.replaceChildren();
    debugList.append(emptyDebugMessage("No live player nodes. Set render mode to Decompiled Player and reach a state (pause to inspect a moving scene)."));
    return;
  }

  const levels = [...new Set(all.map((n) => n.level))].sort((a, b) => a - b);
  renderLevelChips(levels);
  const nodes = all.filter(passesFilter).sort((a, b) => paintOrder(a) - paintOrder(b));
  debugSummary.textContent = nodes.length === all.length
    ? `${all.length} live nodes · levels ${levels.join(", ")}`
    : `${nodes.length} of ${all.length} nodes`;

  if (!nodes.length) {
    debugList.append(emptyDebugMessage("No nodes match the current filter."));
    debugList.scrollTop = prevScroll;
    return;
  }

  for (const node of nodes) {
    const button = document.createElement("button");
    button.className = "debug-item";
    button.type = "button";
    button.classList.toggle("is-highlighted", node.key === appState.selectedLiveKey);
    button.innerHTML = `
      <span class="debug-depth">L${node.level}</span>
      <span class="debug-main">
        <strong>${liveLabel(node)}</strong>
        <small>z${node.z} · ${node.x},${node.y} · ${node.w}×${node.h}${node.visible ? "" : " · HIDDEN"}</small>
      </span>
      <span class="debug-opacity">${Math.round(node.opacity * 100)}%</span>
    `;
    button.addEventListener("click", () => {
      appState.selectedLiveKey = appState.selectedLiveKey === node.key ? null : node.key;
      renderLiveDebug();
    });
    debugList.append(button);
  }
  debugList.scrollTop = prevScroll;
}

/** Render the occlusion readout for the selected node into the sidebar. */
function renderLiveDetail(selected: LiveNode | null, all: LiveNode[]) {
  liveDetail.replaceChildren();
  if (!selected) {
    const hint = document.createElement("p");
    hint.className = "live-hint";
    hint.textContent = "Select a node to see what's painted over it (and outline it on the stage).";
    liveDetail.append(hint);
    return;
  }

  const title = document.createElement("div");
  title.className = "live-detail-title";
  title.innerHTML = `<strong>${liveLabel(selected)}</strong>`;
  const sub = document.createElement("div");
  sub.className = "live-detail-sub";
  sub.textContent = `L${selected.level} · z${selected.z} · ${selected.x},${selected.y} · ${selected.w}×${selected.h} · ${Math.round(selected.opacity * 100)}%`;
  liveDetail.append(title, sub);

  const occ = occludersOf(selected, all); // vs the FULL set — filters never hide a real occluder
  const solid = occ.filter((o) => !o.isHit && !o.fullStage);
  const heading = document.createElement("div");
  heading.innerHTML = occ.length
    ? `<strong>${solid.length} likely-solid node(s) over this box</strong> (of ${occ.length} overlapping &amp; higher in paint order)`
      + (solid.length
        ? `<br><em>covered by: ${solid.map((o) => `L${o.level} ${o.kind} ${escapeHtml(o.char)}`).join(", ")}</em>`
        : `<br><em>only hit areas / full-stage overlays — nothing solid covers it, so if it's invisible suspect position/color, not occlusion.</em>`)
    : `<strong>Topmost here</strong> — nothing in the player paints over this node's box.`;
  liveDetail.append(heading);

  if (occ.length) {
    const list = document.createElement("div");
    list.className = "live-occ";
    for (const o of occ) {
      const row = document.createElement("div");
      row.className = "live-occ-row";
      const isSolid = !o.isHit && !o.fullStage;
      row.classList.toggle("is-solid", isSolid);
      const note = o.isHit ? " · hit (transparent)" : o.fullStage ? " · full-stage overlay" : "";
      row.innerHTML = `L${o.level} z${o.z} · ${o.kind} ${escapeHtml(o.text ? `"${o.text.slice(0, 22)}"` : o.char)}${note} · ${Math.round(o.opacity * 100)}%`;
      list.append(row);
    }
    liveDetail.append(list);
  }
}

// Keep the Live view fresh while the player is playing (throttled). It freezes when paused, when
// the "freeze" flag is set, or while the pointer is over the panel — so the list stays clickable
// (a rebuild mid-click is what made it impossible to select anything).
let liveRaf = 0;
let lastLiveRender = 0;
export function startLiveDebugLoop() {
  cancelAnimationFrame(liveRaf);
  const tick = (t: number) => {
    if (appState.activeDebugTab !== "live") { clearLiveHighlights(); return; }
    const frozen = liveFreeze.checked || livePointerInside;
    if (playerController.isPlaying && !frozen && t - lastLiveRender > 150) { lastLiveRender = t; renderLiveDebug(); }
    liveRaf = requestAnimationFrame(tick);
  };
  liveRaf = requestAnimationFrame(tick);
}

// --- Trace recorder: capture the click path through the player so it can be replayed ----------
// Each click on a player hit area is logged with timing + stage-relative position + the node's
// character/level, plus the starting scene/mode — so the exact path to a state (which has been the
// hard part to reproduce, e.g. the segment-viewing state where the nav bar covers the title) can be
// exported as JSON and replayed verbatim.
type TraceStep = { t: number; relX: number; relY: number; char: string; level: number; label: string; hit: boolean };
let tracing = false;
let traceStart = 0;
let traceWired = false;
const traceSteps: TraceStep[] = [];

const traceSummary = () => (tracing ? `recording… ${traceSteps.length} clicks` : `${traceSteps.length} clicks`);

/** Wire the recorder once: a capture-phase pointerdown logger + the control buttons. */
export function initTrace() {
  if (traceWired) return;
  traceWired = true;
  // Capture phase on the STAGE (not playerLayer — it's pointer-events:none, so empty-space clicks
  // pass through it) so we log every click on the player surface, hit area or not.
  assetStage.addEventListener("pointerdown", (e) => {
    if (!tracing) return;
    const stage = assetStage.getBoundingClientRect();
    const target = e.target as HTMLElement;
    const inst = target.closest<HTMLElement>(".player-instance");
    traceSteps.push({
      t: Math.round(performance.now() - traceStart),
      relX: Number(((e.clientX - stage.left) / stage.width).toFixed(4)),
      relY: Number(((e.clientY - stage.top) / stage.height).toFixed(4)),
      char: inst?.dataset.character ?? "-",
      level: Number(inst?.closest<HTMLElement>(".player-level")?.style.zIndex ?? -1),
      label: (inst?.textContent ?? "").trim().slice(0, 30),
      hit: Boolean(target.closest(".player-hit")),
    });
    if (appState.activeDebugTab === "trace") renderTraceDebug();
  }, true);

  traceRecord.addEventListener("click", () => {
    tracing = !tracing;
    if (tracing) { traceStart = performance.now(); traceSteps.length = 0; }
    renderTraceDebug();
  });
  traceClear.addEventListener("click", () => { traceSteps.length = 0; renderTraceDebug(); });
  traceCopy.addEventListener("click", () => {
    const json = JSON.stringify({
      scene: select.value,
      sceneLabel: (select.selectedOptions[0]?.textContent ?? "").trim(),
      renderMode: renderModeSelect.value,
      steps: traceSteps,
    }, null, 2);
    void navigator.clipboard?.writeText(json).then(() => {
      traceStatus.textContent = "copied ✓";
      setTimeout(() => { traceStatus.textContent = traceSummary(); }, 1200);
    });
  });
}

export function renderTraceDebug() {
  // Self-contained: wire the controls and own the bar visibility here, so the Trace tab works even
  // if main.ts's tab handler is stale (a partial HMR leaves the bar hidden otherwise).
  initTrace();
  syncDebugBars();
  traceRecord.classList.toggle("is-recording", tracing);
  traceRecord.textContent = tracing ? "■ Stop" : "● Record";
  traceStatus.textContent = traceSummary();
  debugSummary.textContent = traceSummary();
  debugList.replaceChildren();
  if (!traceSteps.length) {
    debugList.append(emptyDebugMessage("Press ● Record, then click through the player. Each click logs time + position + the node's char/level. Copy JSON to share the exact path."));
    return;
  }
  traceSteps.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "debug-item";
    row.innerHTML = `
      <span class="debug-depth">${i + 1}</span>
      <span class="debug-main">
        <strong>${s.hit ? `char ${escapeHtml(s.char)}` : "(empty space)"}${s.label ? ` "${escapeHtml(s.label)}"` : ""}</strong>
        <small>${s.t} ms · L${s.level} · ${(s.relX * 100).toFixed(1)}%, ${(s.relY * 100).toFixed(1)}%</small>
      </span>
    `;
    debugList.append(row);
  });
}
