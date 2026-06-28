import { gsap } from "gsap";
import { assetUrl } from "../data/TimelineLoader";
import type { ColorTransform } from "../data/timelineTypes";
import type { MaskVisual, RenderNode } from "../player/types";
import { applyColorTransform } from "./colorTransform";

// A 1×1 fully-transparent GIF — used as the src for a button that has no artwork
// (its visual lives in the baked sprite frame) so the <img> hit area shows nothing
// instead of a broken-image box.
const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

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

function svgImage(v: MaskVisual, extra = "", dimensions: { width: number; height: number }, key: string, resolveFontFamily?: (fontId?: number) => string | undefined): string {
  if (v.maskGroup) return `<g${extra}>${maskGroupSvg(v.maskGroup, key, dimensions, resolveFontFamily)}</g>`;
  if (v.text) return svgText(v, extra, resolveFontFamily);
  const m = v.matrix;
  const url = assetUrl(v.src);
  const filter = v.colorTransform ? ` filter="url(#${maskColorFilterId(v.colorTransform)})"` : "";
  return (
    `<image href="${url}" xlink:href="${url}" x="${-v.origin.x}" y="${-v.origin.y}" ` +
    `width="${v.origin.width}" height="${v.origin.height}" ` +
    `transform="matrix(${m.a},${m.b},${m.c},${m.d},${m.tx},${m.ty})"${filter}${extra}/>`
  );
}

