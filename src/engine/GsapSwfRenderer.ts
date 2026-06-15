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
  SwfMatrix, SwfColorTransform, SwfShapeChar, SwfTextChar, SwfImageChar, SwfSpriteChar, SwfFontChar,
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
  instanceName?: string;
  spritePlayback?: SpritePlaybackState;
}

interface GsapSwfRendererOptions {
  hiddenCharacterIds?: number[];
}

interface SpritePlaybackState {
  startFrame: number;
  startedAtTick: number;
  isPlaying: boolean;
}

interface TimelineState {
  currentFrame: number;
  isPlaying: boolean;
}

interface DisplayBinding {
  depth: number;
  characterId: number;
  instanceName?: string;
  ratio?: number;
}

interface Avm1Object {
  [key: string]: Avm1Value;
}

interface MovieTimelineState extends TimelineState {
  globals: Map<string, Avm1Value>;
  playbackOverridesByName: Map<string, SpritePlaybackState>;
  timeMarkTick: number | null;
}

interface Avm1FunctionDef {
  name: string;
  params: string[];
  body: Uint8Array;
  constantPool: string[];
  isFunction2?: boolean;
  registerCount?: number;
  paramRegisters?: number[];
  flags?: number;
}

type Avm1Primitive = string | number | boolean | null;
type Avm1Value = Avm1Primitive | DisplayEntry | DisplayBinding | Avm1Object | Avm1FunctionDef | undefined;

const loadedFontFaces = new Map<string, Promise<void>>();

