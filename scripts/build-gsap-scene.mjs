/**
 * build-gsap-scene.mjs
 *
 * Converts a generated `timeline.json` (per-frame symbol snapshots) into a
 * web-native `gsap-scene.json` describing each symbol instance as a tween
 * track: a compressed list of keyframes that the GSAP scene player turns into
 * real `gsap.to()` segments. This is the "converter" stage that saves the SWF
 * in a non-SWF, GSAP-friendly format so it can be run without Ruffle.
 *
 * Usage: node scripts/build-gsap-scene.mjs [scene ...]
 *   (defaults to all eight bundled scenes)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_SCENES = [
  "A-tour", "intro", "nav",
  "segment1", "segment2", "segment3", "segment4", "segment5",
];
const EPSILON = 1e-4;

const scenes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SCENES;

for (const scene of scenes) {
  const timelinePath = join(root, "public/generated", scene, "timeline.json");
  if (!existsSync(timelinePath)) {
    console.warn(`Skipping ${scene}: missing ${timelinePath}`);
    continue;
  }

  const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));
  const sceneData = buildGsapScene(timeline);
  const outPath = join(root, "public/generated", scene, "gsap-scene.json");
  writeFileSync(outPath, JSON.stringify(sceneData));
  console.log(
    `Wrote ${outPath}: ${sceneData.tracks.length} tracks, ` +
    `${sceneData.tracks.reduce((sum, t) => sum + t.keys.length, 0)} keyframes ` +
    `(from ${timeline.frames.length} frames).`,
  );
}

function buildGsapScene(timeline) {
  const fps = timeline.fps || 15;
  const frames = [...timeline.frames].sort((a, b) => a.index - b.index);
  const assets = timeline.assets || {};
  const spriteStopFrames = timeline.control?.spriteStopFrames || {};
  const buttonByPlacedChar = buildButtonMap(timeline.control?.buttonActions || {});

  // Index every frame's depth -> instance for sequential walking.
  const frameByIndex = new Map(frames.map((frame) => [frame.index, frame]));
  const maxFrame = frames.length ? frames[frames.length - 1].index : 0;

  // Open tracks keyed by depth; close them when the occupant changes/leaves.
  const open = new Map(); // depth -> track-in-progress
  const tracks = [];
  let trackSeq = 0;

  const closeTrack = (depth, deathFrame) => {
    const track = open.get(depth);
    if (!track) return;
    open.delete(depth);
    track.deathFrame = deathFrame;
    tracks.push(finalizeTrack(track, fps, buttonByPlacedChar));
  };

  for (let f = 0; f <= maxFrame; f += 1) {
    const frame = frameByIndex.get(f);
    const present = new Set();
    const instances = frame?.instances ?? [];

    for (const instance of instances) {
      const depth = instance.depth;
      present.add(depth);
      const asset = assets[String(instance.characterId)];
      if (!asset) continue;

      const current = open.get(depth);
      const sameInstance = current
        && current.characterId === instance.characterId
        && current.name === (instance.name ?? "")
        && current.lastFrame === f - 1;

      if (!sameInstance) {
        if (current) closeTrack(depth, f);
        open.set(depth, {
          id: `t${trackSeq++}`,
          depth,
          characterId: instance.characterId,
          name: instance.name ?? "",
          kind: asset.kind,
          origin: asset.origin || { x: 0, y: 0, width: 0, height: 0 },
          birthFrame: f,
          deathFrame: maxFrame + 1,
          placedFrame: instance.placedFrame ?? f,
          samples: [],
        });
      }

      const track = open.get(depth);
      track.lastFrame = f;
      track.samples.push({
        frame: f,
        a: instance.matrix.a,
        b: instance.matrix.b,
        c: instance.matrix.c,
        d: instance.matrix.d,
        tx: instance.matrix.tx,
        ty: instance.matrix.ty,
        opacity: instance.opacity ?? 1,
        clipDepth: instance.clipDepth,
        colorTransform: instance.colorTransform,
        src: resolveMediaSrc(asset, f, track.placedFrame, spriteStopFrames),
      });
    }

    // Close any tracks whose depth vanished this frame.
    for (const depth of [...open.keys()]) {
      if (!present.has(depth)) closeTrack(depth, f);
    }
  }

  for (const depth of [...open.keys()]) {
    closeTrack(depth, maxFrame + 1);
  }

  tracks.sort((a, b) => a.birthFrame - b.birthFrame || a.depth - b.depth);

  return {
    scene: timeline.scene,
    source: timeline.source,
    format: "gsap-scene@1",
    fps,
    frameCount: timeline.frameCount,
    duration: timeline.duration,
    entryFrame: timeline.entryFrame ?? 0,
    stage: {
      width: timeline.dimensions?.width ?? 640,
      height: timeline.dimensions?.height ?? 480,
      background: timeline.backgroundColor ?? "#ffffff",
    },
    labels: timeline.labels ?? {},
    control: {
      stopFrames: timeline.control?.stopFrames ?? [],
      nav: buildNav(timeline.control?.frameActions ?? []),
    },
    tracks,
  };
}

/** Map every placed character (owner sprites + the button id) to its release. */
function buildButtonMap(buttonActions) {
  const map = new Map();
  for (const [buttonId, info] of Object.entries(buttonActions)) {
    const release = info.release;
    if (!release || typeof release.frame !== "number") continue;
    const command = release.command === "gotoAndStop" ? "gotoAndStop" : "gotoAndPlay";
    const entry = { command, target: release.frame, label: release.label };
    const owners = [...(info.ownerSpriteIds ?? []), Number(buttonId)];
    for (const owner of owners) {
      if (!map.has(owner)) map.set(owner, entry);
    }
  }
  return map;
}

