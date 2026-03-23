/**
 * GsapSwfRenderer - Takes parsed SWF data and renders it using
 * DOM elements controlled by a GSAP master timeline.
 *
 * Every shape/sprite/text becomes a DOM element that GSAP can
 * individually target with .to(), .from(), .set() etc.
 */

import gsap from 'gsap';
import type {
  SwfMovie, SwfFrame,
  SwfMatrix, SwfColorTransform, SwfShapeChar, SwfTextChar, SwfImageChar, SwfSpriteChar,
} from './SwfParser';

interface DisplayEntry {
  depth: number;
  characterId: number;
  element: HTMLElement;
  matrix: SwfMatrix;
  colorTransform?: SwfColorTransform;
  clipDepth?: number;
  ratio?: number;
  placedAtFrame: number;
}

interface GsapSwfRendererOptions {
  hiddenCharacterIds?: number[];
}

export class GsapSwfRenderer {
  private movie: SwfMovie;
  private stageEl: HTMLElement;
  private timeline: gsap.core.Timeline;
  private displayList = new Map<number, DisplayEntry>();
  private lastRenderedFrame = -1;
  private spriteTimelineRequirementCache = new Map<number, boolean>();
  private hiddenCharacterIds: Set<number>;

  /** Fires on each frame change */
  onFrameChange?: (frame: number) => void;
  onPlaybackChange?: (isPlaying: boolean) => void;

  constructor(movie: SwfMovie, stageEl: HTMLElement, options: GsapSwfRendererOptions = {}) {
    this.movie = movie;
    this.stageEl = stageEl;
    this.hiddenCharacterIds = new Set(options.hiddenCharacterIds ?? []);

    // Set stage background
    stageEl.style.background = movie.backgroundColor;

    // Build GSAP timeline (time-keeper)
    const totalDuration = movie.frameCount / movie.frameRate;
    this.timeline = gsap.timeline({
      paused: true,
      onUpdate: () => this.onTimelineUpdate(),
      onComplete: () => this.onPlaybackChange?.(false),
    });
    this.timeline.to({}, { duration: totalDuration });
  }

  private onTimelineUpdate() {
    const frame = Math.min(
      Math.floor(this.timeline.time() * this.movie.frameRate),
      this.movie.frameCount - 1
    );
    if (frame !== this.lastRenderedFrame) {
      this.renderFrame(frame);
      this.onFrameChange?.(frame);
    }
  }

  private renderFrame(targetFrame: number) {
    if (targetFrame === this.lastRenderedFrame) return;

    if (targetFrame > this.lastRenderedFrame && this.lastRenderedFrame >= 0) {
      // Forward: incremental
      for (let i = this.lastRenderedFrame + 1; i <= targetFrame; i++) {
        this.processFrame(this.movie.frames[i], i);
      }
    } else {
      // Backward or first render: rebuild from scratch
      this.clearStage();
      for (let i = 0; i <= targetFrame; i++) {
        this.processFrame(this.movie.frames[i], i);
      }
    }

    this.updateDisplay(targetFrame);
    this.lastRenderedFrame = targetFrame;
  }

