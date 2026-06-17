// Display-list debug panel rendering for the comparison modes.

import { assetStage, debugList, debugSummary, frameScrubber, referenceFrameMeta } from "./dom";
import { state as appState } from "./state";
import { escapeHtml } from "./svgUtils";
import { isDirectRenderMode } from "./modes";
import { goToFrame } from "./frameMode";
import { frameActionsAt } from "./runtimeActions";
import type { GsapDisplayDebugEntry } from "../gsap-display-list-renderer";
import type { AssetTimeline } from "./frameModeTypes";

export function updateDebugPanel(
  assetTimeline = appState.activeAssetTimeline,
  frameIndex = Number(frameScrubber.value),
  gsapEntries?: GsapDisplayDebugEntry[],
) {
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
