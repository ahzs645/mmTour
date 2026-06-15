import type {
  AssetTimeline,
  ButtonActionRecord,
  ControlAction,
  TimelineAsset,
  TimelineFrame,
} from "../data/timelineTypes";
import type { DomRenderer } from "../render/DomRenderer";
import { ClipInstance } from "./ClipInstance";
import { IDENTITY, multiplyMatrix } from "./matrix";
import { Ticker } from "./Ticker";
import { clamp, type RenderNode } from "./types";

export type ButtonEvent = "rollOver" | "rollOut" | "press" | "release";

export type PlayerOptions = {
  onFrame?: (rootFrame: number, playing: boolean) => void;
  onNavigate?: (action: ControlAction) => void;
  onSound?: (action: ControlAction) => void;
};

const ROOT_ID = -1;
const MAX_GOTO_DEPTH = 24;

/**
 * A focused AVM1 display-list runtime. The root timeline and every sprite become
 * ClipInstances with independent playheads; each clip's frame scripts run on
 * entry (stop/play/gotoAndPlay/Stop) with self/_parent/_root resolution. Each
 * frame the tree is flattened to stage-space RenderNodes (matrices composed
 * down), so a sprite plays its own animation and `_root.gotoAndPlay("robust")`
 * drives the root into the section — matching Flash/Ruffle.
 */
export class Player {
  private readonly timeline: AssetTimeline;
  private readonly renderer: DomRenderer;
  private readonly options: PlayerOptions;
  private readonly ticker: Ticker;

  private readonly assets: Record<string, TimelineAsset>;
  private readonly rootFrames: TimelineFrame[];
  private readonly startFrame: number;

  private readonly rootStop: Set<number>;
  private readonly rootActions = new Map<number, ControlAction[]>();
  private readonly spriteActions = new Map<string, ControlAction[]>();
  private readonly spriteStop = new Map<number, Set<number>>();

  private root: ClipInstance;
  private clipByPath = new Map<string, ClipInstance>();
  private lastNodes: RenderNode[] = [];

  constructor(timeline: AssetTimeline, renderer: DomRenderer, options: PlayerOptions = {}) {
    this.timeline = timeline;
    this.renderer = renderer;
    this.options = options;
    this.assets = timeline.assets ?? {};
    this.rootFrames = timeline.frames ?? [];
    this.rootStop = new Set(timeline.control?.stopFrames ?? []);
    this.startFrame = clamp(timeline.entryFrame ?? 0, 0, Math.max(0, this.rootFrames.length - 1));

    // Root frame scripts: array of {frame, actions[]}; keep timeline-scoped only.
    for (const record of timeline.control?.frameActions ?? []) {
      const actions = (record.actions ?? []).filter((a) => !a.executionContext || a.executionContext === "timeline");
      if (actions.length) this.rootActions.set(record.frame, [...(this.rootActions.get(record.frame) ?? []), ...actions]);
    }
    // Per-sprite frame scripts: flat list of {spriteId, frame, actions[]}.
    for (const record of (timeline.control?.spriteActions ?? []) as Array<{ spriteId?: number; frame?: number; actions?: ControlAction[] }>) {
      if (typeof record.spriteId !== "number" || typeof record.frame !== "number") continue;
      const actions = (record.actions ?? []).filter((a) => !a.executionContext || a.executionContext === "timeline");
      if (!actions.length) continue;
      const key = `${record.spriteId}:${record.frame}`;
      this.spriteActions.set(key, [...(this.spriteActions.get(key) ?? []), ...actions]);
    }

    this.ticker = new Ticker(timeline.fps || 20, () => this.onTick());
    this.root = this.buildRoot(this.startFrame);
    this.primeAmbientSound();
    this.render();
  }

  get frameCount(): number {
    return Math.max(1, this.rootFrames.length);
  }

  get currentFrame(): number {
    return this.root.currentFrame;
  }

  get isPlaying(): boolean {
    return this.ticker.isPlaying;
  }

  currentLabel(): string {
    const frame = this.rootFrames[this.root.currentFrame];
    if (frame?.label) return frame.label;
    const labels = this.timeline.labels ?? {};
    return Object.entries(labels).find(([, index]) => index === this.root.currentFrame)?.[0] ?? "";
  }

  debugNodes(): RenderNode[] {
    return this.lastNodes;
  }

  play() {
    this.ticker.play();
  }

  pause() {
    this.ticker.pause();
  }

