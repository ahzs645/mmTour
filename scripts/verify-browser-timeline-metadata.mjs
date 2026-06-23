import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileScene } from "../src/convert/compileScene.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const scenes = process.argv.slice(2).length
  ? process.argv.slice(2).map((scene) => scene.replace(/\.swf$/i, ""))
  : ["A-tour", "intro", "nav", "segment1", "segment2", "segment3", "segment4", "segment5"];

const failures = [];
const summaries = [];

for (const scene of scenes) {
  const ffdecTimeline = JSON.parse(readFileSync(join(root, "public/generated", scene, "timeline.json"), "utf8"));
  const browserTimeline = (await compileScene(new Uint8Array(readFileSync(join(root, "public", `${scene}.swf`))), scene)).timeline;

  verifyDynamicTexts(scene, browserTimeline.control?.dynamicTexts ?? {}, ffdecTimeline.control?.dynamicTexts ?? {});
  const staticTexts = verifyStaticTexts(scene, browserTimeline.assets ?? {}, ffdecTimeline.assets ?? {});
  verifySpriteLocalDefaults(scene, browserTimeline.control?.spriteLocalDefaults ?? {}, ffdecTimeline.control?.spriteLocalDefaults ?? {});
  const overflow = verifyOverflowFlags(scene, browserTimeline, ffdecTimeline);

  summaries.push({
    scene,
    dynamicTexts: {
      required: Object.keys(ffdecTimeline.control?.dynamicTexts ?? {}).length,
      browser: Object.keys(browserTimeline.control?.dynamicTexts ?? {}).length,
    },
    staticTexts,
    spriteLocalDefaults: {
      required: Object.keys(ffdecTimeline.control?.spriteLocalDefaults ?? {}).length,
      browser: Object.keys(browserTimeline.control?.spriteLocalDefaults ?? {}).length,
    },
    overflow,
  });
}

for (const summary of summaries) {
  console.log(
    `${summary.scene}: dynamicText ${summary.dynamicTexts.required}/${summary.dynamicTexts.browser}, `
      + `staticText ${summary.staticTexts.required}/${summary.staticTexts.browser}, `
      + `spriteLocalDefaults ${summary.spriteLocalDefaults.required}/${summary.spriteLocalDefaults.browser}, `
      + `overflow required=${summary.overflow.required} browser=${summary.overflow.browser} ignoredMetadataOnly=${summary.overflow.ignoredMetadataOnly}`,
  );
}

