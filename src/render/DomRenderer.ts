import { gsap } from "gsap";
import { assetUrl } from "../data/TimelineLoader";
import type { MaskVisual, RenderNode } from "../player/types";
import { applyColorTransform } from "./colorTransform";

// Mask shapes are inlined into the <mask> (Chrome won't rasterize an <image>-
// referenced SVG inside a mask). Their fills are forced white → a robust
// Mask shapes are inlined into the <clipPath>. CRITICAL: Chrome ignores nested
// <g transform> inside a clipPath, so we strip the FFDec shape's root <g matrix>,
// capture that matrix, and bake every transform into a SINGLE matrix on the path.
type ParsedShape = { gMatrix: Matrix; body: string };
const maskShapeCache = new Map<string, ParsedShape | null>();
const maskShapeLoading = new Set<string>();

type Matrix = { a: number; b: number; c: number; d: number; tx: number; ty: number };
const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function matMul(p: Matrix, c: Matrix): Matrix {
  return {
    a: p.a * c.a + p.c * c.b,
    b: p.b * c.a + p.d * c.b,
    c: p.a * c.c + p.c * c.d,
    d: p.b * c.c + p.d * c.d,
    tx: p.a * c.tx + p.c * c.ty + p.tx,
    ty: p.b * c.tx + p.d * c.ty + p.ty,
  };
}

function loadMaskShape(src: string): ParsedShape | null | undefined {
  if (maskShapeCache.has(src)) return maskShapeCache.get(src);
  if (!maskShapeLoading.has(src)) {
    maskShapeLoading.add(src);
    void fetch(assetUrl(src))
      .then((response) => (response.ok ? response.text() : ""))
      .then((text) => {
        const inner = text.replace(/<\?xml[^>]*\?>/i, "").replace(/<svg[^>]*>/i, "").replace(/<\/svg>\s*$/i, "");
        // Pull off the shape's root <g transform="matrix(...)"> wrapper.
        const g = inner.match(/<g\s+transform="matrix\(([^)]+)\)"\s*>([\s\S]*)<\/g>\s*$/i);
        let gMatrix = IDENTITY;
        let body = inner;
        if (g) {
          const n = g[1].split(/[\s,]+/).map(Number);
          if (n.length === 6 && n.every(Number.isFinite)) gMatrix = { a: n[0], b: n[1], c: n[2], d: n[3], tx: n[4], ty: n[5] };
          body = g[2];
        }
        // Force fills so the path defines a clip region (color is irrelevant for clipPath).
        body = body.replace(/fill="[^"]*"/g, 'fill="#ffffff"').replace(/stroke="[^"]*"/g, 'stroke="none"');
        maskShapeCache.set(src, { gMatrix, body });
      })
      .catch(() => maskShapeCache.set(src, null));
  }
  return undefined;
}

function svgImage(v: MaskVisual, extra = ""): string {
  const m = v.matrix;
  const url = assetUrl(v.src);
  return (
    `<image href="${url}" xlink:href="${url}" x="${-v.origin.x}" y="${-v.origin.y}" ` +
    `width="${v.origin.width}" height="${v.origin.height}" ` +
    `transform="matrix(${m.a},${m.b},${m.c},${m.d},${m.tx},${m.ty})"${extra}/>`
  );
}

/** Build an inline SVG string that clips `items` to the `mask` shape's geometry. */
function maskGroupSvg(group: { mask: MaskVisual; items: MaskVisual[] }, key: string): string {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="640" height="480" style="position:absolute;left:0;top:0;overflow:visible">`;
  const shape = loadMaskShape(group.mask.src);
  // Until the mask shape loads (or if it failed), show the items unclipped.
  if (!shape) {
    return `${open}${group.items.map((it) => svgImage(it)).join("")}</svg>`;
  }

  // Bake mask-matrix ∘ origin-shift ∘ shape-g into ONE matrix on a single <g>, so the
  // clipPath has no nested <g transform> (which Chrome silently ignores).
  const m = group.mask.matrix;
  const o = group.mask.origin;
  const combined = matMul(matMul(m, { a: 1, b: 0, c: 0, d: 1, tx: -o.x, ty: -o.y }), shape.gMatrix);
  const clipId = `c${key.replace(/\W/g, "_")}`;
  // Chrome ignores transforms on a <g> inside a clipPath, so bake the matrix onto each
  // <path>/<polygon> directly (the only reliable form).
  const tf = `matrix(${combined.a},${combined.b},${combined.c},${combined.d},${combined.tx},${combined.ty})`;
  const clipBody = shape.body.replace(/<(path|polygon|rect|ellipse|circle)\b/g, `<$1 transform="${tf}"`);
  const items = group.items.map((it) => svgImage(it, it.opacity !== 1 ? ` opacity="${it.opacity}"` : "")).join("");
  return `${open}<defs><clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${clipBody}</clipPath></defs><g clip-path="url(#${clipId})">${items}</g></svg>`;
}

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
      if (node.maskGroup) {
        live.add(node.key);
        this.applyMaskGroup(node);
        continue;
      }
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

  /**
   * Render a mask group: an inline SVG that alpha-masks the clipped items to the
   * mask shape (SWF clipDepth). Rebuilt each frame — groups are small. All
   * matrices are already in stage space, so the SVG sits at the stage origin.
   */
  private applyMaskGroup(node: RenderNode) {
    let rendered = this.nodes.get(node.key);
    if (!rendered) {
      const element = document.createElement("div");
      element.className = "player-instance";
      this.layer.append(element);
      rendered = { element, media: element, characterId: -1, kind: node.kind, src: "" };
      this.nodes.set(node.key, rendered);
    }
    rendered.element.style.zIndex = String(node.order);
    rendered.element.style.transform = "none";
    rendered.element.innerHTML = maskGroupSvg(node.maskGroup!, node.key);
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
      // The button is its own hit area; it shows its up-state artwork when one was
      // provided (tree path) and is otherwise transparent (visual lives in the baked
      // sprite frame). An <img> with no src renders nothing but still sizes/hits.
      const hit = document.createElement("img");
      hit.className = "player-hit";
      hit.decoding = "async";
      hit.draggable = false;
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
      if (node.src) rendered.media.src = assetUrl(node.src);
      else rendered.media.removeAttribute("src"); // transparent hit area (visual is baked)
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