  private processFrame(frame: SwfFrame, frameIndex: number) {
    // Removals
    for (const depth of frame.removals) {
      const entry = this.displayList.get(depth);
      if (entry) {
        entry.element.remove();
        this.displayList.delete(depth);
      }
    }

    // Placements
    for (const p of frame.placements) {
      if (p.isUpdate && this.displayList.has(p.depth)) {
        // Update existing
        const entry = this.displayList.get(p.depth)!;
        if (p.matrix) entry.matrix = p.matrix;
        if (p.colorTransform) entry.colorTransform = p.colorTransform;
        if (p.clipDepth !== undefined) entry.clipDepth = p.clipDepth;
        if (p.ratio !== undefined) entry.ratio = p.ratio;
        if (p.characterId !== undefined && p.characterId !== entry.characterId) {
          entry.element.remove();
          const newEl = this.createElement(p.characterId, p.depth);
          if (newEl) {
            entry.element = newEl;
            entry.characterId = p.characterId;
            entry.ratio = p.ratio;
            entry.placedAtFrame = frameIndex;
            this.stageEl.appendChild(newEl);
          }
        }
      } else if (p.characterId !== undefined) {
        // New placement
        const existing = this.displayList.get(p.depth);
        if (existing) {
          existing.element.remove();
        }

        const el = this.createElement(p.characterId, p.depth);
        if (el) {
          this.stageEl.appendChild(el);
          this.displayList.set(p.depth, {
            depth: p.depth,
            characterId: p.characterId,
            element: el,
            matrix: p.matrix || { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
            colorTransform: p.colorTransform,
            clipDepth: p.clipDepth,
            ratio: p.ratio,
            placedAtFrame: frameIndex,
          });
        }
      }
    }
  }

  private updateDisplay(currentFrame: number) {
    this.updateDisplayList(this.displayList, currentFrame);
  }

  private updateDisplayList(displayList: Map<number, DisplayEntry>, currentFrame: number) {
    const clipRanges: Array<{ start: number; end: number; maskEntry: DisplayEntry; maskDepth: number }> = [];

    for (const [depth, entry] of displayList) {
      if (entry.clipDepth) {
        clipRanges.push({
          start: depth + 1,
          end: entry.clipDepth,
          maskEntry: entry,
          maskDepth: depth,
        });
      }
    }

    for (const [depth, entry] of displayList) {
      const el = entry.element;
      const clipRange = clipRanges.find((range) => depth >= range.start && depth <= range.end);
      const char = this.movie.characters.get(entry.characterId);

      if (char?.type === 'sprite') {
        this.syncSpriteDisplay(entry, char, currentFrame);
      }

      if (this.hiddenCharacterIds.has(entry.characterId)) {
        el.style.display = 'none';
        continue;
      }

      // z-index
      el.style.zIndex = String(depth);

      // Transform - placement matrix adjusted into each element's viewport space
      this.applyPlacementTransform(el, entry.matrix);

      // Color transform
      this.applyColorTransform(entry, depth);

      // Keep mask elements in the DOM tree so SVG CTM math stays available.
      if (entry.clipDepth) {
        el.style.display = '';
        el.style.visibility = 'hidden';
        el.style.opacity = '0';
        continue;
      }

      el.style.display = '';
      el.style.visibility = '';

      this.applyClipping(entry, depth, clipRange?.maskEntry ?? null);
    }
  }

  private applyClipping(entry: DisplayEntry, depth: number, maskEntry: DisplayEntry | null) {
    const targetSvg = entry.element.querySelector('svg');
    const targetGroup = targetSvg?.querySelector('g.swf-content') as SVGGElement | null;
    if (!targetSvg || !targetGroup) return;

    const clipId = `swf-clip-${depth}`;

    if (!maskEntry?.element) {
      targetGroup.removeAttribute('clip-path');
      targetSvg.querySelector(`#${clipId}`)?.remove();
      return;
    }

    const maskSvg = maskEntry.element.querySelector('svg');
    const maskGroup = maskSvg?.querySelector('g.swf-content') as SVGGElement | null;
    if (!maskSvg || !maskGroup) return;

    let defs = targetSvg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      targetSvg.insertBefore(defs, targetSvg.firstChild);
    }

    let clipPathEl = targetSvg.querySelector(`#${clipId}`) as SVGClipPathElement | null;
    if (!clipPathEl) {
      clipPathEl = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
      clipPathEl.setAttribute('id', clipId);
      clipPathEl.setAttribute('clipPathUnits', 'userSpaceOnUse');
      defs.appendChild(clipPathEl);
    }

    clipPathEl.innerHTML = '';

    const targetCtm = targetGroup.getScreenCTM();
    const maskCtm = maskGroup.getScreenCTM();
    if (!targetCtm || !maskCtm) return;

    const rel = targetCtm.inverse().multiply(maskCtm);
    const transformedMaskGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    transformedMaskGroup.setAttribute(
      'transform',
      `matrix(${rel.a}, ${rel.b}, ${rel.c}, ${rel.d}, ${rel.e}, ${rel.f})`
    );

    const maskClone = maskGroup.cloneNode(true) as SVGGElement;
    maskClone.removeAttribute('transform');
    transformedMaskGroup.appendChild(maskClone);

    clipPathEl.appendChild(transformedMaskGroup);
    targetGroup.setAttribute('clip-path', `url(#${clipId})`);
  }

  private applyPlacementTransform(element: HTMLElement, matrix: SwfMatrix) {
    const viewportMatrix = this.getViewportTransform(element, matrix);
    element.style.transformOrigin = '0 0';
    element.style.transform = `matrix(${viewportMatrix.a}, ${viewportMatrix.b}, ${viewportMatrix.c}, ${viewportMatrix.d}, ${viewportMatrix.tx}, ${viewportMatrix.ty})`;
  }