  toggle() {
    if (this.ticker.isPlaying) this.pause();
    else this.play();
  }

  seekRootFrame(frame: number) {
    this.ticker.pause();
    this.root = this.buildRoot(clamp(frame, 0, this.frameCount - 1));
    this.render();
    this.options.onFrame?.(this.root.currentFrame, false);
  }

  restart() {
    this.seekRootFrame(this.startFrame);
    this.primeAmbientSound();
  }

  destroy() {
    this.ticker.destroy();
    this.renderer.clear();
  }

  /** Dispatch a button event from the owning clip (identified by its tree path). */
  handleButtonEvent(ownerPath: string, characterId: number, event: ButtonEvent) {
    const record = this.timeline.control?.buttonActions?.[String(characterId)] as ButtonActionRecord | undefined;
    const action = record?.[event];
    if (!action) return;
    const owner = this.clipByPath.get(ownerPath) ?? this.root;

    if (action.functionCalls?.length && this.options.onNavigate) this.options.onNavigate(action);
    if (action.command === "gotoAndPlay" || action.command === "gotoAndStop") {
      const target = this.resolveTarget(owner, action.target);
      const frame = this.resolveFrame(action, target);
      if (target && frame >= 0) {
        target.playing = action.command === "gotoAndPlay";
        this.enterFrame(target, frame, 0);
        this.render();
      }
    }
  }

  // --- tree construction ------------------------------------------------

  private buildRoot(frame: number): ClipInstance {
    const root = new ClipInstance(ROOT_ID, "_root", null);
    this.enterFrame(root, frame, 0);
    return root;
  }

  // --- per-frame advance ------------------------------------------------

  private onTick() {
    this.tickClip(this.root);
    this.render();
    this.options.onFrame?.(this.root.currentFrame, this.ticker.isPlaying);
  }

  private tickClip(clip: ClipInstance) {
    const frameCount = this.frameCountFor(clip);
    if (clip.playing && frameCount > 1) {
      const next = clip.currentFrame + 1 >= frameCount ? 0 : clip.currentFrame + 1;
      this.enterFrame(clip, next, 0);
    } else if (clip.enteredFrame < 0) {
      this.enterFrame(clip, clip.currentFrame, 0);
    }
    for (const child of clip.childClips.values()) this.tickClip(child);
  }

  /** Move a clip to a frame: reconcile children, run entry script, apply stops. */
  private enterFrame(clip: ClipInstance, frame: number, depth: number) {
    clip.currentFrame = clamp(frame, 0, Math.max(0, this.frameCountFor(clip) - 1));
    this.reconcile(clip);

    if (clip.enteredFrame !== clip.currentFrame) {
      clip.enteredFrame = clip.currentFrame;
      if (depth < MAX_GOTO_DEPTH) this.runScript(clip, depth);
    }
    if (this.stopFramesFor(clip).has(clip.currentFrame)) clip.playing = false;
  }

  /** Create/prune child clips for the clip's current frame. */
  private reconcile(clip: ClipInstance) {
    const frames = this.framesFor(clip);
    if (!frames) return; // leaf-rendered sprite (baked frames only) — no children
    const instances = frames[clip.currentFrame]?.instances ?? [];

    const live = new Set<number>();
    for (const instance of instances) {
      const asset = this.getAsset(instance.characterId);
      if (!asset || !this.isClipAsset(asset)) continue;
      live.add(instance.depth);
      const existing = clip.childClips.get(instance.depth);
      if (!existing || existing.characterId !== instance.characterId) {
        const child = new ClipInstance(instance.characterId, instance.name, clip);
        clip.childClips.set(instance.depth, child);
        this.enterFrame(child, 0, 0);
      }
    }
    for (const [depth] of clip.childClips) {
      if (!live.has(depth)) clip.childClips.delete(depth);
    }
  }

  private runScript(clip: ClipInstance, depth: number) {
    for (const action of this.actionsFor(clip)) {
      switch (action.command) {
        case "stop":
          clip.playing = false;
          break;
        case "play":
          clip.playing = true;
          break;
        case "gotoAndPlay":
        case "gotoAndStop": {
          const target = this.resolveTarget(clip, action.target);
          const frame = this.resolveFrame(action, target);
          if (!target || frame < 0) break;
          target.playing = action.command === "gotoAndPlay";
          if (target !== clip || frame !== clip.currentFrame) this.enterFrame(target, frame, depth + 1);
          break;
        }
        case "attachSound":
        case "playVO":
        case "stopSound":
          this.options.onSound?.(action);
          break;
        default:
          break;
      }
    }
  }

