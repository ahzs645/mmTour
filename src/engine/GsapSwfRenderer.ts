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
import type {
  DisplayEntry, GsapSwfRendererOptions, SpritePlaybackState, TimelineState,
  DisplayBinding, Avm1Object, MovieTimelineState, Avm1FunctionDef, Avm1Primitive, Avm1Value,
} from "./GsapSwfRenderer.types";
import {
  clampFrame, decodeBytes, getAvm1Property, isAvm1Function, isDisplayTarget, isMovieTimelineState,
  resolveAvm1Variable, setAvm1Variable, toAvm1Boolean, toAvm1Number, toAvm1String,
} from "./avm1Values";
import { ensureSvgContentGroup, extractSvgOffset, getDescendantSvgTargets, getElementOffset, makeIdsUnique } from "./svgDom";
import { avm1Equals, readConstantPool, readFunctionDefinition, readPushValues } from "./avm1Bytecode";
import { getSpritePlaybackTick, getSpritePlaybackTickFromOverride, spriteForcesTimelineChildren, spriteUsesRatioFrameSync } from "./spritePlayback";
import { getAvm1Member, isAvm1Object, setAvm1Member, assignAvm1Global } from "./avm1Objects";
import { createImageElement, createShapeElement, ensureFontFace } from "./elementFactory";
import { cloneMovieTimelineState, createInitialMovieTimelineState } from "./movieState";
import { applyColorTransform, getOwnedSvgTargets, getViewportTransform, applyClipping, applyPlacementTransform } from "./svgTransforms";



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
      applyPlacementTransform(el, entry.matrix);

      // Color transform
      applyColorTransform(entry, depth);

      // Keep mask elements in the DOM tree so SVG CTM math stays available.
      if (entry.clipDepth) {
        el.style.display = '';
        el.style.visibility = 'hidden';
        el.style.opacity = '0';
        continue;
      }

      el.style.display = '';
      el.style.visibility = '';

      applyClipping(entry, depth, clipRange?.maskEntry ?? null);
    }
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



  private getMovieTimelineState(elapsedTicks: number): MovieTimelineState {
    const safeTick = Math.max(0, Math.floor(elapsedTicks));

    if (this.movieTimelineStateCache.length === 0) {
      const initialState = createInitialMovieTimelineState();
      this.landOnMovieFrame(initialState, 0);
      this.movieTimelineStateCache.push(initialState);
    }

    while (this.movieTimelineStateCache.length <= safeTick) {
      const tick = this.movieTimelineStateCache.length;
      const previous = this.movieTimelineStateCache[tick - 1];
      const next = cloneMovieTimelineState(previous);

      if (tick > 0 && next.isPlaying) {
        next.currentFrame = clampFrame(next.currentFrame + 1, this.movie.frameCount);
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
        toAvm1String(getAvm1Member(state.globals.get('nav'), 'targSection')),
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
        return createShapeElement(char, depth);
      case 'image':
        return createImageElement(char, depth);
      case 'text':
        return this.createTextElement(char, depth);
      case 'sprite':
        return this.createSpriteElement(char, depth, spriteFrame, forceSpriteTimeline);
      default:
        return null;
    }
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
      ensureFontFace(font);
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
      ? getSpritePlaybackTickFromOverride(currentTick, effectivePlayback)
      : getSpritePlaybackTick(currentRawFrame, entry.placedAtFrame, entry.ratio);
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

    const forceTimelineChildren = spriteForcesTimelineChildren(char);
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



  private getRatioFrameSyncPlayback(
    char: SwfSpriteChar,
    currentTick: number,
    currentRawFrame: number,
    ratio?: number,
  ): SpritePlaybackState | undefined {
    if (ratio === undefined || !spriteUsesRatioFrameSync(char)) {
      return undefined;
    }

    const syncedFrame = Math.max(0, currentRawFrame - Math.floor(ratio));
    return {
      startFrame: clampFrame(syncedFrame, char.frameCount),
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
    const safeInitialFrame = clampFrame(initialFrame, char.frameCount);
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

      const nextFrame = clampFrame(previous.currentFrame + 1, char.frameCount, true);
      states.push(this.landOnSpriteFrame(char, nextFrame, previous.isPlaying));
    }

    return states[safeTick];
  }

  private landOnSpriteFrame(char: SwfSpriteChar, frameIndex: number, isPlaying: boolean): TimelineState {
    const state: TimelineState = {
      currentFrame: clampFrame(frameIndex, char.frameCount),
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
    },
  ) {
    const stack: Avm1Value[] = [];
    let constantPool = [...(options.constantPool ?? [])];
    const functions = new Map<string, Avm1FunctionDef>();
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
          const a = toAvm1Number(stack.pop());
          const b = toAvm1Number(stack.pop());
          stack.push(b - a);
          break;
        }

        case 0x12:
          stack.push(!toAvm1Boolean(stack.pop()));
          break;

        case 0x17:
          stack.pop();
          break;

        case 0x1C: {
          const name = toAvm1String(stack.pop());
          stack.push(resolveAvm1Variable(name, options.displayList, options.globals));
          break;
        }

        case 0x1D: {
          const value = stack.pop();
          const name = toAvm1String(stack.pop());
          setAvm1Variable(name, value, options.globals);
          break;
        }

        case 0x22: {
          const propertyIndex = toAvm1Number(stack.pop());
          const target = stack.pop();
          stack.push(getAvm1Property(target, propertyIndex, options.timelineState?.currentFrame));
          break;
        }

        case 0x52: {
          const methodName = toAvm1String(stack.pop());
          const object = stack.pop();
          const argCount = Math.max(0, Math.floor(toAvm1Number(stack.pop())));
          const args: Avm1Value[] = [];
          for (let i = 0; i < argCount; i++) {
            args.unshift(stack.pop());
          }
          stack.push(this.callAvm1Method(object, methodName, args, options));
          break;
        }

        case 0x3D: {
          const functionName = toAvm1String(stack.pop());
          const argCount = Math.max(0, Math.floor(toAvm1Number(stack.pop())));
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
          stack.push(avm1Equals(b, a));
          break;
        }

        case 0x4E: {
          const memberName = toAvm1String(stack.pop());
          const object = stack.pop();
          stack.push(getAvm1Member(object, memberName));
          break;
        }

        case 0x4F: {
          const value = stack.pop();
          const memberName = toAvm1String(stack.pop());
          const object = stack.pop();
          setAvm1Member(object, memberName, value);
          break;
        }

        case 0x81:
          if (options.timelineState && actionEnd - actionStart >= 2) {
            const targetFrame = bytes[actionStart] | (bytes[actionStart + 1] << 8);
            options.timelineState.currentFrame = clampFrame(targetFrame, options.char.frameCount);
          }
          break;

        case 0x88:
          constantPool = readConstantPool(bytes.subarray(actionStart, actionEnd));
          break;

        case 0x96:
          readPushValues(bytes.subarray(actionStart, actionEnd), constantPool, stack);
          break;

        case 0x99: {
          const offset = new DataView(bytes.buffer, bytes.byteOffset + actionStart, 2).getInt16(0, true);
          pos = actionEnd + offset;
          continue;
        }

        case 0x9B: {
          const parsed = readFunctionDefinition(bytes, actionStart, actionEnd, constantPool);
          if (parsed) {
            functions.set(parsed.def.name, parsed.def);
            if (parsed.def.name) {
              setAvm1Variable(parsed.def.name, parsed.def, options.globals);
            }
            pos = parsed.nextPos;
            continue;
          }
          break;
        }

        case 0x9D: {
          const offset = new DataView(bytes.buffer, bytes.byteOffset + actionStart, 2).getInt16(0, true);
          if (toAvm1Boolean(stack.pop())) {
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
              : Math.max(0, Math.floor(toAvm1Number(target) - 1));
            if (targetFrame !== null) {
              options.timelineState.currentFrame = clampFrame(targetFrame, options.char.frameCount);
            }
            options.timelineState.isPlaying = (flags & 0x01) !== 0;
          }
          break;

        default:
          break;
      }

      pos = actionEnd;
    }
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
    if (isAvm1Object(object)) {
      return this.callAvm1ObjectMethod(object, methodName, args, options);
    }

    if (!options.playbackOverridesByName || !isDisplayTarget(object)) {
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
      : Math.max(0, Math.floor(toAvm1Number(destination)));
    if (targetFrame === null) {
      return undefined;
    }

    const playback: SpritePlaybackState = {
      startFrame: clampFrame(targetFrame, target.frameCount),
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
              : Math.max(0, Math.floor(toAvm1Number(destination) - 1));
            if (targetFrame !== null) {
              options.timelineState.currentFrame = clampFrame(targetFrame, this.movie.frameCount);
            }
            options.timelineState.isPlaying = methodName === 'gotoAndPlay';
          }
          return undefined;
        }

        case 'setTimeMark':
          if (options.timelineState && isMovieTimelineState(options.timelineState)) {
            options.timelineState.timeMarkTick = options.currentTick;
          }
          return undefined;

        case 'timeMarkDone': {
          const waitMs = toAvm1Number(args[0]);
          if (!options.timelineState || !isMovieTimelineState(options.timelineState)) {
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
    if (isAvm1Function(member)) {
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
    if (!isAvm1Function(fn)) {
      return undefined;
    }

    const nextGlobals = new Map(options.globals ?? []);
    fn.params.forEach((param, index) => {
      nextGlobals.set(param, args[index]);
    });

    this.executeActionScript(fn.body, {
      ...options,
      constantPool: fn.constantPool,
      globals: nextGlobals,
    });
    return undefined;
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
    const baseState = cloneMovieTimelineState(this.getMovieTimelineState(tick));

    for (const assignment of options.globals ?? []) {
      assignAvm1Global(baseState.globals, assignment.path, assignment.value);
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