  private getViewportTransform(element: HTMLElement, matrix: SwfMatrix): SwfMatrix {
    const offset = this.getElementOffset(element);
    return {
      a: matrix.a,
      b: matrix.b,
      c: matrix.c,
      d: matrix.d,
      tx: matrix.tx - (matrix.a * offset.x + matrix.c * offset.y),
      ty: matrix.ty - (matrix.b * offset.x + matrix.d * offset.y),
    };
  }

  private getElementOffset(element: HTMLElement): { x: number; y: number } {
    return {
      x: parseFloat(element.dataset.offsetX || '0'),
      y: parseFloat(element.dataset.offsetY || '0'),
    };
  }

  private applyColorTransform(entry: DisplayEntry, depth: number) {
    const ct = entry.colorTransform;
    const svg = entry.element.querySelector('svg');
    const targetGroup = svg?.querySelector('g.swf-content');

    if (!ct) {
      entry.element.style.opacity = '1';
      targetGroup?.removeAttribute('filter');
      svg?.querySelector(`#swf-color-${depth}`)?.remove();
      return;
    }

    const rm = ct.rm ?? 1;
    const gm = ct.gm ?? 1;
    const bm = ct.bm ?? 1;
    const am = ct.am ?? 1;
    const ra = (ct.ra ?? 0) / 255;
    const ga = (ct.ga ?? 0) / 255;
    const ba = (ct.ba ?? 0) / 255;
    const aa = (ct.aa ?? 0) / 255;
    const needsFilter = rm !== 1 || gm !== 1 || bm !== 1 || am !== 1 || ra !== 0 || ga !== 0 || ba !== 0 || aa !== 0;

    if (!svg || !targetGroup || !needsFilter) {
      entry.element.style.opacity = String(Math.max(0, Math.min(1, am)));
      targetGroup?.removeAttribute('filter');
      svg?.querySelector(`#swf-color-${depth}`)?.remove();
      return;
    }

    entry.element.style.opacity = '1';

    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      svg.insertBefore(defs, svg.firstChild);
    }

    const filterId = `swf-color-${depth}`;
    let filterEl = svg.querySelector(`#${filterId}`) as SVGFilterElement | null;
    if (!filterEl) {
      filterEl = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
      filterEl.setAttribute('id', filterId);
      defs.appendChild(filterEl);
    }