export class GsapSwfRenderer {
  private movie: SwfMovie;
  private stageEl: HTMLElement;
  private timeline: gsap.core.Timeline;
  private displayList = new Map<number, DisplayEntry>();
  private lastRenderedTick = -1;
  private lastRenderedFrame = -1;
  private spriteTimelineRequirementCache = new Map<number, boolean>();
  private spriteLabelFrameCache = new Map<number, Map<string, number>>();
  private spriteTimelineStateCache = new Map<string, TimelineState[]>();
  private movieTimelineStateCache: MovieTimelineState[] = [];
  private movieBindingCache = new Map<number, Map<number, DisplayBinding>>();
  private moviePlaybackOverridesByName = new Map<string, SpritePlaybackState>();
  private hiddenCharacterIds: Set<number>;
  private postLayoutSyncId: number | null = null;

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
    const tick = Math.min(
      Math.floor(this.timeline.time() * this.movie.frameRate),
      this.movie.frameCount - 1
    );
    if (tick !== this.lastRenderedTick) {
      const frame = this.renderFrame(tick);
      this.onFrameChange?.(frame);
    }
  }

  private renderFrame(targetTick: number): number {
    if (targetTick === this.lastRenderedTick) return this.lastRenderedFrame >= 0 ? this.lastRenderedFrame : 0;

    const movieState = this.getMovieTimelineState(targetTick);
    const nextDisplayList = this.buildMovieDisplayList(movieState.currentFrame, movieState.playbackOverridesByName);

    this.clearStage();
    this.displayList = nextDisplayList;

    const orderedEntries = Array.from(this.displayList.values()).sort((a, b) => a.depth - b.depth);
    for (const entry of orderedEntries) {
      this.stageEl.appendChild(entry.element);
    }

    this.updateDisplay(targetTick, movieState.currentFrame);
    this.lastRenderedTick = targetTick;
    this.lastRenderedFrame = movieState.currentFrame;
    this.schedulePostLayoutDisplaySync(targetTick, movieState.currentFrame);
    return movieState.currentFrame;
  }

  private updateDisplay(currentTick: number, currentFrame: number) {
    this.updateDisplayList(this.displayList, currentTick, currentFrame);
  }

  private schedulePostLayoutDisplaySync(expectedTick: number, expectedFrame: number) {
    if (this.postLayoutSyncId !== null) {
      cancelAnimationFrame(this.postLayoutSyncId);
    }

    this.postLayoutSyncId = requestAnimationFrame(() => {
      this.postLayoutSyncId = null;
      if (this.lastRenderedTick !== expectedTick || this.lastRenderedFrame !== expectedFrame) {
        return;
      }
      this.updateDisplayList(this.displayList, expectedTick, expectedFrame, true);
    });
  }

  private updateDisplayList(
    displayList: Map<number, DisplayEntry>,
    currentTick: number,
    currentRawFrame: number,
    forceSpriteRerender = false,
  ) {
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
        this.syncSpriteDisplay(entry, char, currentTick, currentRawFrame, forceSpriteRerender);
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
    const targetSvgs = this.getOwnedSvgTargets(entry.element);
    if (!targetSvgs.length) return;

    const maskTarget = maskEntry?.element
      ? this.getOwnedSvgTargets(maskEntry.element)[0] ?? this.getDescendantSvgTargets(maskEntry.element)[0]
      : undefined;

    targetSvgs.forEach(({ svg: targetSvg, group: targetGroup }, index) => {
      const clipId = `swf-clip-${depth}-${index}`;

      if (!maskTarget) {
        targetGroup.removeAttribute('clip-path');
        targetSvg.querySelector(`#${clipId}`)?.remove();
        return;
      }

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
      const maskCtm = maskTarget.group.getScreenCTM();
      if (!targetCtm || !maskCtm) return;

      const rel = targetCtm.inverse().multiply(maskCtm);
      const transformedMaskGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      transformedMaskGroup.setAttribute(
        'transform',
        `matrix(${rel.a}, ${rel.b}, ${rel.c}, ${rel.d}, ${rel.e}, ${rel.f})`
      );

      const maskClone = maskTarget.group.cloneNode(true) as SVGGElement;
      maskClone.removeAttribute('transform');
      transformedMaskGroup.appendChild(maskClone);

      clipPathEl.appendChild(transformedMaskGroup);
      targetGroup.setAttribute('clip-path', `url(#${clipId})`);
    });
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
    const svgTargets = this.getDescendantSvgTargets(entry.element);

    if (!ct) {
      entry.element.style.opacity = '1';
      svgTargets.forEach(({ svg, group }, index) => {
        group.removeAttribute('filter');
        svg.querySelector(`#swf-color-${depth}-${index}`)?.remove();
      });
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

    if (!svgTargets.length || !needsFilter) {
      entry.element.style.opacity = String(Math.max(0, Math.min(1, am)));
      svgTargets.forEach(({ svg, group }, index) => {
        group.removeAttribute('filter');
        svg.querySelector(`#swf-color-${depth}-${index}`)?.remove();
      });
      return;
    }

    entry.element.style.opacity = '1';

    svgTargets.forEach(({ svg, group }, index) => {
      let defs = svg.querySelector('defs');
      if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        svg.insertBefore(defs, svg.firstChild);
      }

      const filterId = `swf-color-${depth}-${index}`;
      let filterEl = svg.querySelector(`#${filterId}`) as SVGFilterElement | null;
      if (!filterEl) {
        filterEl = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
        filterEl.setAttribute('id', filterId);
        defs.appendChild(filterEl);
      }

      filterEl.innerHTML = `<feColorMatrix type="matrix" values="${rm} 0 0 0 ${ra} 0 ${gm} 0 0 ${ga} 0 0 ${bm} 0 ${ba} 0 0 0 ${am} ${aa}"/>`;
      group.setAttribute('filter', `url(#${filterId})`);
    });
  }

  private getDescendantSvgTargets(element: HTMLElement): Array<{ svg: SVGSVGElement; group: SVGGElement }> {
    return Array.from(element.querySelectorAll('svg'))
      .map((svg) => {
        const group = Array.from(svg.children).find((child) => {
          return child instanceof SVGGElement && child.classList.contains('swf-content');
        }) as SVGGElement | undefined;
        if (!group) return null;
        return {
          svg: svg as SVGSVGElement,
          group,
        };
      })
      .filter((target): target is { svg: SVGSVGElement; group: SVGGElement } => target !== null);
  }

  private getOwnedSvgTargets(element: HTMLElement): Array<{ svg: SVGSVGElement; group: SVGGElement }> {
    return this.getDescendantSvgTargets(element).filter(({ svg }) => {
      return svg.closest('[data-char-id]') === element;
    });
  }

  private buildMovieDisplayList(
    rawFrame: number,
    playbackOverridesByName: Map<string, SpritePlaybackState>,
  ): Map<number, DisplayEntry> {
    const displayList = new Map<number, DisplayEntry>();
    const lastFrame = Math.max(0, Math.min(rawFrame, Math.max(this.movie.frames.length - 1, 0)));

    for (let frameIndex = 0; frameIndex <= lastFrame; frameIndex++) {
      const frame = this.movie.frames[frameIndex];
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
          if (placement.name) entry.instanceName = placement.name;
          if (placement.characterId !== undefined && placement.characterId !== entry.characterId) {
            entry.element.remove();
            const replacement = this.createElement(placement.characterId, placement.depth);
            if (replacement) {
              entry.element = replacement;
              entry.characterId = placement.characterId;
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

        const element = this.createElement(placement.characterId, placement.depth);
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
          instanceName: placement.name,
          spritePlayback: placement.name ? playbackOverridesByName.get(placement.name) : undefined,
        });
      }
    }

    for (const [, entry] of displayList) {
      if (entry.instanceName) {
        entry.spritePlayback = playbackOverridesByName.get(entry.instanceName);
      }
    }

    return displayList;
  }

  private getMovieBindingState(rawFrame: number): Map<number, DisplayBinding> {
    const clampedFrame = Math.max(0, Math.min(rawFrame, Math.max(this.movie.frames.length - 1, 0)));
    const cached = this.movieBindingCache.get(clampedFrame);
    if (cached) {
      return cached;
    }

    const displayList = new Map<number, DisplayBinding>();

    for (let frameIndex = 0; frameIndex <= clampedFrame; frameIndex++) {
      const frame = this.movie.frames[frameIndex];
      if (!frame) continue;

      for (const depth of frame.removals) {
        displayList.delete(depth);
      }

      for (const placement of frame.placements) {
        if (placement.isUpdate && displayList.has(placement.depth)) {
          const entry = displayList.get(placement.depth)!;
          if (placement.characterId !== undefined) entry.characterId = placement.characterId;
          if (placement.name) entry.instanceName = placement.name;
          if (placement.ratio !== undefined) entry.ratio = placement.ratio;
          continue;
        }

        if (placement.characterId === undefined) continue;

        displayList.set(placement.depth, {
          depth: placement.depth,
          characterId: placement.characterId,
          instanceName: placement.name,
          ratio: placement.ratio,
        });
      }
    }

    this.movieBindingCache.set(clampedFrame, displayList);
    return displayList;
  }

  private createInitialMovieTimelineState(): MovieTimelineState {
    const root: Avm1Object = {};
    const background: Avm1Object = {
      AttractLoopWaitTime: 2000,
      kioskModeWaitTime: 2000,
      kioskModeWaitLong: 5000,
      doKioskMode: true,
      currScene: '',
      VOvol: 100,
      vo: {},
    };
    const nav: Avm1Object = {
      targSection: '',
    };
    const level4: Avm1Object = {};

    root.bkgd = background;
    root.nav = nav;

    const globals = new Map<string, Avm1Value>([
      ['_level0', root],
      ['_root', root],
      ['this', root],
      ['bkgd', background],
      ['nav', nav],
      ['_level4', level4],
    ]);

    return {
      currentFrame: 0,
      isPlaying: true,
      globals,
      playbackOverridesByName: new Map<string, SpritePlaybackState>(),
      timeMarkTick: null,
    };
  }

  private cloneMovieTimelineState(state: MovieTimelineState): MovieTimelineState {
    const globals = new Map<string, Avm1Value>();
    const clonedObjects = new Map<Avm1Object, Avm1Object>();

    const cloneValue = (value: Avm1Value): Avm1Value => {
      if (!value || typeof value !== 'object') {
        return value;
      }

      if (this.isDisplayTarget(value) || this.isAvm1Function(value)) {
        return value;
      }

      const objectValue = value as Avm1Object;
      if (clonedObjects.has(objectValue)) {
        return clonedObjects.get(objectValue)!;
      }

      const clone: Avm1Object = {};
      clonedObjects.set(objectValue, clone);
      for (const [key, member] of Object.entries(objectValue)) {
        clone[key] = cloneValue(member);
      }
      return clone;
    };

    for (const [key, value] of state.globals) {
      globals.set(key, cloneValue(value));
    }

    return {
      currentFrame: state.currentFrame,
      isPlaying: state.isPlaying,
      globals,
      playbackOverridesByName: new Map(state.playbackOverridesByName),
      timeMarkTick: state.timeMarkTick,
    };
  }

  private getMovieTimelineState(elapsedTicks: number): MovieTimelineState {
    const safeTick = Math.max(0, Math.floor(elapsedTicks));

    if (this.movieTimelineStateCache.length === 0) {
      const initialState = this.createInitialMovieTimelineState();
      this.landOnMovieFrame(initialState, 0);
      this.movieTimelineStateCache.push(initialState);
    }

    while (this.movieTimelineStateCache.length <= safeTick) {
      const tick = this.movieTimelineStateCache.length;
      const previous = this.movieTimelineStateCache[tick - 1];
      const next = this.cloneMovieTimelineState(previous);

      if (tick > 0 && next.isPlaying) {
        next.currentFrame = this.clampFrame(next.currentFrame + 1, this.movie.frameCount);
      }

      this.landOnMovieFrame(next, tick);
      this.movieTimelineStateCache.push(next);
    }

    return this.movieTimelineStateCache[safeTick];
  }

  private landOnMovieFrame(state: MovieTimelineState, currentTick: number) {
    const seen = new Set<string>();

    while (true) {
      const marker = [
        state.currentFrame,
        state.isPlaying ? 1 : 0,
        state.timeMarkTick ?? -1,
        this.toAvm1String(this.getAvm1Member(state.globals.get('nav'), 'targSection')),
      ].join(':');
      if (seen.has(marker)) {
        break;
      }
      seen.add(marker);

      const beforeFrame = state.currentFrame;
      this.runActionScripts({
        char: this.movie as unknown as SwfSpriteChar,
        frameIndex: state.currentFrame,
        currentTick,
        timelineState: state,
        displayList: this.getMovieBindingState(state.currentFrame),
        playbackOverridesByName: state.playbackOverridesByName,
        globals: state.globals,
      });

      if (state.currentFrame === beforeFrame) {
        break;
      }
    }
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
    void _depth;
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

  private ensureFontFace(font: SwfFontChar) {
    if (!font.assetUrl || !font.cssFamily || typeof FontFace === 'undefined') {
      return;
    }

    const cacheKey = `${font.cssFamily}::${font.assetUrl}`;
    if (loadedFontFaces.has(cacheKey)) {
      return;
    }

    const fontFace = new FontFace(font.cssFamily, `url("${font.assetUrl}")`, {
      style: font.isItalic ? 'italic' : 'normal',
      weight: font.isBold ? '700' : '400',
    });

    loadedFontFaces.set(cacheKey, fontFace.load()
      .then((loadedFace) => {
        document.fonts.add(loadedFace);
      })
      .catch(() => {
        loadedFontFaces.delete(cacheKey);
      }));
  }

  private createTextElement(char: SwfTextChar, _depth?: number): HTMLElement {
    void _depth;
    const wrapper = document.createElement('div');
    wrapper.className = 'swf-text';
    wrapper.dataset.charId = String(char.id);
    wrapper.dataset.offsetX = String(-char.bounds.xMin);
    wrapper.dataset.offsetY = String(-char.bounds.yMin);
    wrapper.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;';
    wrapper.style.transformOrigin = `${-char.bounds.xMin}px ${-char.bounds.yMin}px`;

    const font = this.movie.characters.get(char.fontId);
    const fontName = font?.type === 'font'
      ? (font.cssFamily ?? font.fontName)
      : 'Arial';
    const fontWeight = font?.type === 'font' && font.isBold ? 'bold' : 'normal';
    const fontStyle = font?.type === 'font' && font.isItalic ? 'italic' : 'normal';
    if (font?.type === 'font') {
      this.ensureFontFace(font);
    }
    const boundsWidth = char.bounds.xMax - char.bounds.xMin;
    const boundsHeight = char.bounds.yMax - char.bounds.yMin;
    const lineHeight = Math.max(char.fontSize + char.leading, char.fontSize);

    const text = document.createElement('div');
    text.textContent = char.text;
    text.style.cssText = `
      color: ${char.color};
      font-size: ${char.fontSize}px;
      font-family: '${fontName}', 'Franklin Gothic Medium', 'Trebuchet MS', Arial, sans-serif;
      font-weight: ${fontWeight};
      font-style: ${fontStyle};
      text-align: ${['left', 'right', 'center', 'justify'][char.align] || 'left'};
      width: ${boundsWidth}px;
      min-height: ${boundsHeight}px;
      line-height: ${lineHeight}px;
      white-space: ${char.multiline || char.wordWrap ? 'pre-wrap' : 'pre'};
      overflow-wrap: ${char.wordWrap ? 'break-word' : 'normal'};
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      text-rendering: geometricPrecision;
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

  private syncSpriteDisplay(
    entry: DisplayEntry,
    char: SwfSpriteChar,
    currentTick: number,
    currentRawFrame: number,
    forceRerender = false,
  ) {
    if (char.imageUrl && !this.spriteNeedsTimeline(char)) return;

    const effectivePlayback = entry.spritePlayback
      ?? this.getRatioFrameSyncPlayback(char, currentTick, currentRawFrame, entry.ratio);
    const spriteTick = effectivePlayback
      ? this.getSpritePlaybackTickFromOverride(currentTick, effectivePlayback)
      : this.getSpritePlaybackTick(currentRawFrame, entry.placedAtFrame, entry.ratio);
    const rawState = effectivePlayback
      ? this.getSpriteTimelineState(char, spriteTick, effectivePlayback.startFrame, effectivePlayback.isPlaying)
      : this.getSpriteTimelineState(char, spriteTick);
    const rawFrame = rawState.currentFrame;
    const isFirstDomSync = entry.element.dataset.spriteDomSynced !== 'true';
    if (
      !forceRerender &&
      !isFirstDomSync &&
      entry.element.dataset.spriteFrame === String(spriteTick) &&
      entry.element.dataset.spriteRawFrame === String(rawFrame)
    ) {
      return;
    }

    this.renderSpriteContents(entry.element, char, spriteTick, effectivePlayback);
    entry.element.dataset.spriteDomSynced = 'true';
  }

  private renderSpriteContents(
    container: HTMLElement,
    char: SwfSpriteChar,
    spriteTick: number,
    playback?: SpritePlaybackState,
  ) {
    container.innerHTML = '';
    container.dataset.spriteFrame = String(spriteTick);

    const displayList = this.buildSpriteDisplayList(char, spriteTick, playback);
    const rawFrame = playback
      ? this.getSpriteTimelineState(char, spriteTick, playback.startFrame, playback.isPlaying).currentFrame
      : this.getSpriteTimelineState(char, spriteTick).currentFrame;
    container.dataset.spriteRawFrame = String(rawFrame);

    const orderedEntries = Array.from(displayList.values()).sort((a, b) => a.depth - b.depth);
    for (const entry of orderedEntries) {
      container.appendChild(entry.element);
    }
    this.updateDisplayList(displayList, spriteTick, rawFrame);
  }

  private buildSpriteDisplayList(
    char: SwfSpriteChar,
    spriteTick: number,
    playback?: SpritePlaybackState,
  ): Map<number, DisplayEntry> {
    const displayList = new Map<number, DisplayEntry>();
    const playbackOverridesByName = new Map<string, SpritePlaybackState>();
    const lastTick = Math.max(0, Math.floor(spriteTick));
    let previousFrame: number | null = null;

    for (let tick = 0; tick <= lastTick; tick++) {
      const state = playback
        ? this.getSpriteTimelineState(char, tick, playback.startFrame, playback.isPlaying)
        : this.getSpriteTimelineState(char, tick);
      if (previousFrame === state.currentFrame) {
        if (!state.isPlaying) {
          break;
        }
        continue;
      }

      this.rebuildSpriteDisplayListToFrame(char, displayList, state.currentFrame, playbackOverridesByName);
      this.runActionScripts({
        char,
        frameIndex: state.currentFrame,
        displayList,
        playbackOverridesByName,
        currentTick: tick,
      });
      previousFrame = state.currentFrame;

      if (!state.isPlaying) {
        break;
      }
    }

    if (previousFrame === null) {
      this.rebuildSpriteDisplayListToFrame(char, displayList, 0, playbackOverridesByName);
    }

    return displayList;
  }

  private rebuildSpriteDisplayListToFrame(
    char: SwfSpriteChar,
    displayList: Map<number, DisplayEntry>,
    rawFrame: number,
    playbackOverridesByName: Map<string, SpritePlaybackState>,
  ) {
    for (const [, entry] of displayList) {
      entry.element.remove();
    }
    displayList.clear();

    const forceTimelineChildren = this.spriteForcesTimelineChildren(char);
    const lastFrame = Math.max(0, Math.min(rawFrame, Math.max(char.frames.length - 1, 0)));

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
          if (placement.name) entry.instanceName = placement.name;
          if (placement.characterId !== undefined && placement.characterId !== entry.characterId) {
            entry.element.remove();
            const replacement = this.createElement(placement.characterId, placement.depth, 0, forceTimelineChildren);
            if (replacement) {
              entry.element = replacement;
              entry.characterId = placement.characterId;
              entry.ratio = placement.ratio;
              entry.placedAtFrame = frameIndex;
              entry.instanceName = placement.name ?? entry.instanceName;
              entry.spritePlayback = undefined;
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
          instanceName: placement.name,
        });
      }
    }

    const activeNames = new Set<string>();
    for (const [, entry] of displayList) {
      if (!entry.instanceName) {
        entry.spritePlayback = undefined;
        continue;
      }
      activeNames.add(entry.instanceName);
      entry.spritePlayback = playbackOverridesByName.get(entry.instanceName);
    }

    for (const name of Array.from(playbackOverridesByName.keys())) {
      if (!activeNames.has(name)) {
        playbackOverridesByName.delete(name);
      }
    }
  }

  private getSpritePlaybackTick(
    currentRawFrame: number,
    placedAtFrame: number,
    ratio?: number,
  ): number {
    const startFrame = ratio !== undefined ? Math.floor(ratio) : placedAtFrame;
    return Math.max(0, currentRawFrame - startFrame);
  }

  private getSpritePlaybackTickFromOverride(
    currentTick: number,
    playback: SpritePlaybackState,
  ): number {
    return Math.max(0, currentTick - playback.startedAtTick);
  }

  private getRatioFrameSyncPlayback(
    char: SwfSpriteChar,
    currentTick: number,
    currentRawFrame: number,
    ratio?: number,
  ): SpritePlaybackState | undefined {
    if (ratio === undefined || !this.spriteUsesRatioFrameSync(char)) {
      return undefined;
    }

    const syncedFrame = Math.max(0, currentRawFrame - Math.floor(ratio));
    return {
      startFrame: this.clampFrame(syncedFrame, char.frameCount),
      startedAtTick: currentTick,
      isPlaying: true,
    };
  }

  private getSpriteTimelineState(
    char: SwfSpriteChar,
    elapsedTicks: number,
    initialFrame = 0,
    initialPlaying = true,
  ): TimelineState {
    const safeTick = Math.max(0, Math.floor(elapsedTicks));
    const safeInitialFrame = this.clampFrame(initialFrame, char.frameCount);
    const cacheKey = `${char.id}:${safeInitialFrame}:${initialPlaying ? 1 : 0}`;
    let states = this.spriteTimelineStateCache.get(cacheKey);

    if (!states) {
      states = [this.landOnSpriteFrame(char, safeInitialFrame, initialPlaying)];
      this.spriteTimelineStateCache.set(cacheKey, states);
    }

    while (states.length <= safeTick) {
      const previous = states[states.length - 1];
      if (!previous.isPlaying) {
        states.push(previous);
        continue;
      }

      const nextFrame = this.clampFrame(previous.currentFrame + 1, char.frameCount, true);
      states.push(this.landOnSpriteFrame(char, nextFrame, previous.isPlaying));
    }

    return states[safeTick];
  }

  private landOnSpriteFrame(char: SwfSpriteChar, frameIndex: number, isPlaying: boolean): TimelineState {
    const state: TimelineState = {
      currentFrame: this.clampFrame(frameIndex, char.frameCount),
      isPlaying,
    };
    const seen = new Set<string>();

    while (true) {
      const marker = `${state.currentFrame}:${state.isPlaying ? 1 : 0}`;
      if (seen.has(marker)) {
        break;
      }
      seen.add(marker);

      const beforeFrame = state.currentFrame;
      this.runActionScripts({
        char,
        frameIndex: state.currentFrame,
        currentTick: 0,
        timelineState: state,
      });

      if (state.currentFrame === beforeFrame) {
        break;
      }
    }

    return { ...state };
  }

  private runActionScripts(options: {
    char: { frameCount: number; frames: SwfFrame[] };
    frameIndex: number;
    currentTick: number;
    timelineState?: TimelineState | MovieTimelineState;
    displayList?: Map<number, DisplayEntry | DisplayBinding>;
    playbackOverridesByName?: Map<string, SpritePlaybackState>;
    globals?: Map<string, Avm1Value>;
    constantPool?: string[];
  }) {
    const frame = options.char.frames[options.frameIndex];
    if (!frame?.actions.length) return;

    for (const actionBytes of frame.actions) {
      this.executeActionScript(actionBytes, options);
    }
  }

  private executeActionScript(
    bytes: Uint8Array,
    options: {
      char: { frameCount: number; frames: SwfFrame[] };
      frameIndex: number;
      currentTick: number;
      timelineState?: TimelineState | MovieTimelineState;
      displayList?: Map<number, DisplayEntry | DisplayBinding>;
      playbackOverridesByName?: Map<string, SpritePlaybackState>;
      globals?: Map<string, Avm1Value>;
      constantPool?: string[];
      registers?: Avm1Value[];
    },
  ): Avm1Value {
    const stack: Avm1Value[] = [];
    let constantPool = [...(options.constantPool ?? [])];
    const functions = new Map<string, Avm1FunctionDef>();
    const registers: Avm1Value[] = options.registers ?? new Array<Avm1Value>(256).fill(undefined);
    let returnValue: Avm1Value = undefined;
    let pos = 0;

    while (pos < bytes.length) {
      const actionCode = bytes[pos++];
      if (actionCode === 0) break;

      let length = 0;
      if (actionCode >= 0x80) {
        length = bytes[pos] | (bytes[pos + 1] << 8);
        pos += 2;
      }
      const actionStart = pos;
      const actionEnd = actionStart + length;

      switch (actionCode) {
        case 0x06:
          if (options.timelineState) {
            options.timelineState.isPlaying = true;
          }
          break;

        case 0x07:
          if (options.timelineState) {
            options.timelineState.isPlaying = false;
          }
          break;

        case 0x0B: {
          const a = this.toAvm1Number(stack.pop());
          const b = this.toAvm1Number(stack.pop());
          stack.push(b - a);
          break;
        }

        case 0x12:
          stack.push(!this.toAvm1Boolean(stack.pop()));
          break;

        case 0x17:
          stack.pop();
          break;

        case 0x1C: {
          const name = this.toAvm1String(stack.pop());
          stack.push(this.resolveAvm1Variable(name, options.displayList, options.globals));
          break;
        }

        case 0x1D: {
          const value = stack.pop();
          const name = this.toAvm1String(stack.pop());
          this.setAvm1Variable(name, value, options.globals);
          break;
        }

        case 0x22: {
          const propertyIndex = this.toAvm1Number(stack.pop());
          const target = stack.pop();
          stack.push(this.getAvm1Property(target, propertyIndex, options.timelineState?.currentFrame));
          break;
        }

        case 0x52: {
          const methodName = this.toAvm1String(stack.pop());
          const object = stack.pop();
          const argCount = Math.max(0, Math.floor(this.toAvm1Number(stack.pop())));
          const args: Avm1Value[] = [];
          for (let i = 0; i < argCount; i++) {
            args.unshift(stack.pop());
          }
          stack.push(this.callAvm1Method(object, methodName, args, options));
          break;
        }

        case 0x3D: {
          const functionName = this.toAvm1String(stack.pop());
          const argCount = Math.max(0, Math.floor(this.toAvm1Number(stack.pop())));
          const args: Avm1Value[] = [];
          for (let i = 0; i < argCount; i++) {
            args.unshift(stack.pop());
          }
          stack.push(this.callAvm1Function(functionName, args, functions, options));
          break;
        }

        case 0x49: {
          const a = stack.pop();
          const b = stack.pop();
          stack.push(this.avm1Equals(b, a));
          break;
        }

        case 0x4E: {
          const memberName = this.toAvm1String(stack.pop());
          const object = stack.pop();
          stack.push(this.getAvm1Member(object, memberName));
          break;
        }

        case 0x4F: {
          const value = stack.pop();
          const memberName = this.toAvm1String(stack.pop());
          const object = stack.pop();
          this.setAvm1Member(object, memberName, value);
          break;
        }

        case 0x81:
          if (options.timelineState && actionEnd - actionStart >= 2) {
            const targetFrame = bytes[actionStart] | (bytes[actionStart + 1] << 8);
            options.timelineState.currentFrame = this.clampFrame(targetFrame, options.char.frameCount);
          }
          break;

        case 0x88:
          constantPool = this.readConstantPool(bytes.subarray(actionStart, actionEnd));
          break;

        case 0x96:
          this.readPushValues(bytes.subarray(actionStart, actionEnd), constantPool, stack, registers);
          break;

        case 0x99: {
          const offset = new DataView(bytes.buffer, bytes.byteOffset + actionStart, 2).getInt16(0, true);
          pos = actionEnd + offset;
          continue;
        }

        case 0x9B: {
          const parsed = this.readFunctionDefinition(bytes, actionStart, actionEnd, constantPool);
          if (parsed) {
            functions.set(parsed.def.name, parsed.def);
            if (parsed.def.name) {
              this.setAvm1Variable(parsed.def.name, parsed.def, options.globals);
            }
            pos = parsed.nextPos;
            continue;
          }
          break;
        }

        case 0x9D: {
          const offset = new DataView(bytes.buffer, bytes.byteOffset + actionStart, 2).getInt16(0, true);
          if (this.toAvm1Boolean(stack.pop())) {
            pos = actionEnd + offset;
            continue;
          }
          break;
        }

        case 0x9F:
          if (options.timelineState && actionEnd - actionStart >= 1) {
            const flags = bytes[actionStart];
            const target = stack.pop();
            const targetFrame = typeof target === 'string'
              ? this.resolveLabelFrame(options.char, target)
              : Math.max(0, Math.floor(this.toAvm1Number(target) - 1));
            if (targetFrame !== null) {
              options.timelineState.currentFrame = this.clampFrame(targetFrame, options.char.frameCount);
            }
            options.timelineState.isPlaying = (flags & 0x01) !== 0;
          }
          break;

        case 0x04:
          if (options.timelineState) {
            options.timelineState.currentFrame = this.clampFrame(options.timelineState.currentFrame + 1, options.char.frameCount);
            options.timelineState.isPlaying = false;
          }
          break;

        case 0x05:
          if (options.timelineState) {
            options.timelineState.currentFrame = this.clampFrame(options.timelineState.currentFrame - 1, options.char.frameCount);
            options.timelineState.isPlaying = false;
          }
          break;

        case 0x0A: {
          const a = this.avm1ToNumberEcma(stack.pop());
          const b = this.avm1ToNumberEcma(stack.pop());
          stack.push(b + a);
          break;
        }

        case 0x0C: {
          const a = this.avm1ToNumberEcma(stack.pop());
          const b = this.avm1ToNumberEcma(stack.pop());
          stack.push(b * a);
          break;
        }

        case 0x0D: {
          const a = this.avm1ToNumberEcma(stack.pop());
          const b = this.avm1ToNumberEcma(stack.pop());
          stack.push(b / a);
          break;
        }

        case 0x3F: {
          const a = this.avm1ToNumberEcma(stack.pop());
          const b = this.avm1ToNumberEcma(stack.pop());
          stack.push(b % a);
          break;
        }

        case 0x0E: {
          const a = this.toAvm1Number(stack.pop());
          const b = this.toAvm1Number(stack.pop());
          stack.push(b === a);
          break;
        }

        case 0x0F: {
          const a = this.toAvm1Number(stack.pop());
          const b = this.toAvm1Number(stack.pop());
          stack.push(b < a);
          break;
        }

        case 0x10: {
          const a = this.toAvm1Boolean(stack.pop());
          const b = this.toAvm1Boolean(stack.pop());
          stack.push(b && a);
          break;
        }

        case 0x11: {
          const a = this.toAvm1Boolean(stack.pop());
          const b = this.toAvm1Boolean(stack.pop());
          stack.push(b || a);
          break;
        }

        case 0x13: {
          const a = this.toAvm1String(stack.pop());
          const b = this.toAvm1String(stack.pop());
          stack.push(b === a);
          break;
        }

        case 0x14:
          stack.push(this.toAvm1String(stack.pop()).length);
          break;

        case 0x18:
          stack.push(this.avm1ToInt32(stack.pop()));
          break;

        case 0x21: {
          const a = this.toAvm1String(stack.pop());
          const b = this.toAvm1String(stack.pop());
          stack.push(b + a);
          break;
        }

        case 0x23: {
          const value = stack.pop();
          const index = this.toAvm1Number(stack.pop());
          const target = stack.pop();
          this.setAvm1Property(target, index, value);
          break;
        }

        case 0x26:
          console.debug('[AVM1 trace]', this.avm1ToStringEcma(stack.pop()));
          break;

        case 0x29: {
          const a = this.toAvm1String(stack.pop());
          const b = this.toAvm1String(stack.pop());
          stack.push(b < a);
          break;
        }

        case 0x30: {
          const max = this.toAvm1Number(stack.pop());
          stack.push(max > 0 ? Math.floor(Math.random() * max) : 0);
          break;
        }

        case 0x34:
          stack.push(Math.floor(options.currentTick * (1000 / this.movie.frameRate)));
          break;

        case 0x3C: {
          const value = stack.pop();
          const name = this.toAvm1String(stack.pop());
          this.setAvm1Variable(name, value, options.globals);
          break;
        }

        case 0x3E:
          return stack.pop();

        case 0x40: {
          this.toAvm1String(stack.pop());
          const argCount = Math.max(0, Math.floor(this.toAvm1Number(stack.pop())));
          for (let i = 0; i < argCount; i++) stack.pop();
          stack.push({});
          break;
        }

        case 0x41: {
          const name = this.toAvm1String(stack.pop());
          this.setAvm1Variable(name, undefined, options.globals);
          break;
        }

        case 0x42: {
          const count = Math.max(0, Math.floor(this.toAvm1Number(stack.pop())));
          const arr: Avm1Object = { length: count };
          for (let i = 0; i < count; i++) {
            arr[String(i)] = stack.pop();
          }
          stack.push(arr);
          break;
        }

        case 0x43: {
          const count = Math.max(0, Math.floor(this.toAvm1Number(stack.pop())));
          const obj: Avm1Object = {};
          for (let i = 0; i < count; i++) {
            const value = stack.pop();
            const key = this.toAvm1String(stack.pop());
            obj[key] = value;
          }
          stack.push(obj);
          break;
        }

        case 0x44:
          stack.push(this.avm1TypeOf(stack.pop()));
          break;

        case 0x47: {
          const a = stack.pop();
          const b = stack.pop();
          stack.push(this.avm1Add2(b, a));
          break;
        }

        case 0x48: {
          const a = stack.pop();
          const b = stack.pop();
          stack.push(this.avm1Less2(b, a));
          break;
        }

        case 0x4A:
          stack.push(this.avm1ToNumberEcma(stack.pop()));
          break;

        case 0x4B:
          stack.push(this.avm1ToStringEcma(stack.pop()));
          break;

        case 0x4C: {
          const top = stack[stack.length - 1];
          stack.push(top);
          break;
        }

        case 0x4D: {
          const a = stack.pop();
          const b = stack.pop();
          stack.push(a);
          stack.push(b);
          break;
        }

        case 0x50:
          stack.push(this.avm1ToNumberEcma(stack.pop()) + 1);
          break;

        case 0x51:
          stack.push(this.avm1ToNumberEcma(stack.pop()) - 1);
          break;

        case 0x60: {
          const a = this.avm1ToInt32(stack.pop());
          const b = this.avm1ToInt32(stack.pop());
          stack.push(b & a);
          break;
        }

        case 0x61: {
          const a = this.avm1ToInt32(stack.pop());
          const b = this.avm1ToInt32(stack.pop());
          stack.push(b | a);
          break;
        }

        case 0x62: {
          const a = this.avm1ToInt32(stack.pop());
          const b = this.avm1ToInt32(stack.pop());
          stack.push(b ^ a);
          break;
        }

        case 0x63: {
          const a = this.avm1ToInt32(stack.pop()) & 0x1f;
          const b = this.avm1ToInt32(stack.pop());
          stack.push(b << a);
          break;
        }

        case 0x64: {
          const a = this.avm1ToInt32(stack.pop()) & 0x1f;
          const b = this.avm1ToInt32(stack.pop());
          stack.push(b >> a);
          break;
        }

        case 0x65: {
          const a = this.avm1ToInt32(stack.pop()) & 0x1f;
          const b = this.avm1ToUint32(stack.pop());
          stack.push(b >>> a);
          break;
        }

        case 0x66: {
          const a = stack.pop();
          const b = stack.pop();
          stack.push(this.avm1StrictEquals(b, a));
          break;
        }

        case 0x67: {
          const a = stack.pop();
          const b = stack.pop();
          stack.push(this.avm1Less2(a, b));
          break;
        }

        case 0x68: {
          const a = this.toAvm1String(stack.pop());
          const b = this.toAvm1String(stack.pop());
          stack.push(b > a);
          break;
        }

        case 0x87:
          registers[bytes[actionStart]] = stack[stack.length - 1];
          break;

        case 0x8E: {
          const parsed = this.readFunction2Definition(bytes, actionStart, actionEnd, constantPool);
          if (parsed) {
            functions.set(parsed.def.name, parsed.def);
            if (parsed.def.name) {
              this.setAvm1Variable(parsed.def.name, parsed.def, options.globals);
            }
            pos = parsed.nextPos;
            continue;
          }
          break;
        }

        default:
          break;
      }

      pos = actionEnd;
    }

    return returnValue;
  }

  private readConstantPool(bytes: Uint8Array): string[] {
    if (bytes.length < 2) return [];

    const poolSize = bytes[0] | (bytes[1] << 8);
    const pool: string[] = [];
    let pos = 2;

    for (let i = 0; i < poolSize && pos < bytes.length; i++) {
      const end = bytes.indexOf(0, pos);
      if (end === -1) {
        pool.push(this.decodeBytes(bytes.subarray(pos)));
        break;
      }
      pool.push(this.decodeBytes(bytes.subarray(pos, end)));
      pos = end + 1;
    }

    return pool;
  }

  private readPushValues(
    bytes: Uint8Array,
    constantPool: string[],
    stack: Avm1Value[],
    registers: Avm1Value[] = [],
  ) {
    let pos = 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    while (pos < bytes.length) {
      const valueType = bytes[pos++];

      switch (valueType) {
        case 0x00: {
          const end = bytes.indexOf(0, pos);
          if (end === -1) {
            stack.push(this.decodeBytes(bytes.subarray(pos)));
            return;
          }
          stack.push(this.decodeBytes(bytes.subarray(pos, end)));
          pos = end + 1;
          break;
        }

        case 0x01:
          // 32-bit float
          stack.push(view.getFloat32(pos, true));
          pos += 4;
          break;

        case 0x02:
          stack.push(null);
          break;

        case 0x03:
          stack.push(undefined);
          break;

        case 0x04:
          // Register
          stack.push(registers[bytes[pos++]]);
          break;

        case 0x05:
          stack.push(bytes[pos++] !== 0);
          break;

        case 0x06: {
          // 64-bit double, stored as two little-endian 32-bit words in swapped order
          const lo = view.getUint32(pos, true);
          const hi = view.getUint32(pos + 4, true);
          const swapped = new DataView(new ArrayBuffer(8));
          swapped.setUint32(0, hi, true);
          swapped.setUint32(4, lo, true);
          stack.push(swapped.getFloat64(0, true));
          pos += 8;
          break;
        }

        case 0x07:
          stack.push(view.getInt32(pos, true));
          pos += 4;
          break;

        case 0x08:
          stack.push(constantPool[bytes[pos++]] ?? undefined);
          break;

        case 0x09: {
          const index = bytes[pos] | (bytes[pos + 1] << 8);
          stack.push(constantPool[index] ?? undefined);
          pos += 2;
          break;
        }

        default:
          return;
      }
    }
  }

  private readFunctionDefinition(
    bytes: Uint8Array,
    headerStart: number,
    headerEnd: number,
    constantPool: string[],
  ): { def: Avm1FunctionDef; nextPos: number } | null {
    const header = bytes.subarray(headerStart, headerEnd);
    let pos = 0;
    const nameEnd = header.indexOf(0, pos);
    if (nameEnd === -1) return null;

    const name = this.decodeBytes(header.subarray(pos, nameEnd));
    pos = nameEnd + 1;
    if (pos + 2 > header.length) return null;

    const paramCount = header[pos] | (header[pos + 1] << 8);
    pos += 2;

    const params: string[] = [];
    for (let i = 0; i < paramCount && pos < header.length; i++) {
      const end = header.indexOf(0, pos);
      if (end === -1) return null;
      params.push(this.decodeBytes(header.subarray(pos, end)));
      pos = end + 1;
    }

    if (pos + 2 > header.length) return null;
    const codeSize = header[pos] | (header[pos + 1] << 8);

    const bodyStart = headerEnd;
    const bodyEnd = Math.min(bytes.length, bodyStart + codeSize);
    return {
      def: {
        name,
        params,
        body: bytes.subarray(bodyStart, bodyEnd),
        constantPool: [...constantPool],
      },
      nextPos: bodyEnd,
    };
  }

  private getAvm1Property(target: Avm1Value, propertyIndex: number, currentFrame: number | undefined): Avm1Value {
    const name = this.propertyNameByIndex(propertyIndex);

    if ((target === '' || target === null || target === undefined)) {
      if (propertyIndex === 4 && currentFrame !== undefined) {
        return currentFrame + 1;
      }
      return undefined;
    }

    if (this.isDisplayEntry(target)) {
      const m = target.matrix;
      switch (name) {
        case '_x': return m.tx;
        case '_y': return m.ty;
        case '_xscale': return Math.sqrt(m.a * m.a + m.b * m.b) * 100;
        case '_yscale': return Math.sqrt(m.c * m.c + m.d * m.d) * 100;
        case '_rotation': return Math.atan2(m.b, m.a) * 180 / Math.PI;
        case '_alpha': return (target.colorTransform?.am ?? 1) * 100;
        case '_visible': return target.element.style.display !== 'none';
        case '_currentframe': return (currentFrame ?? 0) + 1;
        case '_name': return target.instanceName ?? '';
        default: return undefined;
      }
    }

    if (this.isAvm1Object(target) && name) {
      return (target as Avm1Object)[name];
    }

    return undefined;
  }

  private getAvm1Member(target: Avm1Value, memberName: string): Avm1Value {
    if (!target || typeof target !== 'object' || this.isAvm1Function(target)) {
      return undefined;
    }

    if (this.isDisplayTarget(target)) {
      return undefined;
    }

    return (target as Avm1Object)[memberName];
  }

  private setAvm1Member(target: Avm1Value, memberName: string, value: Avm1Value) {
    if (!target || typeof target !== 'object' || this.isAvm1Function(target)) {
      return;
    }

    if (this.isDisplayTarget(target)) {
      return;
    }

    (target as Avm1Object)[memberName] = value;
  }

  private resolveAvm1Variable(
    name: string,
    displayList?: Map<number, DisplayEntry | DisplayBinding>,
    globals?: Map<string, Avm1Value>,
  ): Avm1Value {
    if (globals?.has(name)) {
      return globals.get(name);
    }

    if (!displayList) return undefined;

    for (const [, entry] of displayList) {
      if (entry.instanceName === name) {
        return entry;
      }
    }

    return undefined;
  }

  private setAvm1Variable(name: string, value: Avm1Value, globals?: Map<string, Avm1Value>) {
    if (!globals) return;
    globals.set(name, value);
  }

  private callAvm1Method(
    object: Avm1Value,
    methodName: string,
    args: Avm1Value[],
    options: {
      char: { frameCount: number; frames: SwfFrame[] };
      currentTick: number;
      timelineState?: TimelineState | MovieTimelineState;
      displayList?: Map<number, DisplayEntry | DisplayBinding>;
      playbackOverridesByName?: Map<string, SpritePlaybackState>;
      globals?: Map<string, Avm1Value>;
    },
  ): Avm1Value {
    if (this.isAvm1Object(object)) {
      return this.callAvm1ObjectMethod(object, methodName, args, options);
    }

    if (!options.playbackOverridesByName || !this.isDisplayTarget(object)) {
      return undefined;
    }

    const entry = object;
    const target = this.movie.characters.get(entry.characterId);
    if (target?.type !== 'sprite') {
      return undefined;
    }

    if (methodName !== 'gotoAndPlay' && methodName !== 'gotoAndStop') {
      return undefined;
    }

    const destination = args[0];
    const targetFrame = typeof destination === 'string'
      ? this.resolveLabelFrame(target, destination)
      : Math.max(0, Math.floor(this.toAvm1Number(destination)));
    if (targetFrame === null) {
      return undefined;
    }

    const playback: SpritePlaybackState = {
      startFrame: this.clampFrame(targetFrame, target.frameCount),
      startedAtTick: options.currentTick,
      isPlaying: methodName === 'gotoAndPlay',
    };
    if ('spritePlayback' in entry) {
      entry.spritePlayback = playback;
    }
    if (entry.instanceName) {
      options.playbackOverridesByName.set(entry.instanceName, playback);
    }

    return undefined;
  }

  private callAvm1ObjectMethod(
    object: Avm1Object,
    methodName: string,
    args: Avm1Value[],
    options: {
      currentTick: number;
      timelineState?: TimelineState | MovieTimelineState;
      globals?: Map<string, Avm1Value>;
    },
  ): Avm1Value {
    const root = options.globals?.get('_level0');
    if (object === root) {
      switch (methodName) {
        case 'gotoAndPlay':
        case 'gotoAndStop': {
          if (options.timelineState) {
            const destination = args[0];
            const targetFrame = typeof destination === 'string'
              ? this.resolveLabelFrame(this.movie, destination)
              : Math.max(0, Math.floor(this.toAvm1Number(destination) - 1));
            if (targetFrame !== null) {
              options.timelineState.currentFrame = this.clampFrame(targetFrame, this.movie.frameCount);
            }
            options.timelineState.isPlaying = methodName === 'gotoAndPlay';
          }
          return undefined;
        }

        case 'setTimeMark':
          if (options.timelineState && this.isMovieTimelineState(options.timelineState)) {
            options.timelineState.timeMarkTick = options.currentTick;
          }
          return undefined;

        case 'timeMarkDone': {
          const waitMs = this.toAvm1Number(args[0]);
          if (!options.timelineState || !this.isMovieTimelineState(options.timelineState)) {
            return false;
          }
          if (options.timelineState.timeMarkTick === null) {
            return false;
          }
          const elapsedMs = (options.currentTick - options.timelineState.timeMarkTick) * (1000 / this.movie.frameRate);
          return elapsedMs >= waitMs;
        }

        case 'sndDonePlaying':
          return true;

        case 'doRelease':
        case 'sceneStarting':
        case 'initMusic':
        case 'markSnd':
        case 'hideInner':
        case 'showInner':
          return undefined;

        default:
          break;
      }
    }

    if (object === options.globals?.get('_level4')) {
      if (methodName === 'gotoAndPlay' || methodName === 'gotoAndStop') {
        return undefined;
      }
    }

    const member = object[methodName];
    if (this.isAvm1Function(member)) {
      return undefined;
    }

    return undefined;
  }

  private callAvm1Function(
    functionName: string,
    args: Avm1Value[],
    functions: Map<string, Avm1FunctionDef>,
    options: {
      char: { frameCount: number; frames: SwfFrame[] };
      frameIndex: number;
      currentTick: number;
      timelineState?: TimelineState | MovieTimelineState;
      displayList?: Map<number, DisplayEntry | DisplayBinding>;
      playbackOverridesByName?: Map<string, SpritePlaybackState>;
      globals?: Map<string, Avm1Value>;
      constantPool?: string[];
    },
  ): Avm1Value {
    const fn = functions.get(functionName) ?? options.globals?.get(functionName);
    if (!this.isAvm1Function(fn)) {
      return undefined;
    }

    const nextGlobals = new Map(options.globals ?? []);
    let registers: Avm1Value[] | undefined;

    if (fn.isFunction2) {
      registers = new Array<Avm1Value>(Math.max(fn.registerCount ?? 4, 4)).fill(undefined);
      const root = options.globals?.get('_level0');
      const flags = fn.flags ?? 0;
      let reg = 1;
      if (flags & 0x01) registers[reg++] = root ?? null; // preload this
      if (flags & 0x04) {
        const argObject: Avm1Object = { length: args.length };
        args.forEach((value, index) => { argObject[String(index)] = value; });
        registers[reg++] = argObject; // preload arguments
      }
      if (flags & 0x10) registers[reg++] = undefined; // preload super
      if (flags & 0x40) registers[reg++] = root ?? null; // preload _root
      if (flags & 0x80) registers[reg++] = root ?? null; // preload _parent
      if (flags & 0x100) registers[reg++] = root ?? null; // preload _global

      fn.params.forEach((param, index) => {
        const targetRegister = fn.paramRegisters?.[index] ?? 0;
        if (targetRegister > 0) {
          registers![targetRegister] = args[index];
        } else {
          nextGlobals.set(param, args[index]);
        }
      });
    } else {
      fn.params.forEach((param, index) => {
        nextGlobals.set(param, args[index]);
      });
    }

    return this.executeActionScript(fn.body, {
      ...options,
      constantPool: fn.constantPool,
      globals: nextGlobals,
      registers,
    });
  }

  private assignAvm1Global(globals: Map<string, Avm1Value>, path: string, value: Avm1Primitive) {
    const segments = path.split('.').filter(Boolean);
    if (segments.length === 0) return;

    if (segments.length === 1) {
      globals.set(segments[0], value);
      return;
    }

    const [rootName, ...memberPath] = segments;
    let target = globals.get(rootName);
    if (!this.isAvm1Object(target)) {
      target = {};
      globals.set(rootName, target);
    }

    let objectTarget = target as Avm1Object;
    for (const segment of memberPath.slice(0, -1)) {
      const next = objectTarget[segment];
      if (!this.isAvm1Object(next)) {
        objectTarget[segment] = {};
      }
      objectTarget = objectTarget[segment] as Avm1Object;
    }

    objectTarget[memberPath[memberPath.length - 1]] = value;
  }

  private avm1Equals(a: Avm1Value, b: Avm1Value): boolean {
    if (typeof a === 'number' || typeof b === 'number') {
      return this.toAvm1Number(a) === this.toAvm1Number(b);
    }
    return this.toAvm1String(a) === this.toAvm1String(b);
  }

  /** ECMA-style ToNumber: undefined -> NaN, invalid strings -> NaN. */
  private avm1ToNumberEcma(value: Avm1Value): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === null) return 0;
    if (value === undefined) return NaN;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') return 0;
      const parsed = Number(trimmed);
      return Number.isNaN(parsed) ? NaN : parsed;
    }
    return NaN;
  }

  private avm1ToStringEcma(value: Avm1Value): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (this.isDisplayTarget(value)) return value.instanceName ?? '[object MovieClip]';
    if (this.isAvm1Function(value)) return '[type Function]';
    return '[object Object]';
  }

  private avm1ToInt32(value: Avm1Value): number {
    const n = this.avm1ToNumberEcma(value);
    return Number.isFinite(n) ? n | 0 : 0;
  }

  private avm1ToUint32(value: Avm1Value): number {
    const n = this.avm1ToNumberEcma(value);
    return Number.isFinite(n) ? n >>> 0 : 0;
  }

  private avm1TypeOf(value: Avm1Value): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'string') return 'string';
    if (typeof value === 'boolean') return 'boolean';
    if (this.isDisplayTarget(value)) return 'movieclip';
    if (this.isAvm1Function(value)) return 'function';
    return 'object';
  }

  /** ECMA "+" semantics: string concat when either operand is a string. */
  private avm1Add2(a: Avm1Value, b: Avm1Value): Avm1Value {
    if (typeof a === 'string' || typeof b === 'string') {
      return this.avm1ToStringEcma(a) + this.avm1ToStringEcma(b);
    }
    return this.avm1ToNumberEcma(a) + this.avm1ToNumberEcma(b);
  }

  /** ECMA abstract relational comparison (a < b). */
  private avm1Less2(a: Avm1Value, b: Avm1Value): boolean {
    if (typeof a === 'string' && typeof b === 'string') {
      return a < b;
    }
    const na = this.avm1ToNumberEcma(a);
    const nb = this.avm1ToNumberEcma(b);
    if (Number.isNaN(na) || Number.isNaN(nb)) return false;
    return na < nb;
  }

  private avm1StrictEquals(a: Avm1Value, b: Avm1Value): boolean {
    if (typeof a !== typeof b) return false;
    return a === b;
  }

  private propertyNameByIndex(index: number): string | null {
    const names = [
      '_x', '_y', '_xscale', '_yscale', '_currentframe', '_totalframes',
      '_alpha', '_visible', '_width', '_height', '_rotation', '_target',
      '_framesloaded', '_name', '_droptarget', '_url', '_highquality',
      '_focusrect', '_soundbuftime', '_quality', '_xmouse', '_ymouse',
    ];
    return names[Math.floor(index)] ?? null;
  }

  private isDisplayEntry(value: Avm1Value): value is DisplayEntry {
    return Boolean(value && typeof value === 'object' && 'matrix' in value && 'element' in value);
  }

  private setAvm1Property(target: Avm1Value, index: number, value: Avm1Value) {
    const name = this.propertyNameByIndex(index);
    if (!name) return;

    if (this.isDisplayEntry(target)) {
      const matrix = target.matrix;
      switch (name) {
        case '_x':
          target.matrix = { ...matrix, tx: this.toAvm1Number(value) };
          this.applyPlacementTransform(target.element, target.matrix);
          break;
        case '_y':
          target.matrix = { ...matrix, ty: this.toAvm1Number(value) };
          this.applyPlacementTransform(target.element, target.matrix);
          break;
        case '_alpha': {
          const alpha = Math.max(0, Math.min(1, this.toAvm1Number(value) / 100));
          target.colorTransform = { ...(target.colorTransform ?? { rm: 1, gm: 1, bm: 1, am: 1, ra: 0, ga: 0, ba: 0, aa: 0 }), am: alpha };
          target.element.style.opacity = String(alpha);
          break;
        }
        case '_visible':
          target.element.style.display = this.toAvm1Boolean(value) ? '' : 'none';
          break;
        default:
          break;
      }
      return;
    }

    if (this.isAvm1Object(target)) {
      (target as Avm1Object)[name] = value as Avm1Value;
    }
  }

  private readFunction2Definition(
    bytes: Uint8Array,
    headerStart: number,
    headerEnd: number,
    constantPool: string[],
  ): { def: Avm1FunctionDef; nextPos: number } | null {
    const header = bytes.subarray(headerStart, headerEnd);
    let pos = 0;
    const nameEnd = header.indexOf(0, pos);
    if (nameEnd === -1) return null;

    const name = this.decodeBytes(header.subarray(pos, nameEnd));
    pos = nameEnd + 1;
    if (pos + 5 > header.length) return null;

    const paramCount = header[pos] | (header[pos + 1] << 8);
    pos += 2;
    const registerCount = header[pos];
    pos += 1;
    const flags = header[pos] | (header[pos + 1] << 8);
    pos += 2;

    const params: string[] = [];
    const paramRegisters: number[] = [];
    for (let i = 0; i < paramCount && pos < header.length; i++) {
      const register = header[pos];
      pos += 1;
      const end = header.indexOf(0, pos);
      if (end === -1) return null;
      params.push(this.decodeBytes(header.subarray(pos, end)));
      paramRegisters.push(register);
      pos = end + 1;
    }

    if (pos + 2 > header.length) return null;
    const codeSize = header[pos] | (header[pos + 1] << 8);

    const bodyStart = headerEnd;
    const bodyEnd = Math.min(bytes.length, bodyStart + codeSize);
    return {
      def: {
        name,
        params,
        body: bytes.subarray(bodyStart, bodyEnd),
        constantPool: [...constantPool],
        isFunction2: true,
        registerCount,
        paramRegisters,
        flags,
      },
      nextPos: bodyEnd,
    };
  }

  private resolveLabelFrame(char: { frames: SwfFrame[]; id?: number }, label: string): number | null {
    const cacheKey = char.id;
    let labels = cacheKey !== undefined ? this.spriteLabelFrameCache.get(cacheKey) : undefined;
    if (!labels) {
      labels = new Map<string, number>();
      char.frames.forEach((frame, index) => {
        frame.labels.forEach((frameLabel) => {
          if (!labels!.has(frameLabel)) {
            labels!.set(frameLabel, index);
          }
        });
      });
      if (cacheKey !== undefined) {
        this.spriteLabelFrameCache.set(cacheKey, labels);
      }
    }

    return labels.get(label) ?? null;
  }

  private clampFrame(frame: number, frameCount: number, wrap = false): number {
    if (frameCount <= 0) return 0;
    if (wrap) {
      return ((frame % frameCount) + frameCount) % frameCount;
    }
    return Math.max(0, Math.min(frame, frameCount - 1));
  }

  private toAvm1Boolean(value: Avm1Value): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return value.length > 0;
    return Boolean(value);
  }

  private toAvm1Number(value: Avm1Value): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private toAvm1String(value: Avm1Value): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return '';
  }

  private decodeBytes(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
  }

  private isDisplayTarget(value: Avm1Value): value is DisplayEntry | DisplayBinding {
    return Boolean(value && typeof value === 'object' && 'characterId' in value && 'depth' in value);
  }

  private isAvm1Function(value: Avm1Value): value is Avm1FunctionDef {
    return Boolean(value && typeof value === 'object' && 'body' in value && 'params' in value);
  }

  private isAvm1Object(value: Avm1Value): value is Avm1Object {
    return Boolean(value && typeof value === 'object' && !this.isDisplayTarget(value) && !this.isAvm1Function(value));
  }

  private isMovieTimelineState(state: TimelineState | MovieTimelineState): state is MovieTimelineState {
    return 'globals' in state;
  }

  private spriteForcesTimelineChildren(char: SwfSpriteChar): boolean {
    return [124, 131, 137, 144, 153, 159].includes(char.id);
  }

  private spriteUsesRatioFrameSync(char: SwfSpriteChar): boolean {
    return [104, 105, 106, 110, 115].includes(char.id);
  }

  private spriteNeedsTimeline(char: SwfSpriteChar, visiting = new Set<number>()): boolean {
    const cached = this.spriteTimelineRequirementCache.get(char.id);
    if (cached !== undefined) {
      return cached;
    }

    const hasAnimatedFrames = char.frames.some((frame, frameIndex) => {
      if (frameIndex === 0) return false;
      return frame.placements.length > 0 || frame.removals.length > 0;
    });

    if (char.id === 146 || hasAnimatedFrames) {
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
    if (svg.getAttribute('data-swf-use-bounds-offset') === 'true') {
      return fallback;
    }

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
    if (this.postLayoutSyncId !== null) {
      cancelAnimationFrame(this.postLayoutSyncId);
      this.postLayoutSyncId = null;
    }

    for (const [, entry] of this.displayList) {
      entry.element.remove();
    }
    this.displayList.clear();
    this.moviePlaybackOverridesByName.clear();
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
    if (this.lastRenderedTick >= this.totalFrames - 1) {
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
    const visibleFrame = this.renderFrame(clamped);
    this.timeline.time(clamped / this.movie.frameRate, true);
    this.onFrameChange?.(visibleFrame);
  }

  restart() {
    this.clearStage();
    this.lastRenderedTick = -1;
    this.lastRenderedFrame = -1;
    this.movieTimelineStateCache = [];
    this.timeline.time(0, true);
    this.timeline.pause();
    const frame = this.renderFrame(0);
    this.onFrameChange?.(frame);
    this.onPlaybackChange?.(false);
  }

  destroy() {
    this.timeline.kill();
    this.clearStage();
    this.onPlaybackChange?.(false);
  }

  bootstrapMovie(options: {
    tick?: number;
    globals?: Array<{ path: string; value: Avm1Primitive }>;
    functionName?: string;
  }) {
    const tick = Math.max(0, Math.floor(options.tick ?? 0));
    const baseState = this.cloneMovieTimelineState(this.getMovieTimelineState(tick));

    for (const assignment of options.globals ?? []) {
      this.assignAvm1Global(baseState.globals, assignment.path, assignment.value);
    }

    if (options.functionName) {
      this.callAvm1Function(options.functionName, [], new Map(), {
        char: this.movie as unknown as { frameCount: number; frames: SwfFrame[] },
        frameIndex: baseState.currentFrame,
        currentTick: tick,
        timelineState: baseState,
        displayList: this.getMovieBindingState(baseState.currentFrame),
        playbackOverridesByName: baseState.playbackOverridesByName,
        globals: baseState.globals,
      });
    }

    this.landOnMovieFrame(baseState, tick);
    this.movieTimelineStateCache = this.movieTimelineStateCache.slice(0, tick);
    this.movieTimelineStateCache.push(baseState);
    this.lastRenderedTick = -1;
    this.lastRenderedFrame = -1;
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
