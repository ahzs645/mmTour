// Sound library discovery (sprite + root attachSound/playVO mp3s).

import { ctx } from "./extractContext.mjs";
import { listDir, walkFiles } from "./fileUtils.mjs";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseSwf, swf } from "swf-parser";

export function discoverSoundLibrary() {
  const sounds = {};
  const durations = soundDurationsForScene(ctx.scene);
  for (const file of listDir("sounds")) {
    if (!/\.(mp3|wav|flv)$/i.test(file)) continue;
    const name = basename(file).replace(/^[+-]?\d+_/, "").replace(/\.[^.]+$/, "");
    if (!name || name === "-1") continue;
    const id = soundIdFromFile(file);
    sounds[name] = {
      name,
      src: `generated/${ctx.scene}/sounds/${file}`,
      ...durationField(durations.get(id)),
    };
  }
  return sounds;
}

export function discoverRootSoundLibrary() {
  const sounds = {};
  const rootSoundsDir = join(ctx.root, "extracted", "A-tour", "sounds");
  if (!existsSync(rootSoundsDir)) return sounds;
  const durations = soundDurationsForScene("A-tour");

  for (const filePath of walkFiles(rootSoundsDir)) {
    if (!/\.(mp3|wav|flv)$/i.test(filePath)) continue;
    const file = basename(filePath);
    const name = file.replace(/^[+-]?\d+_/, "").replace(/\.[^.]+$/, "");
    if (!name || name === "-1") continue;
    const id = soundIdFromFile(file);
    sounds[name] = {
      name,
      src: `generated/A-tour/sounds/${file}`,
      ...durationField(durations.get(id)),
    };
  }
  return sounds;
}

function soundDurationsForScene(scene) {
  const swfPath = join(ctx.root, "public", `${scene}.swf`);
  if (!existsSync(swfPath)) return new Map();
  try {
    const movie = parseSwf(new Uint8Array(readFileSync(swfPath)));
    return new Map(
      movie.tags
        .filter((tag) => tag.type === swf.TagType.DefineSound)
        .map((tag) => [Number(tag.id), soundDurationMs(tag)])
        .filter(([, duration]) => duration !== undefined),
    );
  } catch {
    return new Map();
  }
}

function soundIdFromFile(file) {
  const match = basename(file).match(/^([+-]?\d+)_/);
  return match ? Number(match[1]) : undefined;
}

function durationField(durationMs) {
  return durationMs === undefined ? {} : { durationMs };
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