function svgText(v: MaskVisual, extra = "", resolveFontFamily?: (fontId?: number) => string | undefined): string {
  const text = v.text!;
  const m = v.matrix;
  const x = text.x ?? v.origin.x;
  const y = text.y ?? v.origin.y;
  const width = Math.max(1, text.width ?? v.origin.width);
  const height = Math.max(1, text.height ?? v.origin.height);
  const lineHeight = `${text.lineHeight ?? text.fontHeight + (text.leading ?? 0)}px`;
  const whiteSpace = text.wordWrap ? "pre-wrap" : "pre";
  const align = (text.align as string) ?? "left";
  const staticLines = text.staticLines?.length ? staticLineHtml(text, width) : "";
  const content = text.html
    ? flashHtmlTextToBrowserHtml(displayText(text.text ?? ""))
    : escapeHtml(displayText(text.text ?? ""));
  const style = [
    "margin:0",
    "padding:0",
    "overflow:visible",
    `width:${width}px`,
    `height:${height}px`,
    `font-size:${text.fontHeight}px`,
    `line-height:${lineHeight}`,
    `color:${text.color ?? "#000"}`,
    `text-align:${align}`,
    `white-space:${whiteSpace}`,
    // Composed (masked/clipped) text fields must use their embedded face like the
    // plain path does — otherwise e.g. the Robotics "New Robots!" badge falls back to
    // a wider system sans, overruns its field, and spills off the badge.
    `font-family:${resolveFontFamily?.(text.fontId) ?? "sans-serif"}`,
  ].join(";");
  return (
    // A Flash text field draws past its own bounds (no clip), but an SVG <foreignObject>
    // clips content to its width/height — which truncated e.g. "New Robots!" to "New Robot".
    // overflow:visible lets the text render in full; the surrounding mask clip-path still
    // bounds it to the artwork.
    `<foreignObject class="player-text player-mask-text" x="${x}" y="${y}" width="${width}" height="${height}" ` +
    `overflow="visible" style="overflow:visible" ` +
    `transform="matrix(${m.a},${m.b},${m.c},${m.d},${m.tx},${m.ty})"${extra}>` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="${style}">${staticLines || content}</div></foreignObject>`
  );
}

/** Build an inline SVG string that clips `items` to the `mask` shape's geometry. */
function maskGroupSvg(group: { mask: MaskVisual; items: MaskVisual[] }, key: string, dimensions: { width: number; height: number }, resolveFontFamily?: (fontId?: number) => string | undefined): string {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${dimensions.width}" height="${dimensions.height}" style="position:absolute;left:0;top:0;overflow:visible">`;
  const filterDefs = maskColorFilterDefs(group.items);
  const shape = loadMaskShape(group.mask.src);
  // Until the mask shape loads (or if it failed), show the items unclipped.
  if (!shape) {
    return `${open}${filterDefs ? `<defs>${filterDefs}</defs>` : ""}${group.items.map((it, index) => svgImage(it, "", dimensions, `${key}_${it.key ?? index}`, resolveFontFamily)).join("")}</svg>`;
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
  const items = group.items.map((it, index) => svgImage(it, it.opacity !== 1 ? ` opacity="${it.opacity}"` : "", dimensions, `${key}_${it.key ?? index}`, resolveFontFamily)).join("");
  return `${open}<defs>${filterDefs}<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${clipBody}</clipPath></defs><g clip-path="url(#${clipId})">${items}</g></svg>`;
}

function maskColorFilterDefs(items: MaskVisual[]): string {
  const transforms = new Map<string, ColorTransform>();
  for (const item of items) {
    if (!item.colorTransform) continue;
    transforms.set(maskColorFilterId(item.colorTransform), item.colorTransform);
  }
  return [...transforms.entries()].map(([id, ct]) => {
    const rm = ct.rm ?? 1;
    const gm = ct.gm ?? 1;
    const bm = ct.bm ?? 1;
    const ra = ct.ra ?? 0;
    const ga = ct.ga ?? 0;
    const ba = ct.ba ?? 0;
    return (
      `<filter id="${id}" color-interpolation-filters="sRGB">` +
      `<feComponentTransfer>` +
      `<feFuncR type="linear" slope="${rm}" intercept="${ra}"/>` +
      `<feFuncG type="linear" slope="${gm}" intercept="${ga}"/>` +
      `<feFuncB type="linear" slope="${bm}" intercept="${ba}"/>` +
      `</feComponentTransfer></filter>`
    );
  }).join("");
}

function maskColorFilterId(ct: ColorTransform): string {
  const values = [ct.rm ?? 1, ct.gm ?? 1, ct.bm ?? 1, ct.ra ?? 0, ct.ga ?? 0, ct.ba ?? 0];
  return `mc${values.map((value) => String(Math.round(value * 100000)).replace("-", "n")).join("_")}`;
}

type RenderedNode = {
  element: HTMLDivElement;
  media: HTMLElement;
  characterId: number;
  kind: RenderNode["kind"];
  src: string;
};

export type ButtonEvent = "rollOver" | "rollOut" | "press" | "release" | "releaseOutside";

export type DomRendererOptions = {
  /** Resolve a CSS font-family for a text field's font id. */
  resolveFontFamily?: (fontId?: number) => string | undefined;
  /** Dispatch a button pointer event, tagged with the owning clip's tree path. */
  onButtonEvent?: (ownerPath: string, characterId: number, event: ButtonEvent, buttonKey: string) => void;
  onPointerDrag?: (dx: number, dy: number) => void;
  stageDimensions?: { width: number; height: number };
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
  private hoveredButtonKeys = new Set<string>();

  constructor(layer: HTMLElement, options: DomRendererOptions = {}) {
    this.layer = layer;
    this.options = options;
  }

  clear() {
    this.nodes.clear();
    this.hoveredButtonKeys.clear();
    this.layer.replaceChildren();
  }

  apply(renderNodes: RenderNode[]) {
    renderNodes = suppressDuplicateTextNodes(renderNodes);
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
        this.hoveredButtonKeys.delete(key);
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
    rendered.element.innerHTML = maskGroupSvg(node.maskGroup!, node.key, this.options.stageDimensions ?? { width: 640, height: 480 }, this.options.resolveFontFamily);
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
      this.wireButton(media, node.buttonOwnerPath, node.characterId, node.key);
    }

    return { element, media, characterId: node.characterId, kind: node.kind, src: "" };
  }

  /** Forward pointer events on a button leaf to the Player (which resolves the action). */
  private wireButton(media: HTMLElement, ownerPath: string, characterId: number, buttonKey: string) {
    const dispatch = this.options.onButtonEvent;
    if (!dispatch) return;
    media.dataset.buttonOwnerPath = ownerPath;
    media.dataset.buttonCharacter = String(characterId);
    media.dataset.buttonKey = buttonKey;
    media.style.pointerEvents = "auto";
    media.style.cursor = "pointer";
    const rollOver = () => {
      if (this.hoveredButtonKeys.has(buttonKey)) return;
      this.hoveredButtonKeys.add(buttonKey);
      dispatch(ownerPath, characterId, "rollOver", buttonKey);
    };
    const rollOut = () => {
      if (!this.hoveredButtonKeys.delete(buttonKey)) return;
      dispatch(ownerPath, characterId, "rollOut", buttonKey);
    };
    media.addEventListener("pointerenter", rollOver);
    media.addEventListener("pointerover", rollOver);
    media.addEventListener("pointermove", rollOver);
    media.addEventListener("mouseover", rollOver);
    media.addEventListener("pointerleave", (event) => {
      const rect = media.getBoundingClientRect();
      const x = event.clientX;
      const y = event.clientY;
      const insideOriginalBounds = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      requestAnimationFrame(() => {
        const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>(".player-hit");
        const sameButton = hit?.dataset.buttonKey === buttonKey;
        if (!sameButton && !insideOriginalBounds) rollOut();
      });
    });
    media.addEventListener("mouseleave", (event) => {
      const rect = media.getBoundingClientRect();
      const x = event.clientX;
      const y = event.clientY;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) rollOut();
    });
    media.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = media.getBoundingClientRect();
      const scale = this.pointerStageScale();
      let lastX = event.clientX;
      let lastY = event.clientY;
      const insideOriginalBounds = (x: number, y: number) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      const cleanup = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", release, true);
        window.removeEventListener("pointercancel", cancel, true);
      };
      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        const dx = (moveEvent.clientX - lastX) * scale.x;
        const dy = (moveEvent.clientY - lastY) * scale.y;
        lastX = moveEvent.clientX;
        lastY = moveEvent.clientY;
        if (dx || dy) this.options.onPointerDrag?.(dx, dy);
      };
      const release = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== event.pointerId) return;
        cleanup();
        const hit = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest<HTMLElement>(".player-hit");
        const sameButton = hit?.dataset.buttonKey === buttonKey;
        if (sameButton || insideOriginalBounds(upEvent.clientX, upEvent.clientY)) {
          dispatch(ownerPath, characterId, "release", buttonKey);
        } else {
          dispatch(ownerPath, characterId, "releaseOutside", buttonKey);
        }
      };
      const cancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== event.pointerId) return;
        cleanup();
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", release, true);
      window.addEventListener("pointercancel", cancel, true);
      try {
        media.setPointerCapture(event.pointerId);
      } catch {
        // The hit node can be removed by the press animation before capture sticks.
      }
      dispatch(ownerPath, characterId, "press", buttonKey);
    });
  }

  private pointerStageScale(): { x: number; y: number } {
    const rect = this.layer.getBoundingClientRect();
    const dimensions = this.options.stageDimensions ?? { width: rect.width || 1, height: rect.height || 1 };
    return {
      x: rect.width ? dimensions.width / rect.width : 1,
      y: rect.height ? dimensions.height / rect.height : 1,
    };
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
      // sprite frame). Seed a clear pixel so a no-art button shows nothing instead of
      // a broken-image box (updateMedia's guard skips the empty→empty case).
      const hit = document.createElement("img");
      hit.className = "player-hit";
      hit.decoding = "async";
      hit.draggable = false;
      hit.src = node.src ? assetUrl(node.src) : TRANSPARENT_PIXEL;
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
      // An <img> with no src draws a broken-image box; an empty-src button (transparent
      // hit area whose visual is baked) must stay invisible, so use a 1×1 clear pixel.
      rendered.media.src = node.src ? assetUrl(node.src) : TRANSPARENT_PIXEL;
      rendered.src = node.src;
    }
  }

  private loadPlainText(element: HTMLElement, src: string) {
    void fetch(assetUrl(src))
      .then((response) => (response.ok ? response.text() : ""))
      .then((content) => {
        element.textContent = displayText(content).trim();
      });
  }

  private styleText(element: HTMLElement, node: RenderNode) {
    const text = node.text;
    if (!text) {
      // A static DefineText field carries no style metadata (it is dumped as plain text and
      // filled by loadPlainText). A SWF text field never word-wraps unless wordWrap is set, so
      // force a single line — otherwise this 0-width, absolutely-positioned box wraps at every
      // space (e.g. segment5's "Files and Folders" section title breaking to three lines).
      element.style.whiteSpace = "pre";
      return;
    }
    const family = this.options.resolveFontFamily?.(text.fontId);
    element.style.position = "absolute";
    element.style.left = `${text.x ?? node.origin.x}px`;
    element.style.top = `${text.y ?? node.origin.y}px`;
    const width = text.width ?? node.origin.width;
    if (width > 0) element.style.width = `${width}px`;
    const height = text.height ?? node.origin.height;
    if (height > 0) element.style.height = `${height}px`;
    element.style.fontSize = `${text.fontHeight}px`;
    element.style.lineHeight = `${text.lineHeight ?? text.fontHeight + (text.leading ?? 0)}px`;
    element.style.color = text.color ?? "#000";
    element.style.textAlign = (text.align as string) ?? "left";
    element.style.whiteSpace = text.wordWrap ? "pre-wrap" : "pre";
    if (family) element.style.fontFamily = family;
    if (text.staticLines?.length) {
      element.innerHTML = staticLineHtml(text, width);
      return;
    }
    if (text.html) element.innerHTML = flashHtmlTextToBrowserHtml(displayText(text.text ?? ""));
    else setPlainTextField(element, displayText(text.text ?? ""), text, width);
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

function flashHtmlTextToBrowserHtml(value: string): string {
  const template = document.createElement("template");
  // Flash's soft break is `<sbr />`, which the HTML parser treats as an unknown,
  // non-void element: it nests every following sibling *inside* the <sbr>, and the
  // serializer below then drops them. Normalize it to a real void <br> first so
  // multi-line html fields (e.g. the BnL privacy footer) keep all their lines.
  template.innerHTML = value.replace(/<sbr\b[^>]*\/?>/gi, "<br>");
  const serializeNode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent ?? "");
    if (!(node instanceof Element)) return "";
    const tag = node.tagName.toLowerCase();
    const children = [...node.childNodes].map(serializeNode).join("");
    if (tag === "sbr" || tag === "br") return "<br>";
    if (tag === "p") {
      const align = safeTextAlign(node.getAttribute("align"));
      return `<div style="margin:0${align ? `;text-align:${align}` : ""}">${children}</div>`;
    }
    if (tag === "font") {
      const style = flashFontStyle(node);
      return style ? `<span style="${style}">${children}</span>` : `<span>${children}</span>`;
    }
    if (tag === "a") {
      const href = safeHref(node.getAttribute("href"));
      return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${children}</a>` : `<span>${children}</span>`;
    }
    if (tag === "b" || tag === "strong") return `<strong>${children}</strong>`;
    if (tag === "i" || tag === "em") return `<em>${children}</em>`;
    if (tag === "u") return `<u>${children}</u>`;
    return children;
  };
  return [...template.content.childNodes].map(serializeNode).join("");
}

function displayText(value: string): string {
  return value
    .replace(/\s*--- RECORDSEPARATOR ---\s*/g, "\n")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "--- RECORDSEPARATOR ---")
    .join("\n");
}

function setPlainTextField(
  element: HTMLElement,
  value: string,
  text: { wordWrap?: boolean; multiline?: boolean; align?: string },
  width: number,
) {
  if (text.wordWrap || text.multiline || value.includes("\n") || width <= 0) {
    element.textContent = value;
    return;
  }
  const span = document.createElement("span");
  span.className = "player-text-fit";
  span.textContent = value;
  span.style.display = "inline-block";
  span.style.whiteSpace = "pre";
  span.style.transformOrigin = text.align === "right" ? "right top" : text.align === "center" ? "center top" : "left top";
  element.replaceChildren(span);
  queueTextFit(element, span, width);
}

function queueTextFit(element: HTMLElement, span: HTMLElement, width: number) {
  const fit = () => fitSingleLineText(element, span, width);
  requestAnimationFrame(fit);
  requestAnimationFrame(() => requestAnimationFrame(fit));
  document.fonts?.ready.then(fit).catch(() => {});
}

function fitSingleLineText(element: HTMLElement, span: HTMLElement, width: number) {
  if (!span.isConnected || span.parentElement !== element) return;
  span.style.transform = "";
  const naturalWidth = span.scrollWidth || span.offsetWidth || span.getBoundingClientRect().width;
  if (!Number.isFinite(naturalWidth) || naturalWidth <= 0 || naturalWidth <= width) return;
  const scale = Math.max(0.1, width / naturalWidth);
  span.style.transform = `scaleX(${scale})`;
}

function staticLineHtml(
  text: { staticLines?: Array<{ text: string; x: number; y: number; width?: number }>; fontHeight: number; color?: string; align?: string },
  fallbackWidth: number,
): string {
  const boxWidth = Math.max(1, fallbackWidth);
  return (text.staticLines ?? []).map((line) => {
    const lineWidth = Math.max(1, line.width ?? boxWidth);
    const left = text.align === "center" ? line.x + (boxWidth - lineWidth) / 2 : line.x;
    const top = line.y - text.fontHeight;
    const align = text.align ?? "left";
    return (
      `<span style="position:absolute;left:${left}px;top:${top}px;width:${lineWidth}px;` +
      `height:${text.fontHeight}px;line-height:${text.fontHeight}px;white-space:pre;` +
      `color:${text.color ?? "#000"};text-align:${align}">${escapeHtml(line.text.trimEnd())}</span>`
    );
  }).join("");
}

