import gsap from 'gsap';
import type { TimelineData, Transform, ColorTransform, FrameData, CharacterData } from '../types';

export interface DisplayEntry {
  characterId: string;
  transform: Transform;
  colorTransform?: ColorTransform;
  clipDepth?: number;
  element: HTMLElement | null;
}

const DEFAULT_TRANSFORM: Transform = {
  sx: 1, sy: 1, r0: 0, r1: 0, tx: 0, ty: 0,
};

/**
 * GsapSwfEngine: a GSAP-powered SWF timeline renderer.
 *
 * Architecture:
 * - GSAP timeline acts as a time-keeper (play/pause/scrub)
 * - On every GSAP update, we compute which frame we're on
 * - Display list is built cumulatively from frame 0..N (just like Flash)
 * - DOM elements are created/destroyed/updated directly (no React re-renders)
 *
 * This avoids the React state-per-frame overhead and gives us native GSAP
 * features: smooth scrubbing, variable speed, easing, etc.
 */
export class GsapSwfEngine {
  private data: TimelineData;
  private svgCache: Record<string, string>;
  private spriteImages: Record<string, string>;
  private stageEl: HTMLElement;
  private masterTimeline: gsap.core.Timeline;

  // Display list: depth -> entry
  private displayList: Map<number, DisplayEntry> = new Map();

  // Track the last rendered frame to avoid redundant work
  private lastRenderedFrame = -1;

  // SVG defs container for filters and clip paths
  private defsContainer: SVGDefsElement | null = null;

  // Optional callback for frame changes
  onFrameChange?: (frame: number) => void;

  constructor(
    data: TimelineData,
    svgCache: Record<string, string>,
    spriteImages: Record<string, string>,
    stageEl: HTMLElement,
  ) {
    this.data = data;
    this.svgCache = svgCache;
    this.spriteImages = spriteImages;
    this.stageEl = stageEl;

    // Create the SVG defs container for filters/clipPaths
    this.createDefsContainer();

    // Build the GSAP timeline (just a time-keeper)
    this.masterTimeline = this.buildTimeline();
  }