    filterEl.innerHTML = `<feColorMatrix type="matrix" values="${rm} 0 0 0 ${ra} 0 ${gm} 0 0 ${ga} 0 0 ${bm} 0 ${ba} 0 0 0 ${am} ${aa}"/>`;
    targetGroup.setAttribute('filter', `url(#${filterId})`);
  }

  private createElement(charId: number, depth: number, spriteFrame = 0, forceSpriteTimeline = false): HTMLElement | null {
    const char = this.movie.characters.get(charId);
    if (!char) return null;

    switch (char.type) {
      case 'shape':
        return this.createShapeElement(char, depth);
      case 'image':
        return this.createImageElement(char, depth);
      case 'text':
        return this.createTextElement(char, depth);
      case 'sprite':
        return this.createSpriteElement(char, depth, spriteFrame, forceSpriteTimeline);
      default:
        return null;
    }
  }

  private createShapeElement(char: SwfShapeChar, depth: number): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'swf-shape';
    wrapper.dataset.charId = String(char.id);
    wrapper.dataset.depth = String(depth);
    wrapper.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;';

    const parser = new DOMParser();
    const doc = parser.parseFromString(char.svgPaths, 'image/svg+xml');
    const svg = doc.documentElement as unknown as SVGSVGElement;
    this.ensureSvgContentGroup(svg);
    this.makeIdsUnique(svg, `swf-shape-${char.id}-depth-${depth}`);
    const offset = this.extractSvgOffset(svg, {
      x: -char.bounds.xMin,
      y: -char.bounds.yMin,
    });
    wrapper.dataset.offsetX = String(offset.x);
    wrapper.dataset.offsetY = String(offset.y);
    wrapper.style.transformOrigin = `${offset.x}px ${offset.y}px`;
    svg.style.overflow = 'visible';
    svg.style.position = 'absolute';
    svg.style.left = '0';
    svg.style.top = '0';
    wrapper.appendChild(svg);

    return wrapper;
  }

  private createImageElement(char: SwfImageChar, _depth?: number): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'swf-image';
    wrapper.dataset.charId = String(char.id);
    wrapper.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;';

    const img = document.createElement('img');
    img.src = char.dataUrl;
    img.width = char.width;
    img.height = char.height;
    img.draggable = false;
    img.onerror = () => { wrapper.style.display = 'none'; };

    wrapper.appendChild(img);
    return wrapper;
  }

  private createTextElement(char: SwfTextChar, _depth?: number): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'swf-text';
    wrapper.dataset.charId = String(char.id);
    wrapper.dataset.offsetX = String(-char.bounds.xMin);
    wrapper.dataset.offsetY = String(-char.bounds.yMin);
    wrapper.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;';
    wrapper.style.transformOrigin = `${-char.bounds.xMin}px ${-char.bounds.yMin}px`;

    const font = this.movie.characters.get(char.fontId);
    const fontName = font?.type === 'font' ? font.fontName : 'Arial';
    const fontWeight = font?.type === 'font' && font.isBold ? 'bold' : 'normal';

    const text = document.createElement('div');
    text.textContent = char.text;
    text.style.cssText = `
      color: ${char.color};
      font-size: ${char.fontSize}px;
      font-family: '${fontName}', 'Franklin Gothic Medium', 'Trebuchet MS', Arial, sans-serif;
      font-weight: ${fontWeight};
      text-align: ${['left', 'right', 'center', 'justify'][char.align] || 'left'};
      width: ${char.bounds.xMax - char.bounds.xMin}px;
      line-height: 1.2;
      white-space: pre-wrap;
    `;
    wrapper.appendChild(text);
    return wrapper;
  }

  private createSpriteElement(
    char: SwfSpriteChar,
    _depth?: number,
    spriteFrame = 0,
    forceTimeline = false,
  ): HTMLElement | null {
    const wrapper = document.createElement('div');
    wrapper.className = 'swf-sprite';
    wrapper.dataset.charId = String(char.id);
    wrapper.dataset.offsetX = '0';
    wrapper.dataset.offsetY = '0';
    wrapper.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;';

    const canUseSnapshot = Boolean(char.imageUrl && !forceTimeline && !this.spriteNeedsTimeline(char));
    if (canUseSnapshot) {
      const img = document.createElement('img');
      img.src = char.imageUrl!;
      img.draggable = false;
      img.style.display = 'block';
      img.onerror = () => { wrapper.style.display = 'none'; };
      wrapper.appendChild(img);
      return wrapper;
    }

    this.renderSpriteContents(wrapper, char, spriteFrame);
    return wrapper;
  }

  private syncSpriteDisplay(entry: DisplayEntry, char: SwfSpriteChar, currentFrame: number) {
    if (char.imageUrl && !this.spriteNeedsTimeline(char)) return;

    const spriteFrame = this.getSpritePlaybackFrame(char, currentFrame, entry.placedAtFrame, entry.ratio);
    if (entry.element.dataset.spriteFrame === String(spriteFrame)) {
      return;
    }

    this.renderSpriteContents(entry.element, char, spriteFrame);
  }

  private renderSpriteContents(container: HTMLElement, char: SwfSpriteChar, spriteFrame: number) {
    container.innerHTML = '';
    container.dataset.spriteFrame = String(spriteFrame);

    const displayList = this.buildSpriteDisplayList(char, spriteFrame);
    const orderedEntries = Array.from(displayList.values()).sort((a, b) => a.depth - b.depth);
    for (const entry of orderedEntries) {
      container.appendChild(entry.element);
    }
    this.updateDisplayList(displayList, spriteFrame);
  }

  private buildSpriteDisplayList(char: SwfSpriteChar, spriteFrame: number): Map<number, DisplayEntry> {
    const displayList = new Map<number, DisplayEntry>();
    const lastFrame = Math.max(0, Math.min(spriteFrame, Math.max(char.frames.length - 1, 0)));
    const forceTimelineChildren = this.spriteForcesTimelineChildren(char);

    for (let frameIndex = 0; frameIndex <= lastFrame; frameIndex++) {
      const frame = char.frames[frameIndex];
      if (!frame) continue;

      for (const depth of frame.removals) {
        const entry = displayList.get(depth);
        if (entry) {
          entry.element.remove();
          displayList.delete(depth);
        }
      }

      for (const placement of frame.placements) {
        if (placement.isUpdate && displayList.has(placement.depth)) {
          const entry = displayList.get(placement.depth)!;
          if (placement.matrix) entry.matrix = placement.matrix;
          if (placement.colorTransform) entry.colorTransform = placement.colorTransform;
          if (placement.clipDepth !== undefined) entry.clipDepth = placement.clipDepth;
          if (placement.ratio !== undefined) entry.ratio = placement.ratio;
          if (placement.characterId !== undefined && placement.characterId !== entry.characterId) {
            entry.element.remove();
            const replacement = this.createElement(placement.characterId, placement.depth, 0, forceTimelineChildren);
            if (replacement) {
              entry.element = replacement;
              entry.characterId = placement.characterId;
              entry.ratio = placement.ratio;
              entry.placedAtFrame = frameIndex;
            }
          }
          continue;
        }

        if (placement.characterId === undefined) continue;

        const existing = displayList.get(placement.depth);
        if (existing) {
          existing.element.remove();
        }

        const element = this.createElement(placement.characterId, placement.depth, 0, forceTimelineChildren);
        if (!element) continue;

        displayList.set(placement.depth, {
          depth: placement.depth,
          characterId: placement.characterId,
          element,
          matrix: placement.matrix || { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
          colorTransform: placement.colorTransform,
          clipDepth: placement.clipDepth,
          ratio: placement.ratio,
          placedAtFrame: frameIndex,
        });
      }
    }

    return displayList;
  }

  private getSpriteFrameForPlacement(currentFrame: number, placedAtFrame: number, frameCount: number): number {
    return Math.max(0, Math.min(currentFrame - placedAtFrame, Math.max(frameCount - 1, 0)));
  }

  private getSpritePlaybackFrame(
    char: SwfSpriteChar,
    currentFrame: number,
    placedAtFrame: number,
    ratio?: number,
  ): number {
    if (ratio !== undefined) {
      return Math.max(0, Math.min(Math.round(ratio), Math.max(char.frameCount - 1, 0)));
    }
    if (this.spriteShouldStayOnFirstFrame(char)) {
      return 0;
    }
    return this.getSpriteFrameForPlacement(currentFrame, placedAtFrame, char.frameCount);
  }

  private spriteForcesTimelineChildren(char: SwfSpriteChar): boolean {
    return [124, 131, 137, 144, 153, 159].includes(char.id);
  }

  private spriteShouldStayOnFirstFrame(char: SwfSpriteChar): boolean {
    return [121, 126, 136, 142, 152, 155].includes(char.id);
  }

  private spriteNeedsTimeline(char: SwfSpriteChar, visiting = new Set<number>()): boolean {
    const cached = this.spriteTimelineRequirementCache.get(char.id);
    if (cached !== undefined) {
      return cached;
    }

    if (char.id === 146) {
      this.spriteTimelineRequirementCache.set(char.id, true);
      return true;
    }

    if (visiting.has(char.id)) {
      return false;
    }

    visiting.add(char.id);

    for (const frame of char.frames) {
      for (const placement of frame.placements) {
        if (placement.characterId === undefined) continue;
        const child = this.movie.characters.get(placement.characterId);
        if (!child) continue;
        if (child.type === 'text') {
          this.spriteTimelineRequirementCache.set(char.id, true);
          visiting.delete(char.id);
          return true;
        }
        if (child.type === 'sprite' && this.spriteNeedsTimeline(child, visiting)) {
          this.spriteTimelineRequirementCache.set(char.id, true);
          visiting.delete(char.id);
          return true;
        }
      }
    }

    visiting.delete(char.id);
    this.spriteTimelineRequirementCache.set(char.id, false);
    return false;
  }

  private makeIdsUnique(svg: Element, prefix: string) {
    const idMap = new Map<string, string>();

    svg.querySelectorAll('[id]').forEach((el) => {
      const oldId = el.getAttribute('id');
      if (!oldId) return;
      const newId = `${prefix}-${oldId}`;
      el.setAttribute('id', newId);
      idMap.set(oldId, newId);
    });

    svg.querySelectorAll('*').forEach((el) => {
      for (const attr of ['fill', 'stroke', 'clip-path', 'mask', 'filter']) {
        const value = el.getAttribute(attr);
        if (!value?.startsWith('url(#')) continue;

        const oldId = value.match(/url\(#([^)]+)\)/)?.[1];
        if (oldId && idMap.has(oldId)) {
          el.setAttribute(attr, `url(#${idMap.get(oldId)})`);
        }
      }

      const style = el.getAttribute('style');
      if (style?.includes('url(#')) {
        const updatedStyle = style.replace(/url\(#([^)]+)\)/g, (full, oldId: string) => {
          return idMap.has(oldId) ? `url(#${idMap.get(oldId)})` : full;
        });
        el.setAttribute('style', updatedStyle);
      }

      for (const attr of ['href', 'xlink:href']) {
        const value = el.getAttribute(attr);
        if (!value?.startsWith('#')) continue;

        const oldId = value.slice(1);
        if (idMap.has(oldId)) {
          el.setAttribute(attr, `#${idMap.get(oldId)}`);
        }
      }
    });
  }

  private ensureSvgContentGroup(svg: SVGSVGElement): SVGGElement {
    const existing = svg.querySelector('g.swf-content');
    if (existing) {
      return existing as SVGGElement;
    }

    const contentGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    contentGroup.setAttribute('class', 'swf-content');

    const nodesToMove = Array.from(svg.childNodes).filter((node) => {
      return !(node instanceof SVGDefsElement);
    });

    for (const node of nodesToMove) {
      contentGroup.appendChild(node);
    }

    svg.appendChild(contentGroup);
    return contentGroup;
  }

  private extractSvgOffset(
    svg: SVGSVGElement,
    fallback: { x: number; y: number },
  ): { x: number; y: number } {
    const contentGroup = svg.querySelector('g.swf-content');
    const transform = contentGroup?.getAttribute('transform');
    if (transform) {
      const match = transform.match(
        /matrix\([^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([^,]+),\s*([^)]+)\)/,
      );
      if (match) {
        return {
          x: parseFloat(match[1]),
          y: parseFloat(match[2]),
        };
      }
    }

    const viewBox = svg.getAttribute('viewBox');
    if (viewBox) {
      const [minX, minY] = viewBox.split(/[\s,]+/).slice(0, 2).map(Number);
      if (Number.isFinite(minX) && Number.isFinite(minY)) {
        return {
          x: -minX,
          y: -minY,
        };
      }
    }

    return fallback;
  }

  private clearStage() {
    for (const [, entry] of this.displayList) {
      entry.element.remove();
    }
    this.displayList.clear();
  }

  // ===== Public API =====

  get masterTimeline(): gsap.core.Timeline {
    return this.timeline;
  }

  get currentFrame(): number {
    return this.lastRenderedFrame >= 0 ? this.lastRenderedFrame : 0;
  }

  get totalFrames(): number {
    return this.movie.frameCount;
  }

  get fps(): number {
    return this.movie.frameRate;
  }

  get isPlaying(): boolean {
    return this.timeline.isActive();
  }

  play() {
    if (this.currentFrame >= this.totalFrames - 1) {
      this.seekToFrame(0);
    }
    this.timeline.play();
    this.onPlaybackChange?.(true);
  }

  pause() {
    this.timeline.pause();
    this.onPlaybackChange?.(false);
  }

  togglePlay() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  seekToFrame(frame: number) {
    const clamped = Math.max(0, Math.min(frame, this.totalFrames - 1));
    this.renderFrame(clamped);
    this.timeline.time(clamped / this.movie.frameRate, true);
    this.onFrameChange?.(clamped);
  }

  restart() {
    this.clearStage();
    this.lastRenderedFrame = -1;
    this.timeline.time(0, true);
    this.timeline.pause();
    this.renderFrame(0);
    this.onFrameChange?.(0);
    this.onPlaybackChange?.(false);
  }

  destroy() {
    this.timeline.kill();
    this.clearStage();
    this.onPlaybackChange?.(false);
  }

  /**
   * Get a GSAP-targetable element by character ID or depth.
   * This is the key feature: you can do gsap.to(renderer.getElement(15), { x: 100 })
   */
  getElementByCharId(charId: number): HTMLElement | null {
    for (const [, entry] of this.displayList) {
      if (entry.characterId === charId) return entry.element;
    }
    return null;
  }

  getElementByDepth(depth: number): HTMLElement | null {
    return this.displayList.get(depth)?.element || null;
  }

  getAllElements(): Array<{ depth: number; charId: number; element: HTMLElement }> {
    return Array.from(this.displayList.values()).map(e => ({
      depth: e.depth,
      charId: e.characterId,
      element: e.element,
    }));
  }
}