function suppressDuplicateTextNodes(nodes: RenderNode[]): RenderNode[] {
  const chosen = new Map<string, { node: RenderNode; area: number }>();
  const suppressed = new Set<string>();
  const replacements = new Map<string, RenderNode>();
  for (const node of nodes) {
    if (node.kind !== "text" || !node.text) continue;
    const text = normalizedNodeText(node);
    if (!text) continue;
    const width = node.text.width ?? node.origin.width;
    const height = node.text.height ?? node.origin.height;
    if (!(width > 0 && height > 0)) continue;
    const x = node.matrix.tx + (node.text.x ?? node.origin.x) + width / 2;
    const y = node.matrix.ty + (node.text.y ?? node.origin.y) + height / 2;
    const key = `${text}|${Math.round(x / 2) * 2}|${Math.round(y / 2) * 2}`;
    const area = width * height;
    const prev = chosen.get(key);
    if (!prev) {
      chosen.set(key, { node, area });
      continue;
    }
    const larger = area > prev.area * 1.1 ? { node, area } : prev;
    const smaller = larger.node === node ? prev.node : node;
    const topOrder = Math.max(prev.node.order, node.order);
    if (larger.node.order < topOrder) replacements.set(larger.node.key, { ...larger.node, order: topOrder });
    if (larger.node !== smaller) suppressed.add(smaller.key);
    chosen.set(key, larger);
  }
  if (!suppressed.size) return nodes;
  return nodes
    .filter((node) => !suppressed.has(node.key))
    .map((node) => replacements.get(node.key) ?? node);
}