  private createDefsContainer() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    this.defsContainer = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.appendChild(this.defsContainer);
    this.stageEl.appendChild(svg);
  }

  /**
   * Build a GSAP timeline that acts as a time-keeper.
   * The timeline is just a dummy tween for its full duration.
   * On every update, we compute the current frame and render it.
   */
  private buildTimeline(): gsap.core.Timeline {
    const totalDuration = this.data.meta.frames / this.data.meta.fps;

    const tl = gsap.timeline({
      paused: true,
      onUpdate: () => this.onTimelineUpdate(),
      onComplete: () => this.onFrameChange?.(this.totalFrames - 1),
    });

    // Single dummy tween spanning the full duration
    tl.to({}, { duration: totalDuration });

    return tl;
  }

  /**
   * Called on every GSAP update tick. Determines the current frame
   * and renders if it changed.
   */
  private onTimelineUpdate() {
    const frame = this.timeToFrame(this.masterTimeline.time());
    if (frame !== this.lastRenderedFrame) {
      this.renderFrame(frame);
      this.onFrameChange?.(frame);
    }
  }

  private timeToFrame(time: number): number {
    const frame = Math.floor(time * this.data.meta.fps);
    return Math.max(0, Math.min(frame, this.data.meta.frames - 1));
  }

  /**
   * Render a specific frame. Handles both forward playback (incremental)
   * and arbitrary seeking (full rebuild from frame 0).
   */
  private renderFrame(targetFrame: number) {
    if (targetFrame === this.lastRenderedFrame) return;

    if (targetFrame > this.lastRenderedFrame && this.lastRenderedFrame >= 0) {
      // Forward playback: process incrementally
      for (let i = this.lastRenderedFrame + 1; i <= targetFrame; i++) {
        this.processFrameData(this.data.timeline[i]);
      }
    } else {
      // Backward seek or first render: rebuild from scratch
      this.clearDisplayList();
      for (let i = 0; i <= targetFrame; i++) {
        this.processFrameData(this.data.timeline[i]);
      }
    }

    // Update the visual DOM
    this.updateDisplay();
    this.lastRenderedFrame = targetFrame;
  }

  /**
   * Process a single frame's place/remove commands (updates display list only, no DOM)
   */
  private processFrameData(frame: FrameData) {
    // Remove elements
    for (const depth of frame.remove) {
      const entry = this.displayList.get(depth);
      if (entry) {
        this.destroyElement(entry);
        this.displayList.delete(depth);
      }
    }

    // Place/update elements
    for (const place of frame.place) {
      const depth = place.d;
      const existing = this.displayList.get(depth);

      if (place.m && existing) {
        // Move/update existing object
        if (place.t) existing.transform = place.t;
        if (place.ct) existing.colorTransform = place.ct;

        // Character replacement during move
        if (place.c && place.c !== existing.characterId) {
          this.destroyElement(existing);
          existing.characterId = place.c;
          existing.element = null;
          if (place.cd !== undefined) existing.clipDepth = place.cd;
        }
      } else if (place.c) {
        // Remove any existing element at this depth first
        if (existing) {
          this.destroyElement(existing);
        }

        // Place new object
        this.displayList.set(depth, {
          characterId: place.c,
          transform: place.t || { ...DEFAULT_TRANSFORM },
          colorTransform: place.ct,
          clipDepth: place.cd,
          element: null,
        });
      }
    }
  }

  private clearDisplayList() {
    for (const [, entry] of this.displayList) {
      this.destroyElement(entry);
    }
    this.displayList.clear();
  }

  private destroyElement(entry: DisplayEntry) {
    if (entry.element) {
      entry.element.remove();
      entry.element = null;
    }
  }

  /**
   * Sync all DOM elements to the current display list state.
   */
  private updateDisplay() {
    const depths = Array.from(this.displayList.keys()).sort((a, b) => a - b);

    // Build clip ranges: mask depth -> { start, end, maskEntry }
    const clipRanges: Array<{
      start: number;
      end: number;
      maskEntry: DisplayEntry;
      maskDepth: number;
    }> = [];

    for (const depth of depths) {
      const entry = this.displayList.get(depth)!;
      if (entry.clipDepth) {
        clipRanges.push({
          start: depth + 1,
          end: entry.clipDepth,
          maskEntry: entry,
          maskDepth: depth,
        });
      }
    }

    for (const depth of depths) {
      const entry = this.displayList.get(depth)!;

      // Skip mask elements (they define clips, not visual content)
      if (entry.clipDepth) continue;

      // Create DOM element if needed
      if (!entry.element) {
        entry.element = this.createElement(entry, depth);
        if (entry.element) {
          this.stageEl.appendChild(entry.element);
        }
      }

      if (!entry.element) continue;

      // z-index
      entry.element.style.zIndex = String(depth);

      // Transform
      this.applyTransform(entry);

      // Color transform
      this.applyColorTransform(entry, depth);

      // Clipping: embed clip path inside the element's SVG
      const clip = clipRanges.find(r => depth >= r.start && depth <= r.end);
      this.applyClipping(entry, depth, clip?.maskEntry);
    }
  }

  /**
   * Apply SVG-native clipping inside the element's SVG.
   * The clip mask path and content are both in Flash absolute coordinates
   * within the SVG's <g transform>. We compute a relative transform to
   * map from mask placement to element placement when they differ.
   */
  private applyClipping(
    entry: DisplayEntry,
    depth: number,
    maskEntry?: DisplayEntry,
  ) {
    if (!entry.element) return;

    const svg = entry.element.querySelector('svg');
    if (!svg) return; // Sprite PNGs don't have SVGs

    const gEl = svg.querySelector('g[transform]');
    if (!gEl) return;

    const clipId = `iclip-${depth}`;

    if (!maskEntry) {
      // Remove any existing clip
      gEl.removeAttribute('clip-path');
      const existing = svg.querySelector(`#${clipId}`);
      if (existing) existing.remove();
      return;
    }

    // Get the mask shape's path data (in Flash absolute coordinates)
    const maskSvgContent = this.svgCache[maskEntry.characterId];
    if (!maskSvgContent) return;

    const maskPathData = this.extractPathFromSvg(maskSvgContent);
    if (!maskPathData) return;

    // Compute relative transform: T_elem^(-1) * T_mask
    // This maps mask Flash coords to element Flash coords
    const relT = this.computeRelativeTransform(maskEntry.transform, entry.transform);

    // Ensure <defs> exists
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      svg.insertBefore(defs, svg.firstChild);
    }

    // Create or update <clipPath>
    let clipPathEl = svg.querySelector(`#${clipId}`) as SVGClipPathElement | null;
    if (!clipPathEl) {
      clipPathEl = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
      clipPathEl.setAttribute('id', clipId);
      defs.appendChild(clipPathEl);
    }

    // Set clip path content
    clipPathEl.innerHTML = '';
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', maskPathData);

    // Apply relative transform if not identity
    const isIdentity = Math.abs(relT.sx - 1) < 0.001 && Math.abs(relT.sy - 1) < 0.001 &&
      Math.abs(relT.r0) < 0.001 && Math.abs(relT.r1) < 0.001 &&
      Math.abs(relT.tx) < 0.1 && Math.abs(relT.ty) < 0.1;

    if (!isIdentity) {
      pathEl.setAttribute('transform',
        `matrix(${relT.sx}, ${relT.r0}, ${relT.r1}, ${relT.sy}, ${relT.tx}, ${relT.ty})`);
    }

    clipPathEl.appendChild(pathEl);

    // Apply clip to the <g> element
    gEl.setAttribute('clip-path', `url(#${clipId})`);
  }

  /**
   * Extract the first path's d attribute from SVG content
   */
  private extractPathFromSvg(svgContent: string): string | null {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgContent, 'image/svg+xml');
    const path = doc.querySelector('path');
    return path?.getAttribute('d') || null;
  }

  /**
   * Compute T_to^(-1) * T_from, mapping coordinates from
   * 'from' stage space to 'to' Flash space.
   */
  private computeRelativeTransform(from: Transform, to: Transform): Transform {
    // Inverse of 'to': maps stage coords to 'to' Flash coords
    const det = to.sx * to.sy - to.r0 * to.r1;
    if (Math.abs(det) < 1e-10) return { sx: 1, sy: 1, r0: 0, r1: 0, tx: 0, ty: 0 };

    const isx = to.sy / det;
    const isy = to.sx / det;
    const ir0 = -to.r0 / det;
    const ir1 = -to.r1 / det;
    const itx = (to.r1 * to.ty - to.sy * to.tx) / det;
    const ity = (to.r0 * to.tx - to.sx * to.ty) / det;

    // Multiply: inverse(to) * from
    return {
      sx: isx * from.sx + ir1 * from.r0,
      sy: ir0 * from.r1 + isy * from.sy,
      r0: ir0 * from.sx + isy * from.r0,
      r1: isx * from.r1 + ir1 * from.sy,
      tx: isx * from.tx + ir1 * from.ty + itx,
      ty: ir0 * from.tx + isy * from.ty + ity,
    };
  }

  // --- Element Creation ---

  private createElement(entry: DisplayEntry, depth: number): HTMLElement | null {
    const { characterId } = entry;
    const charInfo = this.data.characters[characterId];

    // Text fields (DefineEditTextTag)
    if (charInfo?.type === 'text') {
      return this.createTextElement(charInfo, depth);
    }

    // Image characters (standalone JPGs/PNGs loaded into spriteImages)
    if (charInfo?.type === 'image' && this.spriteImages[characterId]) {
      return this.createSpriteElement(characterId, depth);
    }

    // Sprite with pre-rendered PNG
    if (charInfo?.type === 'sprite' && this.spriteImages[characterId]) {
      return this.createSpriteElement(characterId, depth);
    }

    // Resolve shape ID for sprites that contain shapes (including buttons mapped to shapes)
    let shapeId = characterId;
    if (charInfo?.type === 'sprite' && charInfo.contains) {
      shapeId = charInfo.contains as string;
      // Resolve sprite chains (sprite -> sprite -> shape)
      const innerChar = this.data.characters[shapeId];
      if (innerChar?.type === 'sprite' && innerChar.contains) {
        shapeId = innerChar.contains;
      }
      // If the resolved target is a text field, render as text
      const resolvedChar = this.data.characters[shapeId];
      if (resolvedChar?.type === 'text') {
        return this.createTextElement(resolvedChar, depth);
      }
    }

    // Try SVG shape
    const svgContent = this.svgCache[shapeId];
    if (svgContent) {
      return this.createSvgElement(svgContent, shapeId, depth);
    }

    // Log missing assets
    if (!this._loggedMissing.has(characterId)) {
      this._loggedMissing.add(characterId);
      const type = charInfo?.type || 'unknown';
      const contains = charInfo?.contains || '';
      console.warn(
        `[SWF] Missing asset: char=${characterId} type=${type}` +
        (contains ? ` contains=${contains}` : '') +
        ` (tried shape=${shapeId})` +
        ` at depth=${depth}`
      );
    }

    return null;
  }

  private _loggedMissing = new Set<string>();

  private createSpriteElement(characterId: string, depth: number): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'gsap-element gsap-sprite';
    wrapper.dataset.characterId = characterId;
    wrapper.dataset.depth = String(depth);
    wrapper.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;';

    const img = document.createElement('img');
    img.src = this.spriteImages[characterId];
    img.alt = '';
    img.style.display = 'block';
    img.draggable = false;
    // Hide broken images instead of showing the browser's broken icon
    img.onerror = () => {
      console.warn(`[SWF] Image load failed: char=${characterId}`);
      wrapper.style.display = 'none';
    };

    wrapper.appendChild(img);
    return wrapper;
  }

  private createTextElement(charInfo: CharacterData, depth: number): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'gsap-element gsap-text';
    wrapper.dataset.depth = String(depth);
    wrapper.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;';

    const text = document.createElement('div');
    const content = String(charInfo.text || '').trim();
    text.textContent = content;
    text.style.cssText = `
      color: ${charInfo.color || '#000'};
      font-size: ${charInfo.fontSize || 12}px;
      font-family: 'Franklin Gothic Medium', 'Trebuchet MS', Arial, sans-serif;
      font-weight: bold;
      text-align: ${charInfo.align || 'left'};
      width: ${charInfo.width || 200}px;
      white-space: nowrap;
      overflow: hidden;
      line-height: 1.2;
    `;

    wrapper.appendChild(text);
    return wrapper;
  }

  private createSvgElement(
    svgContent: string,
    shapeId: string,
    depth: number,
  ): HTMLElement | null {
    if (!this.hasVisibleContent(svgContent)) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'gsap-element gsap-shape';
    wrapper.dataset.characterId = shapeId;
    wrapper.dataset.depth = String(depth);
    wrapper.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';

    const parser = new DOMParser();
    const doc = parser.parseFromString(svgContent, 'image/svg+xml');
    const svg = doc.documentElement;

    // Namespace all IDs to prevent collisions between shapes
    const prefix = `g${shapeId}_d${depth}`;
    this.makeIdsUnique(svg, prefix);

    svg.style.overflow = 'visible';
    svg.style.display = 'block';

    // Extract the SVG's internal <g transform> offset.
    // This offset maps Flash absolute coordinates to the SVG viewport.
    // We store it so applyTransform() can set transform-origin correctly.
    const offset = this.extractSvgOffset(svgContent);
    wrapper.dataset.offsetX = String(offset.x);
    wrapper.dataset.offsetY = String(offset.y);

    // Set initial transform-origin to the SVG offset
    wrapper.style.transformOrigin = `${offset.x}px ${offset.y}px`;

    wrapper.appendChild(svg);
    return wrapper;
  }

  // --- Transform & Color ---

  private applyTransform(entry: DisplayEntry) {
    if (!entry.element) return;

    let t = entry.transform;
    const charInfo = this.data.characters[entry.characterId];

    // Sprite with PNG: direct transform, no SVG offset needed
    if (charInfo?.type === 'sprite' && this.spriteImages[entry.characterId]) {
      entry.element.style.transform = `matrix(${t.sx}, ${t.r0}, ${t.r1}, ${t.sy}, ${t.tx}, ${t.ty})`;
      return;
    }

    // Sprite containing a shape: combine outer + inner transforms
    if (charInfo?.type === 'sprite' && charInfo.contains && charInfo.innerTransform) {
      t = this.combineTransforms(t, charInfo.innerTransform);
    }

    // SVG shapes have an internal <g transform> that maps Flash absolute coordinates
    // to the SVG viewport. We need to set transform-origin to the SVG's internal
    // offset so CSS undoes that mapping before applying the Flash placement matrix.
    //
    // CSS with transform-origin applies: translate(origin) * matrix * translate(-origin)
    // The -origin step maps SVG-local coords back to Flash coords, the matrix transforms
    // in Flash space, then +origin maps back to SVG-local space.
    const offsetX = parseFloat(entry.element.dataset.offsetX || '0');
    const offsetY = parseFloat(entry.element.dataset.offsetY || '0');

    // Set transform-origin to the SVG's internal offset
    entry.element.style.transformOrigin = `${offsetX}px ${offsetY}px`;

    // Adjust translate: with transform-origin, we use (tx - offsetX) not (tx + offsetX)
    const adjustedTx = t.tx - offsetX;
    const adjustedTy = t.ty - offsetY;

    entry.element.style.transform = `matrix(${t.sx}, ${t.r0}, ${t.r1}, ${t.sy}, ${adjustedTx}, ${adjustedTy})`;
  }

  private applyColorTransform(entry: DisplayEntry, depth: number) {
    if (!entry.element) return;

    const ct = entry.colorTransform;
    if (!ct) {
      entry.element.style.opacity = '1';
      entry.element.style.filter = '';
      return;
    }

    const am = ct.am ?? 1;
    const rm = ct.rm ?? 1;
    const gm = ct.gm ?? 1;
    const bm = ct.bm ?? 1;
    const ra = (ct.ra ?? 0) / 255;
    const ga = (ct.ga ?? 0) / 255;
    const ba = (ct.ba ?? 0) / 255;

    entry.element.style.opacity = String(Math.max(0, Math.min(1, am)));

    const needsFilter = rm !== 1 || gm !== 1 || bm !== 1 || ra !== 0 || ga !== 0 || ba !== 0;

    if (needsFilter && this.defsContainer) {
      const filterId = `gsap-color-${depth}`;
      let filter = this.defsContainer.querySelector(`#${filterId}`);

      if (!filter) {
        filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
        filter.setAttribute('id', filterId);
        this.defsContainer.appendChild(filter);
      }

      filter.innerHTML = `<feColorMatrix type="matrix" values="${rm} 0 0 0 ${ra}  0 ${gm} 0 0 ${ga}  0 0 ${bm} 0 ${ba}  0 0 0 1 0"/>`;
      entry.element.style.filter = `url(#${filterId})`;
    } else {
      entry.element.style.filter = '';
    }
  }

  // --- SVG Utilities ---

  private extractSvgOffset(svgContent: string): { x: number; y: number } {
    const match = svgContent.match(
      /<g[^>]*transform="matrix\([^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([^,]+),\s*([^)]+)\)"/,
    );
    if (match) {
      return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
    }
    return { x: 0, y: 0 };
  }

  private hasVisibleContent(svgContent: string): boolean {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgContent, 'image/svg+xml');
    return doc.querySelector('path, rect, circle, ellipse, polygon, polyline, image, use') !== null;
  }

  private makeIdsUnique(svg: Element, prefix: string) {
    const idMap = new Map<string, string>();

    svg.querySelectorAll('[id]').forEach(el => {
      const oldId = el.getAttribute('id')!;
      const newId = `${prefix}_${oldId}`;
      el.setAttribute('id', newId);
      idMap.set(oldId, newId);
    });

    svg.querySelectorAll('*').forEach(el => {
      for (const attr of ['fill', 'stroke', 'clip-path', 'mask', 'filter']) {
        const val = el.getAttribute(attr);
        if (val?.startsWith('url(#')) {
          const oldId = val.match(/url\(#([^)]+)\)/)?.[1];
          if (oldId && idMap.has(oldId)) {
            el.setAttribute(attr, `url(#${idMap.get(oldId)})`);
          }
        }
      }
      for (const attr of ['href', 'xlink:href']) {
        const val = el.getAttribute(attr);
        if (val?.startsWith('#')) {
          const oldId = val.substring(1);
          if (idMap.has(oldId)) {
            el.setAttribute(attr, `#${idMap.get(oldId)}`);
          }
        }
      }
    });
  }

  private combineTransforms(outer: Transform, inner: Transform): Transform {
    return {
      sx: outer.sx * inner.sx,
      sy: outer.sy * inner.sy,
      r0: outer.r0 * inner.sx + outer.sx * inner.r0,
      r1: outer.r1 * inner.sy + outer.sy * inner.r1,
      tx: outer.tx + outer.sx * inner.tx + outer.r1 * inner.ty,
      ty: outer.ty + outer.r0 * inner.tx + outer.sy * inner.ty,
    };
  }

  // ===========================
  // Public API
  // ===========================

  get timeline(): gsap.core.Timeline {
    return this.masterTimeline;
  }

  get totalDuration(): number {
    return this.data.meta.frames / this.data.meta.fps;
  }

  get fps(): number {
    return this.data.meta.fps;
  }

  get totalFrames(): number {
    return this.data.meta.frames;
  }

  get stageWidth(): number {
    return this.data.meta.width;
  }

  get stageHeight(): number {
    return this.data.meta.height;
  }

  get currentFrame(): number {
    return this.lastRenderedFrame >= 0 ? this.lastRenderedFrame : 0;
  }

  get isPlaying(): boolean {
    return this.masterTimeline.isActive();
  }

  play() {
    if (this.currentFrame >= this.totalFrames - 1) {
      this.seekToFrame(0);
    }
    this.masterTimeline.play();
  }

  pause() {
    this.masterTimeline.pause();
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  /**
   * Seek to a specific frame. Rebuilds display list from scratch
   * when seeking backward, or incrementally when seeking forward.
   */
  seekToFrame(frame: number) {
    const clamped = Math.max(0, Math.min(frame, this.totalFrames - 1));
    this.renderFrame(clamped);
    // Sync GSAP time without triggering its onUpdate (we already rendered)
    this.masterTimeline.time(clamped / this.data.meta.fps);
  }

  seekToProgress(progress: number) {
    const frame = Math.round(progress * (this.totalFrames - 1));
    this.seekToFrame(frame);
  }

  restart() {
    this.clearDisplayList();
    this.lastRenderedFrame = -1;
    this.masterTimeline.time(0);
    this.masterTimeline.pause();
    this.renderFrame(0);
  }

  /**
   * Clean up everything when the component unmounts
   */
  destroy() {
    this.masterTimeline.kill();
    this.clearDisplayList();
    if (this.defsContainer?.parentElement) {
      this.defsContainer.parentElement.remove();
    }
  }

  /**
   * Get display list info for debug panel
   */
  getDisplayListInfo(): Array<{
    depth: number;
    characterId: string;
    type: string;
    transform: Transform;
    isClip: boolean;
  }> {
    const result: Array<{
      depth: number;
      characterId: string;
      type: string;
      transform: Transform;
      isClip: boolean;
    }> = [];

    const depths = Array.from(this.displayList.keys()).sort((a, b) => a - b);
    for (const depth of depths) {
      const entry = this.displayList.get(depth)!;
      const charInfo = this.data.characters[entry.characterId];
      result.push({
        depth,
        characterId: entry.characterId,
        type: charInfo?.type || 'shape',
        transform: entry.transform,
        isClip: !!entry.clipDepth,
      });
    }

    return result;
  }
}