if (failures.length) {
  console.error(`\n${failures.length} browser timeline metadata mismatch(es):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

function verifyDynamicTexts(scene, actual, expected) {
  const fields = ["variableName", "normalizedVariableName", "fontId", "fontHeight", "leading", "color", "x", "y", "width", "height", "multiline", "wordWrap", "html"];
  for (const [id, required] of Object.entries(expected)) {
    const found = actual[id];
    if (!found) {
      failures.push(`${scene}: dynamic text ${id} missing`);
      continue;
    }
    for (const field of fields) {
      if (required[field] === undefined) continue;
      if (normalizeValue(found[field]) !== normalizeValue(required[field])) {
        failures.push(`${scene}: dynamic text ${id}.${field} expected ${JSON.stringify(required[field])}, got ${JSON.stringify(found[field])}`);
      }
    }

    const runtimeAlign = loadedTextAlign(String(required.text ?? ""), found.align, Boolean(found.html));
    if (normalizeValue(runtimeAlign) !== normalizeValue(required.align)) {
      failures.push(`${scene}: dynamic text ${id}.align expected runtime ${JSON.stringify(required.align)}, got ${JSON.stringify(runtimeAlign)} from browser ${JSON.stringify(found.align)}`);
    }
  }
}

function verifyStaticTexts(scene, actualAssets, expectedAssets) {
  const fields = ["fontId", "fontHeight", "color", "align", "x", "y", "width", "height"];
  let required = 0;
  let browser = 0;
  for (const [id, requiredAsset] of Object.entries(expectedAssets)) {
    const requiredText = requiredAsset?.kind === "text" ? requiredAsset.text : undefined;
    if (!requiredText?.text || requiredText.normalizedVariableName) continue;
    required += 1;
    const found = actualAssets[id]?.text;
    if (!found) {
      failures.push(`${scene}: static text ${id} missing`);
      continue;
    }
    if (String(found.text ?? "") !== String(requiredText.text ?? "")) {
      failures.push(`${scene}: static text ${id}.text expected ${JSON.stringify(requiredText.text)}, got ${JSON.stringify(found.text)}`);
      continue;
    }
    browser += 1;
    for (const field of fields) {
      if (requiredText[field] === undefined) continue;
      if (normalizeValue(found[field]) !== normalizeValue(requiredText[field])) {
        failures.push(`${scene}: static text ${id}.${field} expected ${JSON.stringify(requiredText[field])}, got ${JSON.stringify(found[field])}`);
      }
    }
  }
  return { required, browser };
}

function verifySpriteLocalDefaults(scene, actual, expected) {
  for (const [spriteId, required] of Object.entries(expected)) {
    const found = actual[spriteId];
    if (!found) {
      failures.push(`${scene}: sprite local defaults ${spriteId} missing`);
      continue;
    }
    for (const [key, value] of Object.entries(required ?? {})) {
      if (normalizeValue(found[key]) !== normalizeValue(value)) {
        failures.push(`${scene}: sprite local default ${spriteId}.${key} expected ${JSON.stringify(value)}, got ${JSON.stringify(found[key])}`);
      }
    }
  }
}

function verifyOverflowFlags(scene, actualTimeline, expectedTimeline) {
  const actualOverflow = overflowIds(actualTimeline);
  const expectedOverflow = overflowIds(expectedTimeline);
  const renderSensitive = renderSensitiveSpriteIds(actualTimeline);
  let ignoredMetadataOnly = 0;

  for (const id of expectedOverflow) {
    if (actualOverflow.has(id)) continue;
    if (!renderSensitive.has(id)) {
      ignoredMetadataOnly += 1;
      continue;
    }
    failures.push(`${scene}: renderable overflow sprite ${id} missing`);
  }

  for (const id of actualOverflow) {
    if (expectedOverflow.has(id) || !renderSensitive.has(id)) continue;
    failures.push(`${scene}: renderable overflow sprite ${id} is not flagged in FFDec data`);
  }

  return {
    required: expectedOverflow.size,
    browser: actualOverflow.size,
    ignoredMetadataOnly,
  };
}

function overflowIds(timeline) {
  return new Set(
    Object.values(timeline.assets ?? {})
      .filter((asset) => asset?.kind === "sprite" && asset.overflowsBounds)
      .map((asset) => String(asset.id)),
  );
}

function renderSensitiveSpriteIds(timeline) {
  const ids = new Set();
  const seen = new Set();
  const assets = timeline.assets ?? {};
  const visit = (characterId) => {
    const key = String(characterId);
    if (seen.has(key)) return;
    seen.add(key);
    const asset = assets[key];
    if (!asset || asset.kind !== "sprite") return;
    if (asset.frames?.length) ids.add(key);
    for (const frame of asset.timeline ?? []) {
      for (const instance of frame.instances ?? []) visit(instance.characterId);
    }
  };

  for (const frame of timeline.frames ?? []) {
    for (const instance of frame.instances ?? []) visit(instance.characterId);
  }
  return ids;
}

function loadedTextAlign(text, fallback, html) {
  if (!html) return fallback;
  const declared = text.match(/<p\b[^>]*\balign\s*=\s*["']?(left|center|right|justify)\b/i)
    ?? text.match(/\btext-align\s*:\s*(left|center|right|justify)\b/i);
  if (declared?.[1]) return declared[1].toLowerCase();
  return "left";
}

function normalizeValue(value) {
  return typeof value === "number" ? Math.round(value * 1000) / 1000 : value;
}