function normalizedNodeText(node: RenderNode): string {
  const text = node.text;
  if (!text) return "";
  const value = text.staticLines?.length
    ? text.staticLines.map((line) => line.text.trim()).join("\n")
    : displayText(text.text ?? "");
  return value.replace(/\s+/g, " ").trim();
}

function flashFontStyle(node: Element): string {
  const styles: string[] = [];
  const color = node.getAttribute("color");
  const face = node.getAttribute("face");
  const size = Number.parseFloat(node.getAttribute("size") ?? "");
  const letterSpacing = Number.parseFloat(node.getAttribute("letterSpacing") ?? "");
  if (color && /^#[0-9a-f]{6}$/i.test(color)) styles.push(`color:${color}`);
  if (face) styles.push(`font-family:${face.split(",").map((part) => `"${part.trim().replaceAll("\"", "\\\"")}"`).join(",")}`);
  if (Number.isFinite(size) && size > 0) styles.push(`font-size:${size}px`);
  if (Number.isFinite(letterSpacing)) styles.push(`letter-spacing:${letterSpacing}px`);
  return styles.join(";");
}

function safeTextAlign(value: string | null): string {
  const align = String(value ?? "").toLowerCase();
  return align === "left" || align === "right" || align === "center" || align === "justify" ? align : "";
}

function safeHref(value: string | null): string {
  const href = String(value ?? "");
  return /^(https?:|mailto:)/i.test(href) ? href : "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
