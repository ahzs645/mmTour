// Sound library discovery (sprite + root attachSound/playVO mp3s).

import { ctx } from "./extractContext.mjs";
import { listDir, walkFiles } from "./fileUtils.mjs";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export function discoverSoundLibrary() {
  const sounds = {};
  for (const file of listDir("sounds")) {
    if (!/\.(mp3|wav|flv)$/i.test(file)) continue;
    const name = basename(file).replace(/^[+-]?\d+_/, "").replace(/\.[^.]+$/, "");
    if (!name || name === "-1") continue;
    sounds[name] = {
      name,
      src: `generated/${ctx.scene}/sounds/${file}`,
    };
  }
  return sounds;
}

export function discoverRootSoundLibrary() {
  const sounds = {};
  const rootSoundsDir = join(ctx.root, "extracted", "A-tour", "sounds");
  if (!existsSync(rootSoundsDir)) return sounds;

  for (const filePath of walkFiles(rootSoundsDir)) {
    if (!/\.(mp3|wav|flv)$/i.test(filePath)) continue;
    const file = basename(filePath);
    const name = file.replace(/^[+-]?\d+_/, "").replace(/\.[^.]+$/, "");
    if (!name || name === "-1") continue;
    sounds[name] = {
      name,
      src: `generated/A-tour/sounds/${file}`,
    };
  }
  return sounds;
}