  // --- target / frame resolution ---------------------------------------

  private resolveTarget(clip: ClipInstance, target: string | undefined): ClipInstance | null {
    if (!target || target === "self" || target === "this") return clip;
    if (target === "_root" || target === "_level0" || target === "root") return this.root;
    if (target === "_parent") return clip.parent ?? clip;

    // Dotted path like "_root.s1.mc" — walk by instance name.
    const parts = target.split(".").filter(Boolean);
    let node: ClipInstance | null =
      parts[0] === "_root" || parts[0] === "_level0" ? this.root : parts[0] === "_parent" ? clip.parent : clip;
    const rest = parts[0]?.startsWith("_") ? parts.slice(1) : parts;
    for (const name of rest) {
      if (!node) return null;
      node = this.findChildByName(node, name);
    }
    return node;
  }

  private findChildByName(clip: ClipInstance, name: string): ClipInstance | null {
    for (const child of clip.childClips.values()) {
      if (child.name === name) return child;
    }
    return null;
  }

  private resolveFrame(action: ControlAction, target: ClipInstance | null): number {
    if (action.label) {
      // Sprite-local label first, then root labels.
      const localFrames = target ? this.framesFor(target) : null;
      const local = localFrames?.findIndex((f) => f.label === action.label) ?? -1;
      if (local >= 0) return local;
      const labels = this.timeline.labels ?? {};
      if (action.label in labels) return labels[action.label];
    }
    if (typeof action.frame === "number") return action.frame;
    return -1;
  }

  // --- timeline data helpers -------------------------------------------

  private framesFor(clip: ClipInstance): TimelineFrame[] | null {
    if (clip.characterId === ROOT_ID) return this.rootFrames;
    return this.assets[String(clip.characterId)]?.timeline ?? null;
  }

  private frameCountFor(clip: ClipInstance): number {
    if (clip.characterId === ROOT_ID) return Math.max(1, this.rootFrames.length);
    const asset = this.assets[String(clip.characterId)];
    return Math.max(1, asset?.timeline?.length ?? asset?.frames?.length ?? 1);
  }

  private stopFramesFor(clip: ClipInstance): Set<number> {
    if (clip.characterId === ROOT_ID) return this.rootStop;
    let set = this.spriteStop.get(clip.characterId);
    if (!set) {
      set = new Set(this.timeline.control?.spriteStopFrames?.[String(clip.characterId)] ?? []);
      this.spriteStop.set(clip.characterId, set);
    }
    return set;
  }

  private actionsFor(clip: ClipInstance): ControlAction[] {
    if (clip.characterId === ROOT_ID) return this.rootActions.get(clip.currentFrame) ?? [];
    return this.spriteActions.get(`${clip.characterId}:${clip.currentFrame}`) ?? [];
  }

  private isClipAsset(asset: TimelineAsset): boolean {
    return asset.kind === "sprite" && Boolean(asset.timeline?.length || asset.frames?.length);
  }

  /** Resolve a placed character; buttons are stored under a `button:<id>` key. */
  private getAsset(characterId: number): TimelineAsset | undefined {
    return this.assets[String(characterId)] ?? this.assets[`button:${characterId}`];
  }

  // --- render (flatten tree to stage-space nodes) ----------------------

  private render() {
    const nodes: RenderNode[] = [];
    this.clipByPath = new Map();
    this.clipByPath.set("0", this.root);
    this.flatten(this.root, IDENTITY, 1, "0", { n: 0 }, nodes);
    this.renderer.apply(nodes);
    this.lastNodes = nodes;
  }

