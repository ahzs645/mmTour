import { gsap } from "gsap";
import { assetUrl } from "../data/TimelineLoader";
import type { AssetTimeline, ControlAction } from "../data/timelineTypes";
import type { RenderNode } from "../player/types";
import { applyColorTransform } from "./colorTransform";
import { installButtonOverlays } from "./ButtonOverlay";
import { namespaceSvgIds } from "./svgUtils";

type RenderedNode = {
  element: HTMLDivElement;
  media: HTMLElement;
  characterId: number;
  kind: RenderNode["kind"];
  src: string;
  /** True when this sprite is rendered as inline SVG to host button overlays. */
  interactive?: boolean;
};

export type DomRendererOptions = {
  /** Resolve a CSS font-family for a text field's font id (registered by TextRenderer). */
  resolveFontFamily?: (fontId?: number) => string | undefined;
  /** Sprite character ids that own buttons — rendered inline so hit areas can overlay. */
  interactiveSpriteIds?: Set<number>;
  /** Timeline used to resolve button state artwork + actions for overlays. */
  timeline?: AssetTimeline;
  /** Dispatch a button's release action, tagged with the owner sprite's depth. */
  dispatchButton?: (action: ControlAction, ownerDepth: number) => void;
};

// Inline SVG text is fetched once per source and reused across instances/frames.
const svgTextCache = new Map<string, Promise<string>>();

function fetchSvgText(src: string): Promise<string> {
  let pending = svgTextCache.get(src);
  if (!pending) {
    pending = fetch(assetUrl(src))
      .then((response) => (response.ok ? response.text() : ""))
      .then((text) => text.replace(/<\?xml[^>]*>\s*/i, ""));
    svgTextCache.set(src, pending);
  }
  return pending;
}

/**
 * Renders a list of RenderNodes into a DOM layer, diffing by depth so unchanged
 * instances keep their element (and its image decode) across frames. This is
 * the "stage view" of the decompiled player.
 */
export class DomRenderer {
  private readonly layer: HTMLElement;
  private readonly options: DomRendererOptions;
  private nodes = new Map<number, RenderedNode>();

  constructor(layer: HTMLElement, options: DomRendererOptions = {}) {
    this.layer = layer;
    this.options = options;
  }

  clear() {
    this.nodes.clear();
    this.layer.replaceChildren();
  }

  apply(renderNodes: RenderNode[]) {
    const liveDepths = new Set<number>();

    for (const node of renderNodes) {
      if (!node.src && node.kind !== "text") continue;
      liveDepths.add(node.depth);

      let rendered = this.nodes.get(node.depth);
      if (!rendered || rendered.characterId !== node.characterId || rendered.kind !== node.kind) {
        rendered?.element.remove();
        rendered = this.createNode(node);
        this.nodes.set(node.depth, rendered);
      }

      this.updateMedia(rendered, node);
      this.placeNode(rendered, node);
    }

    for (const [depth, rendered] of this.nodes) {
      if (!liveDepths.has(depth)) {
        rendered.element.remove();
        this.nodes.delete(depth);
      }
    }
  }

  private createNode(node: RenderNode): RenderedNode {
    const element = document.createElement("div");
    element.className = "player-instance";
    element.dataset.depth = String(node.depth);
    element.dataset.character = String(node.characterId);
    element.dataset.name = node.name;

    const media = this.createMedia(node);
    media.classList.add("player-media");
    element.append(media);
    this.layer.append(element);

    return { element, media, characterId: node.characterId, kind: node.kind, src: "" };
  }

  private isInteractiveSprite(node: RenderNode): boolean {
    return node.kind === "sprite" && Boolean(this.options.interactiveSpriteIds?.has(node.characterId));
  }

