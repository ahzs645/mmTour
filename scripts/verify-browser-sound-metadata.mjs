import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSwf, swf } from "swf-parser";
import { extractControl } from "../src/convert/avm1Control.ts";
import { enrichSoundMetadata } from "../src/convert/soundMetadata.ts";
import { collectSounds, extractSound } from "../src/convert/soundExtractor.ts";
import { collectExplicitSoundTimings } from "../src/data/soundTimings.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const scenes = process.argv.slice(2).length
  ? process.argv.slice(2).map((scene) => scene.replace(/\.swf$/i, ""))
  : ["A-tour", "intro", "nav", "segment1", "segment2", "segment3", "segment4", "segment5"];

const failures = [];

for (const scene of scenes) {
  const ffdecTimeline = JSON.parse(readFileSync(join(root, "public/generated", scene, "timeline.json"), "utf8"));
  const movie = parseSwf(new Uint8Array(readFileSync(join(root, "public", `${scene}.swf`))));
  const browserControl = extractControl(movie);
  const soundLibrary = browserSoundLibrary(movie, scene);
  enrichSoundMetadata(browserControl, soundLibrary);

  compareObjects(`${scene}: soundLibrary`, normalizeLibrary(soundLibrary), normalizeLibrary(ffdecTimeline.control?.soundLibrary ?? {}));
  compareObjects(`${scene}: soundTimings`, collectExplicitSoundTimings(browserControl), collectExplicitSoundTimings(ffdecTimeline.control));
  verifyPlayableSoundMetadata(scene, browserControl, soundLibrary);

  const timings = Object.keys(collectExplicitSoundTimings(browserControl)).length;
  const actions = collectSoundEffects(browserControl).length;
  console.log(`${scene}: ${Object.keys(soundLibrary).length} sound(s), ${timings} explicit timing(s), ${actions} sound metadata action(s) verified`);
}

if (failures.length) {
  console.error(`\n${failures.length} browser sound metadata mismatch(es):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

function browserSoundLibrary(movie, scene) {
  const names = soundExportNames(movie);
  const out = {};
  for (const tag of collectSounds(movie)) {
    const name = names.get(Number(tag.id));
    if (!name) continue;
    let ext = "mp3";
    try {
      ext = extractSound(tag).ext;
    } catch {
      // Keep the same best-effort path shape as the browser compiler.
    }
    const lower = name.toLowerCase();
    out[name] = {
      id: tag.id,
      name,
      src: `generated/${scene}/sounds/${tag.id}.${ext}`,
      durationMs: soundDurationMs(tag),
      ...(lower !== name ? { aliases: [lower] } : {}),
    };
  }
  return out;
}

function soundExportNames(movie) {
  const out = new Map();
  const exportAssets = swf.TagType.ExportAssets ?? 35;
  for (const tag of movie.tags) {
    if (tag.type !== exportAssets) continue;
    for (const asset of tag.assets ?? []) {
      if (typeof asset.id === "number" && asset.name) out.set(asset.id, String(asset.name));
    }
  }
  return out;
}

function soundDurationMs(tag) {
  const samples = Number(tag.sampleCount);
  const rate = swfSoundRate(tag.soundRate);
  return Number.isFinite(samples) && samples > 0 && rate > 0 ? (samples / rate) * 1000 : undefined;
}

function swfSoundRate(soundRate) {
  const rates = [5512, 11025, 22050, 44100];
  return soundRate <= 3 ? rates[soundRate] : Number(soundRate) || 0;
}

function verifyPlayableSoundMetadata(scene, control, soundLibrary) {
  const bySrc = new Set(Object.values(soundLibrary).map((entry) => entry.src).filter(Boolean));
  const timings = collectExplicitSoundTimings(control);
  for (const { effect, where } of collectSoundEffects(control)) {
    if (effect.soundSrc && !bySrc.has(effect.soundSrc)) {
      failures.push(`${scene}: ${where} ${effect.command} has soundSrc outside browser library: ${effect.soundSrc}`);
    }

    if (effect.command === "playVO" || effect.command === "attachSound") {
      const resolved = resolveSound(soundLibrary, effect.sound);
      if (!resolved) continue;
      if (!effect.soundSrc) failures.push(`${scene}: ${where} ${effect.command} ${effect.sound} missing soundSrc`);
      if (effect.command === "playVO" && effect.soundDurationMs === undefined) {
        failures.push(`${scene}: ${where} playVO ${effect.sound} missing soundDurationMs`);
      }
    }

    if (effect.command === "markSndSegment") {
      const segment = effect.segment ?? effect.sound;
      const hasTiming = Boolean(segment && (timings[segment] || resolveSegmentBase(soundLibrary, segment)));
      if (hasTiming && effect.soundDurationMs === undefined) {
        failures.push(`${scene}: ${where} markSndSegment ${segment} missing soundDurationMs`);
      }
    }
  }
}

function collectSoundEffects(control) {
  const out = [];
  const scanAction = (action, where) => {
    if (!action) return;
    if (isSoundCommand(action.command)) out.push({ effect: action, where });
    if (action.soundAction) out.push({ effect: action.soundAction, where: `${where}:soundAction` });
  };

  for (const record of control.frameActions ?? []) {
    for (const action of record.actions ?? []) scanAction(action, `frame ${record.frame}`);
  }
  for (const record of control.spriteActions ?? []) {
    for (const action of record.actions ?? []) scanAction(action, `sprite ${record.spriteId} frame ${record.frame}`);
  }
  for (const [key, definition] of Object.entries(control.definedFunctions ?? {})) {
    const name = definition?.functionName ?? key;
    for (const action of definition?.actions ?? []) scanAction(action, `function ${name}`);
  }
  for (const [buttonId, group] of Object.entries(control.buttonActions ?? {})) {
    for (const event of ["press", "release", "rollOver", "rollOut"]) scanAction(group?.[event], `button ${buttonId} ${event}`);
  }
  return out;
}

function isSoundCommand(command) {
  return command === "playVO" || command === "attachSound" || command === "markSndSegment" || command === "stopSound";
}

function resolveSound(soundLibrary, sound) {
  if (!sound) return undefined;
  const direct = soundLibrary[sound] ?? soundLibrary[String(sound).toLowerCase()];
  if (direct) return direct;
  const wanted = String(sound).toLowerCase();
  for (const [name, entry] of Object.entries(soundLibrary)) {
    if (name.toLowerCase() === wanted || entry.name?.toLowerCase() === wanted || entry.aliases?.some((alias) => alias.toLowerCase() === wanted)) {
      return entry;
    }
  }
  return undefined;
}

function resolveSegmentBase(soundLibrary, segment) {
  const match = String(segment ?? "").match(/^(.+\d)([a-z]+)$/i);
  return match ? resolveSound(soundLibrary, match[1]) : undefined;
}

function normalizeLibrary(soundLibrary) {
  return Object.fromEntries(
    Object.entries(soundLibrary)
      .map(([name, entry]) => [name, { name: entry?.name ?? name, durationMs: round(entry?.durationMs) }])
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })),
  );
}

function compareObjects(label, actual, expected) {
  const a = JSON.stringify(sortObject(actual));
  const e = JSON.stringify(sortObject(expected));
  if (a !== e) failures.push(`${label}: expected ${e}, got ${a}`);
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(numeric).map((key) => [key, sortObject(value[key])]));
}

function numeric(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function round(value) {
  return typeof value === "number" ? Math.round(value * 1000) / 1000 : undefined;
}
