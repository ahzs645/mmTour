import { gsap } from "gsap";

type Matrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
};

type TimelineAsset = {
  id: number;
  kind: "shape" | "sprite" | "image" | "text" | "button" | "font" | "sound";
  src?: string;
  frames?: string[];
  states?: Record<string, { src: string; origin: TimelineAsset["origin"] }>;
  origin: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type TimelineFrame = {
  index: number;
  label?: string;
  instances: Array<{
    depth: number;
    characterId: number;
    placedFrame: number;
    matrix: Matrix;
    opacity: number;
    name: string;
    clipDepth?: number;
    colorTransform?: {
      rm?: number;
      gm?: number;
      bm?: number;
      am?: number;
      ra?: number;
      ga?: number;
      ba?: number;
      aa?: number;
    };
  }>;
};

type AssetTimeline = {
  scene: string;
  fps: number;
  frames: TimelineFrame[];
  assets: Record<string, TimelineAsset>;
  labels?: Record<string, number>;
  control?: {
    stopFrames?: number[];
    spriteStopFrames?: Record<string, number[]>;
  };
};

type DisplayEntry = {
  key: string;
  element: HTMLDivElement;
  media: HTMLElement;
  characterId: number;
};

export type GsapDisplayDebugEntry = {
  depth: number;
  characterId: number;
  kind: TimelineAsset["kind"];
  name: string;
  placedFrame: number;
  spriteFrame?: number;
  clipDepth?: number;
  isMask: boolean;
  clippedBy?: number;
  opacity: number;
  src: string;
};

export class GsapDisplayListRenderer {
  private layer: HTMLDivElement;
  private entries = new Map<number, DisplayEntry>();
  private scene = "";
  private currentDebugEntries: GsapDisplayDebugEntry[] = [];

  constructor(layer: HTMLDivElement) {
    this.layer = layer;
  }

  clear() {
    this.entries.clear();
    this.scene = "";
    this.currentDebugEntries = [];
    this.layer.replaceChildren();
  }

  renderFrame(assetTimeline: AssetTimeline, frameIndex: number) {
    if (this.scene !== assetTimeline.scene) {
      this.clear();
      this.scene = assetTimeline.scene;
    }

    const frame = assetTimeline.frames[Math.max(0, Math.min(assetTimeline.frames.length - 1, frameIndex))];
    if (!frame) return;

    const liveDepths = new Set<number>();
    const debugEntries: GsapDisplayDebugEntry[] = [];

    for (const instance of frame.instances) {
      const asset = assetTimeline.assets[String(instance.characterId)];
      const resolved = asset ? this.resolveAssetSource(assetTimeline, asset, frame.index, instance.placedFrame) : null;
      const src = resolved?.src ?? "";
      if (!asset || !src) continue;

      liveDepths.add(instance.depth);
      debugEntries.push({
        depth: instance.depth,
        characterId: instance.characterId,
        kind: asset.kind,
        name: instance.name,
        placedFrame: instance.placedFrame,
        spriteFrame: resolved?.spriteFrame,
        clipDepth: instance.clipDepth,
        isMask: Boolean(instance.clipDepth),
        opacity: instance.opacity,
        src,
      });
      const entry = this.ensureEntry(instance.depth, instance.characterId, asset, src);
      if (entry.characterId !== instance.characterId) {
        entry.element.remove();
        this.entries.delete(instance.depth);
        const replacement = this.ensureEntry(instance.depth, instance.characterId, asset, src);
        this.applyInstance(replacement, asset, instance);
        continue;
      }

      if (entry.media instanceof HTMLImageElement && entry.media.dataset.src !== src) {
        entry.media.src = `/${src}`;
        entry.media.dataset.src = src;
      }
      this.applyInstance(entry, asset, instance);
    }

    for (const [depth, entry] of this.entries) {
      if (!liveDepths.has(depth)) {
        entry.element.remove();
        this.entries.delete(depth);
      }
    }

    this.currentDebugEntries = this.markClippedEntries(debugEntries);
  }

  getDebugEntries() {
    return this.currentDebugEntries;
  }

  getFrameLabel(assetTimeline: AssetTimeline, frameIndex: number) {
    const directLabel = assetTimeline.frames[frameIndex]?.label;
    if (directLabel) return directLabel;
    return Object.entries(assetTimeline.labels ?? {}).find(([, frame]) => frame === frameIndex)?.[0] ?? "";
  }

  private resolveAssetSource(assetTimeline: AssetTimeline, asset: TimelineAsset, frameIndex: number, placedFrame: number) {
    if (asset.kind === "sprite" && asset.frames?.length) {
      const relativeFrame = Math.max(0, frameIndex - placedFrame);
      const spriteFrame = this.resolveSpriteFrame(assetTimeline, asset.id, relativeFrame, asset.frames.length);
      return { src: asset.frames[spriteFrame], spriteFrame };
    }

    if (asset.kind === "button" && asset.states?.up?.src) return { src: asset.states.up.src };
    return { src: asset.src ?? "" };
  }

  private resolveSpriteFrame(assetTimeline: AssetTimeline, spriteId: number, relativeFrame: number, frameCount: number) {
    const stopFrames = assetTimeline.control?.spriteStopFrames?.[String(spriteId)] ?? [];
    const firstReachedStop = stopFrames
      .filter((stopFrame) => stopFrame <= relativeFrame)
      .sort((a, b) => b - a)[0];
    if (firstReachedStop !== undefined) return Math.max(0, Math.min(frameCount - 1, firstReachedStop));
    return relativeFrame % frameCount;
  }

  private markClippedEntries(entries: GsapDisplayDebugEntry[]) {
    const masks = entries.filter((entry) => entry.clipDepth !== undefined);
    return entries.map((entry) => {
      const clippingMask = masks.find((mask) => entry.depth > mask.depth && entry.depth <= mask.clipDepth!);
      return clippingMask ? { ...entry, clippedBy: clippingMask.depth } : entry;
    });
  }

  private ensureEntry(depth: number, characterId: number, asset: TimelineAsset, src: string): DisplayEntry {
    const existing = this.entries.get(depth);
    if (existing) return existing;

    const element = document.createElement("div");
    element.className = "gsap-display-entry";
    element.dataset.depth = String(depth);
    element.dataset.characterId = String(characterId);

    const media = this.createMediaElement(asset, src);
    element.append(media);

    this.layer.append(element);

    const entry = { key: `${depth}:${characterId}`, element, media, characterId };
    this.entries.set(depth, entry);
    this.applyAssetBox(entry, asset);
    return entry;
  }

  private applyAssetBox(entry: DisplayEntry, asset: TimelineAsset) {
    const origin = asset.origin;
    gsap.set(entry.media, {
      position: "absolute",
      left: -origin.x,
      top: -origin.y,
      width: origin.width || "auto",
      height: origin.height || "auto",
    });
  }

  private createMediaElement(asset: TimelineAsset, src: string) {
    if (asset.kind === "text" || src.endsWith(".txt")) {
      const text = document.createElement("div");
      text.className = "gsap-display-media gsap-display-text";
      text.dataset.src = src;
      void fetch(`/${src}`)
        .then((response) => (response.ok ? response.text() : ""))
        .then((content) => {
          text.textContent = content.trim();
        });
      return text;
    }

    const image = document.createElement("img");
    image.className = "gsap-display-media";
    image.decoding = "async";
    image.draggable = false;
    image.src = `/${src}`;
    image.dataset.src = src;
    return image;
  }

  private applyInstance(
    entry: DisplayEntry,
    asset: TimelineAsset,
    instance: TimelineFrame["instances"][number],
  ) {
    this.applyAssetBox(entry, asset);
    const { a, b, c, d, tx, ty } = instance.matrix;
    gsap.set(entry.element, {
      zIndex: instance.depth,
      opacity: instance.opacity,
      transform: `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`,
    });
    this.applyColorTransform(entry, instance.colorTransform);
    if (instance.clipDepth !== undefined) {
      entry.element.dataset.clipDepth = String(instance.clipDepth);
    } else {
      delete entry.element.dataset.clipDepth;
    }
  }

  private applyColorTransform(
    entry: DisplayEntry,
    colorTransform: TimelineFrame["instances"][number]["colorTransform"],
  ) {
    if (!colorTransform) {
      entry.media.style.filter = "";
      return;
    }

    const brightness = colorTransform.rm ?? colorTransform.gm ?? colorTransform.bm ?? 1;
    const alpha = colorTransform.am ?? 1;
    const hasAdditive = Boolean(colorTransform.ra || colorTransform.ga || colorTransform.ba);
    entry.media.style.filter = hasAdditive
      ? `brightness(${brightness}) saturate(1.05)`
      : `brightness(${brightness})`;
    entry.media.style.opacity = String(alpha);
  }
}
