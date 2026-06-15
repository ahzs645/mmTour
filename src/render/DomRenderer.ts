import { gsap } from "gsap";
import { assetUrl } from "../data/TimelineLoader";
import type { RenderNode } from "../player/types";
import { applyColorTransform } from "./colorTransform";

type RenderedNode = {
  element: HTMLDivElement;
  media: HTMLElement;
  characterId: number;
  kind: RenderNode["kind"];
  src: string;
};

export type ButtonEvent = "rollOver" | "rollOut" | "press" | "release";

export type DomRendererOptions = {
  /** Resolve a CSS font-family for a text field's font id. */
  resolveFontFamily?: (fontId?: number) => string | undefined;
  /** Dispatch a button pointer event, tagged with the owning clip's tree path. */
  onButtonEvent?: (ownerPath: string, characterId: number, event: ButtonEvent) => void;
};

/**
 * Renders the Player's flattened tree of RenderNodes into a DOM layer, diffing by
 * `key` (tree path) so unchanged instances keep their element across frames, and
 * ordering by `order` (paint/traversal order). The matrices are already composed
 * to stage space by the Player.
 */
export class DomRenderer {
  private readonly layer: HTMLElement;
  private readonly options: DomRendererOptions;
  private nodes = new Map<string, RenderedNode>();

  constructor(layer: HTMLElement, options: DomRendererOptions = {}) {
    this.layer = layer;
    this.options = options;
  }

  clear() {
    this.nodes.clear();
    this.layer.replaceChildren();
  }

  apply(renderNodes: RenderNode[]) {
    const live = new Set<string>();

    for (const node of renderNodes) {
      // Buttons render as transparent hit areas (visual lives in the baked sprite).
      if (!node.src && node.kind !== "text" && node.kind !== "button") continue;
      live.add(node.key);

      let rendered = this.nodes.get(node.key);
      if (!rendered || rendered.characterId !== node.characterId || rendered.kind !== node.kind) {
        rendered?.element.remove();
        rendered = this.createNode(node);
        this.nodes.set(node.key, rendered);
      }

      this.updateMedia(rendered, node);
      this.placeNode(rendered, node);
    }

    for (const [key, rendered] of this.nodes) {
      if (!live.has(key)) {
        rendered.element.remove();
        this.nodes.delete(key);
      }
    }
  }

  private createNode(node: RenderNode): RenderedNode {
    const element = document.createElement("div");
    element.className = "player-instance";
    element.dataset.key = node.key;
    element.dataset.character = String(node.characterId);

    const media = this.createMedia(node);
    media.classList.add("player-media");
    element.append(media);
    this.layer.append(element);

    if (node.kind === "button" && node.buttonOwnerPath !== undefined) {
      this.wireButton(media, node.buttonOwnerPath, node.characterId);
    }

    return { element, media, characterId: node.characterId, kind: node.kind, src: "" };
  }

  /** Forward pointer events on a button leaf to the Player (which resolves the action). */
  private wireButton(media: HTMLElement, ownerPath: string, characterId: number) {
    const dispatch = this.options.onButtonEvent;
    if (!dispatch) return;
    media.style.pointerEvents = "auto";
    media.style.cursor = "pointer";
    media.addEventListener("pointerenter", () => dispatch(ownerPath, characterId, "rollOver"));
    media.addEventListener("pointerleave", () => dispatch(ownerPath, characterId, "rollOut"));
    media.addEventListener("pointerdown", () => dispatch(ownerPath, characterId, "press"));
    media.addEventListener("pointerup", () => dispatch(ownerPath, characterId, "release"));
  }

  private createMedia(node: RenderNode): HTMLElement {
    if (node.kind === "text") {
      const text = document.createElement("div");
      text.className = "player-text";
      this.styleText(text, node);
      return text;
    }
    if (node.kind === "button") {
      // Transparent hit area; the button's artwork is part of the baked sprite frame.
      const hit = document.createElement("div");
      hit.className = "player-hit";
      return hit;
    }
    const image = document.createElement("img");
    image.decoding = "async";
    image.draggable = false;
    return image;
  }

  private updateMedia(rendered: RenderedNode, node: RenderNode) {
    if (rendered.kind === "text") {
      if (node.text) {
        this.styleText(rendered.media, node);
      } else if (rendered.src !== node.src && node.src) {
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
    element.style.whiteSpace = text.wordWrap ? "pre-wrap" : "pre";
    if (family) element.style.fontFamily = family;
    if (text.html) element.innerHTML = text.text ?? "";
    else element.textContent = text.text ?? "";
  }

  private placeNode(rendered: RenderedNode, node: RenderNode) {
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
      zIndex: node.order,
      opacity: node.opacity,
      transform: `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`,
    });
    applyColorTransform(rendered.media, node.colorTransform);
  }
}
