#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileScene } from "../src/convert/compileScene.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const scenes = process.argv.slice(2).length
  ? process.argv.slice(2).map((scene) => scene.replace(/\.swf$/i, ""))
  : ["A-tour", "intro", "nav", "segment1", "segment2", "segment3", "segment4", "segment5", "bnl"];

for (const scene of scenes) {
  const swfPath = join(root, "public", `${scene}.swf`);
  const ffdecPath = join(root, "public/generated", scene, "timeline.json");
  if (!existsSync(swfPath)) {
    console.log(`${scene}: missing public/${scene}.swf`);
    continue;
  }
  if (!existsSync(ffdecPath)) {
    console.log(`${scene}: missing public/generated/${scene}/timeline.json`);
    continue;
  }

  const ffdec = JSON.parse(readFileSync(ffdecPath, "utf8"));
  const browser = await compileScene(new Uint8Array(readFileSync(swfPath)), scene);
  const browserTimeline = browser.timeline;
  const external = externalAssetRefs(scene);

  console.log(`\n${scene}`);
  console.log(`  dimensions: ffdec ${dim(ffdec)} | browser ${dim(browserTimeline)}`);
  console.log(`  frames: ffdec ${ffdec.frameCount ?? 0} | browser ${browserTimeline.frameCount ?? 0}`);
  console.log(`  browser compile: ${browser.stats.ms}ms, files=${browser.files.size}, bytes=${browser.stats.assetBytes}`);

  for (const kind of sortedKinds(ffdec.assets, browserTimeline.assets)) {
    const left = assetIds(ffdec.assets, kind);
    const right = assetIds(browserTimeline.assets, kind);
    const missing = diff(left, right);
    const extra = diff(right, left);
    console.log(`  ${kind}: ffdec ${left.size} | browser ${right.size} | missing ${missing.length} | extra ${extra.length}`);
    printSample("missing", missing);
    printSample("extra", extra);
  }

  const fileMissing = generatedFileRefs(ffdec).filter((src) => !existsSync(join(root, "public", src)));
  if (fileMissing.length) {
    console.log(`  generated file refs missing from public/: ${fileMissing.length}`);
    printSample("missing files", fileMissing);
  }

  printControlSummary("  ffdec control", ffdec.control);
  printControlSummary("  browser control", browserTimeline.control);

  if (external.rows.length) {
    console.log(`  external refs: ${external.rows.length} total, ${external.missing.length} missing under public/`);
    printSample("missing external", external.missing.map((row) => row.ref), 20);
  }
  if (browser.dependencies.length) {
    console.log(`  browser-detected SWF dependencies: ${browser.dependencies.map((dep) => dep.url).join(", ")}`);
  }
}

function dim(timeline) {
  const d = timeline.dimensions ?? {};
  return `${d.width ?? "?"}x${d.height ?? "?"}`;
}

function sortedKinds(...assetMaps) {
  const kinds = new Set();
  for (const assets of assetMaps) {
    for (const asset of Object.values(assets ?? {})) {
      if (asset?.kind) kinds.add(asset.kind);
    }
  }
  return [...kinds].sort();
}

function assetIds(assets, kind) {
  return new Set(
    Object.values(assets ?? {})
      .filter((asset) => asset?.kind === kind)
      .map((asset) => String(asset.id)),
  );
}

function diff(left, right) {
  return [...left].filter((item) => !right.has(item)).sort((a, b) => Number(a) - Number(b));
}

function printSample(label, values, limit = 12) {
  if (!values.length) return;
  const suffix = values.length > limit ? ` ... +${values.length - limit}` : "";
  console.log(`    ${label}: ${values.slice(0, limit).join(", ")}${suffix}`);
}

function generatedFileRefs(value) {
  const refs = new Set();
  const visit = (item) => {
    if (!item || typeof item !== "object") return;
    for (const value of Object.values(item)) {
      if (typeof value === "string" && value.startsWith("generated/")) refs.add(value);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(value);
  return [...refs].sort();
}

function printControlSummary(label, control = {}) {
  const spriteActionCount = Object.values(control.spriteActions ?? {}).reduce((sum, rows) => {
    if (Array.isArray(rows)) return sum + rows.length;
    if (rows && typeof rows === "object") return sum + Object.values(rows).reduce((inner, value) => inner + (Array.isArray(value) ? value.length : 0), 0);
    return sum;
  }, 0);
  const unsupported = control.avm1Coverage?.unsupported?.length ?? 0;
  console.log(
    `${label}: frameActions=${control.frameActions?.length ?? 0}, `
      + `spriteActions=${spriteActionCount}, `
      + `buttonActions=${Object.keys(control.buttonActions ?? {}).length}, `
      + `definedFunctions=${Object.keys(control.definedFunctions ?? {}).length}, `
      + `dynamicTexts=${Object.keys(control.dynamicTexts ?? {}).length}, `
      + `unsupportedOpcodes=${unsupported}`,
  );
}

function externalAssetRefs(scene) {
  const publicDir = join(root, "public");
  const generatedDir = join(publicDir, "generated", scene);
  const sources = [];
  for (const candidate of [
    join(publicDir, "xml", `${scene}_en.xml`),
    join(publicDir, "xml", `${scene}.xml`),
    join(generatedDir, "control-flow.json"),
  ]) {
    if (existsSync(candidate)) sources.push(readFileSync(candidate, "utf8"));
  }

  const refs = new Set();
  for (const text of sources) {
    for (const pattern of [
      /(?:src|href|value|rawValue|arguments)"?\s*[:=]\s*"?([^"'<>\s]+\.(?:swf|png|jpe?g|gif|webp|mp3|wav))/gi,
      /["']([^"']+\.(?:swf|png|jpe?g|gif|webp|mp3|wav))["']/gi,
    ]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        const normalized = normalizeExternalRef(match[1]);
        if (normalized) refs.add(normalized);
      }
    }
  }

  const rows = [...refs]
    .map((ref) => ({ ref, present: existsSync(join(publicDir, ref)) }))
    .sort((a, b) => Number(a.present) - Number(b.present) || a.ref.localeCompare(b.ref));
  return { rows, missing: rows.filter((row) => !row.present) };
}

function normalizeExternalRef(ref) {
  const clean = String(ref ?? "")
    .trim()
    .replace(/\\\//g, "/")
    .replace(/^https?:\/\/[^/]+\//i, "")
    .replace(/^\/+/, "");
  if (!clean || clean.startsWith("public/") || clean.startsWith("generated/")) return "";
  return clean;
}