  private flatten(
    clip: ClipInstance,
    world: RenderNode["matrix"],
    worldOpacity: number,
    path: string,
    order: { n: number },
    out: RenderNode[],
  ) {
    const frames = this.framesFor(clip);
    if (!frames) return;
    const frame = frames[clip.currentFrame];
    if (!frame) return;

    for (const instance of frame.instances) {
      const asset = this.getAsset(instance.characterId);
      if (!asset) continue;
      const matrix = multiplyMatrix(world, instance.matrix);
      const opacity = worldOpacity * instance.opacity;
      const key = `${path}/${instance.depth}`;
      const child = clip.childClips.get(instance.depth);

      // Sprite with baked frames → render the composited frame for visual fidelity
      // (FFDec bakes masks/group-alpha the nested leaves would lose), and overlay
      // transparent button hit areas from its nested timeline so it stays
      // interactive and its frame scripts still run (logic lives in the tree).
      if (asset.kind === "sprite" && asset.frames?.length) {
        const frameIndex = child ? clamp(child.currentFrame, 0, asset.frames.length - 1) : 0;
        out.push(this.spriteNode(key, order.n++, asset, asset.frames[frameIndex], matrix, opacity, instance, child?.currentFrame));
        if (child && asset.timeline?.length) this.collectButtons(child, matrix, key, order, out);
        continue;
      }

      // Sprite with only a nested timeline (no baked frames) → render the tree.
      if (asset.kind === "sprite" && asset.timeline?.length && child && child.characterId === asset.id) {
        this.clipByPath.set(key, child);
        this.flatten(child, matrix, opacity, key, order, out);
        continue;
      }

      if (asset.kind === "button") {
        out.push(this.buttonNode(key, order.n++, asset, matrix, instance, path));
        continue;
      }

      out.push(this.leafNode(key, order.n++, asset, asset.src ?? "", matrix, opacity, instance));
    }
  }

  /** Overlay only the transparent button hit areas living inside a baked sprite. */
  private collectButtons(clip: ClipInstance, world: RenderNode["matrix"], path: string, order: { n: number }, out: RenderNode[]) {
    this.clipByPath.set(path, clip);
    const frames = this.framesFor(clip);
    if (!frames) return;
    const frame = frames[clip.currentFrame];
    if (!frame) return;

    for (const instance of frame.instances) {
      const asset = this.getAsset(instance.characterId);
      if (!asset) continue;
      const matrix = multiplyMatrix(world, instance.matrix);
      const key = `${path}/${instance.depth}`;
      if (asset.kind === "button") {
        out.push(this.buttonNode(key, order.n++, asset, matrix, instance, path));
      } else if (asset.kind === "sprite") {
        const child = clip.childClips.get(instance.depth);
        if (child) this.collectButtons(child, matrix, key, order, out);
      }
    }
  }

  private spriteNode(
    key: string,
    order: number,
    asset: TimelineAsset,
    src: string,
    matrix: RenderNode["matrix"],
    opacity: number,
    instance: TimelineFrame["instances"][number],
    spriteFrame?: number,
  ): RenderNode {
    return {
      key,
      order,
      characterId: asset.id,
      kind: asset.kind,
      name: instance.name,
      src,
      origin: asset.origin,
      matrix,
      opacity,
      colorTransform: instance.colorTransform,
      clipDepth: instance.clipDepth,
      spriteFrame,
    };
  }

  /** A transparent, sized hit area over a button (its visual is in the baked sprite frame). */
  private buttonNode(
    key: string,
    order: number,
    asset: TimelineAsset,
    matrix: RenderNode["matrix"],
    instance: TimelineFrame["instances"][number],
    ownerPath: string,
  ): RenderNode {
    return {
      key,
      order,
      characterId: asset.id,
      kind: "button",
      name: instance.name,
      src: "",
      origin: asset.origin,
      matrix,
      opacity: 1,
      buttonOwnerPath: ownerPath,
    };
  }

  private leafNode(
    key: string,
    order: number,
    asset: TimelineAsset,
    src: string,
    matrix: RenderNode["matrix"],
    opacity: number,
    instance: TimelineFrame["instances"][number],
  ): RenderNode {
    return {
      key,
      order,
      characterId: asset.id,
      kind: asset.kind,
      name: instance.name,
      src,
      origin: asset.origin,
      matrix,
      opacity,
      colorTransform: instance.colorTransform,
      clipDepth: instance.clipDepth,
      text: asset.kind === "text" ? this.resolveTextField(asset.id, asset) : undefined,
    };
  }

  private resolveTextField(characterId: number, asset: TimelineAsset) {
    const base = asset.text;
    const dynamic = this.timeline.control?.dynamicTexts?.[String(characterId)];
    if (base && dynamic) return { ...base, ...dynamic };
    return base ?? dynamic;
  }

  // --- ambient sound ----------------------------------------------------

  private primeAmbientSound() {
    if (!this.options.onSound) return;
    let music: ControlAction | undefined;
    for (let frame = 0; frame <= this.root.currentFrame; frame += 1) {
      for (const action of this.rootActions.get(frame) ?? []) {
        if (action.command === "attachSound" && action.soundRole === "music") music = action;
      }
    }
    if (music) this.options.onSound(music);
  }
}