/** Timeline-scoped goto actions with a resolved destination frame. */
function buildNav(frameActions) {
  const nav = [];
  for (const frameAction of frameActions) {
    for (const action of frameAction.actions ?? []) {
      const context = action.executionContext;
      if (context && context !== "timeline") continue;
      if (action.supported === false) continue;
      if ((action.command === "gotoAndPlay" || action.command === "gotoAndStop") && typeof action.frame === "number") {
        nav.push({ frame: frameAction.frame, command: action.command, target: action.frame });
      }
    }
  }
  return nav;
}


function resolveMediaSrc(asset, frameIndex, placedFrame, spriteStopFrames) {
  if (asset.kind === "sprite" && asset.frames?.length) {
    const relative = Math.max(0, frameIndex - placedFrame);
    const spriteFrame = resolveSpriteFrame(asset, relative, spriteStopFrames);
    return asset.frames[spriteFrame];
  }
  if (asset.kind === "button" && asset.states?.up?.src) return asset.states.up.src;
  return asset.src ?? "";
}

function resolveSpriteFrame(asset, relativeFrame, spriteStopFrames) {
  const frameCount = asset.frames.length;
  const stops = spriteStopFrames[String(asset.id)] ?? [];
  const reachedStop = stops
    .filter((stop) => stop <= relativeFrame)
    .sort((a, b) => b - a)[0];
  if (reachedStop !== undefined) return Math.max(0, Math.min(frameCount - 1, reachedStop));
  return relativeFrame % frameCount;
}

function finalizeTrack(track, fps, buttonByPlacedChar) {
  const samples = track.samples;
  const keys = compressKeyframes(samples);

  // Discrete media cells: emit a cell whenever the resolved source changes.
  const cells = [];
  let lastSrc = null;
  for (const sample of samples) {
    if (sample.src !== lastSrc) {
      cells.push({ frame: sample.frame, src: sample.src });
      lastSrc = sample.src;
    }
  }

  const isText = track.kind === "text";
  const primarySrc = cells[0]?.src ?? "";
  const release = buttonByPlacedChar.get(track.characterId);

  return {
    id: track.id,
    depth: track.depth,
    characterId: track.characterId,
    name: track.name,
    kind: track.kind,
    origin: track.origin,
    birthFrame: track.birthFrame,
    deathFrame: track.deathFrame,
    birthTime: track.birthFrame / fps,
    deathTime: track.deathFrame / fps,
    textSrc: isText ? primarySrc : undefined,
    // Static media keep one src; sprites carry per-frame cells.
    src: track.kind === "sprite" ? undefined : primarySrc,
    cells: track.kind === "sprite" && cells.length > 1 ? cells : undefined,
    release: release ? { command: release.command, target: release.target, label: release.label } : undefined,
    keys,
  };
}

/**
 * Collapse constant-velocity runs into keyframes. A middle sample is kept only
 * when the per-component delta changes (i.e. the linear tween bends), so linear
 * interpolation between kept keyframes reproduces the original frame data
 * exactly at every integer frame.
 */
function compressKeyframes(samples) {
  if (samples.length <= 2) {
    return samples.map(toKey);
  }

  const kept = [toKey(samples[0])];
  for (let i = 1; i < samples.length - 1; i += 1) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const next = samples[i + 1];
    if (!isLinear(prev, curr, next)) {
      kept.push(toKey(curr));
    }
  }
  kept.push(toKey(samples[samples.length - 1]));
  return kept;
}

function isLinear(prev, curr, next) {
  const span = next.frame - prev.frame;
  if (span <= 0) return false;
  const t = (curr.frame - prev.frame) / span;
  for (const prop of ["a", "b", "c", "d", "tx", "ty", "opacity"]) {
    const interpolated = prev[prop] + (next[prop] - prev[prop]) * t;
    if (Math.abs(interpolated - curr[prop]) > EPSILON) return false;
  }
  // A change in clip depth or color transform also forces a keyframe.
  if ((curr.clipDepth ?? null) !== (prev.clipDepth ?? null)) return false;
  if (JSON.stringify(curr.colorTransform ?? null) !== JSON.stringify(prev.colorTransform ?? null)) return false;
  return true;
}

function toKey(sample) {
  const key = {
    frame: sample.frame,
    a: round(sample.a),
    b: round(sample.b),
    c: round(sample.c),
    d: round(sample.d),
    tx: round(sample.tx),
    ty: round(sample.ty),
    opacity: round(sample.opacity),
  };
  if (sample.clipDepth !== undefined) key.clipDepth = sample.clipDepth;
  if (sample.colorTransform) key.colorTransform = sample.colorTransform;
  return key;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