  private createMedia(node: RenderNode): HTMLElement {
    if (node.kind === "text") {
      const text = document.createElement("div");
      text.className = "player-text";
      this.styleText(text, node);
      return text;
    }

    if (this.isInteractiveSprite(node)) {
      const container = document.createElement("div");
      container.className = "player-sprite-inline";
      return container;
    }

    const image = document.createElement("img");
    image.decoding = "async";
    image.draggable = false;
    return image;
  }

  private updateMedia(rendered: RenderedNode, node: RenderNode) {
    if (this.isInteractiveSprite(node)) {
      if (rendered.src !== node.src && node.src) {
        rendered.src = node.src;
        this.injectInteractiveSprite(rendered.media, node);
      }
      return;
    }

    if (rendered.kind === "text") {
      if (node.text) {
        this.styleText(rendered.media, node);
      } else if (rendered.src !== node.src && node.src) {
        // Static text with no style metadata: load the plain extracted text.
        this.loadPlainText(rendered.media, node.src);
      }
      rendered.src = node.src;
      return;
    }
    if (rendered.src !== node.src && rendered.media instanceof HTMLImageElement) {
      rendered.media.src = assetUrl(node.src);
      rendered.src = node.src;
    }
  }

  private loadPlainText(element: HTMLElement, src: string) {
    void fetch(assetUrl(src))
      .then((response) => (response.ok ? response.text() : ""))
      .then((content) => {
        element.textContent = content.trim();
      });
  }

  private injectInteractiveSprite(container: HTMLElement, node: RenderNode) {
    const src = node.src;
    const depth = node.depth;
    container.dataset.pendingSrc = src;
    void fetchSvgText(src).then((svgText) => {
      // A newer frame may have superseded this injection.
      if (container.dataset.pendingSrc !== src || !svgText) return;
      // Namespace ids per depth so the 3 inline icon SVGs don't collide.
      container.innerHTML = namespaceSvgIds(svgText, `d${depth}_`);
      const svg = container.querySelector("svg");
      if (!svg) return;
      // Native px sizing (FFDec sprite SVGs have no viewBox); just stop overlays
      // outside the bounds from being clipped.
      svg.style.overflow = "visible";
      const { timeline, dispatchButton } = this.options;
      if (timeline && dispatchButton) {
        installButtonOverlays(svg as SVGSVGElement, timeline, (action) => dispatchButton(action, depth));
      }
    });
  }

  private styleText(element: HTMLElement, node: RenderNode) {
    const text = node.text;
    if (!text) return;
    const family = this.options.resolveFontFamily?.(text.fontId);
    element.style.position = "absolute";
    element.style.left = `${text.x ?? node.origin.x}px`;
    element.style.top = `${text.y ?? node.origin.y}px`;
    const width = text.width ?? node.origin.width;
    if (width > 0) element.style.width = `${width}px`;
    element.style.fontSize = `${text.fontHeight}px`;
    element.style.lineHeight = text.leading ? `${text.fontHeight + text.leading}px` : "normal";
    element.style.color = text.color ?? "#000";
    element.style.textAlign = (text.align as string) ?? "left";
    // pre-wrap honors authored newlines while still wrapping at the field width.
    element.style.whiteSpace = text.wordWrap ? "pre-wrap" : "pre";
    if (family) element.style.fontFamily = family;
    if (text.html) {
      element.innerHTML = text.text ?? "";
    } else {
      element.textContent = text.text ?? "";
    }
  }

  private placeNode(rendered: RenderedNode, node: RenderNode) {
    // Text positions itself in stage space; graphics use the symbol's origin box.
    if (rendered.kind !== "text") {
      gsap.set(rendered.media, {
        position: "absolute",
        left: -node.origin.x,
        top: -node.origin.y,
        width: node.origin.width || "auto",
        height: node.origin.height || "auto",
      });
    }

    const { a, b, c, d, tx, ty } = node.matrix;
    gsap.set(rendered.element, {
      zIndex: node.depth,
      opacity: node.opacity,
      transform: `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`,
    });
    applyColorTransform(rendered.media, node.colorTransform);
  }
}
