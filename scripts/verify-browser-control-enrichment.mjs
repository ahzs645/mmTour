import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSwf } from "swf-parser";
import { extractControl } from "../src/convert/avm1Control.ts";
import { enrichControlWithTimelineData } from "../src/convert/controlEnrichment.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const scenes = process.argv.slice(2).length
  ? process.argv.slice(2).map((scene) => scene.replace(/\.swf$/i, ""))
  : ["A-tour", "intro", "nav", "segment1", "segment2", "segment3", "segment4", "segment5"];

const failures = [];

for (const scene of scenes) {
  const ffdecTimeline = JSON.parse(readFileSync(join(root, "public/generated", scene, "timeline.json"), "utf8"));
  const movie = parseSwf(new Uint8Array(readFileSync(join(root, "public", `${scene}.swf`))));
  const browserControl = extractControl(movie);
  const enriched = enrichControlWithTimelineData(
    {
      buttonActions: browserControl.buttonActions,
      definedFunctions: browserControl.definedFunctions,
      frameActions: browserControl.frameActions,
      spriteActions: browserControl.spriteActions,
      globalDefaults: ffdecTimeline.control?.globalDefaults ?? {},
    },
    ffdecTimeline.assets ?? {},
    ffdecTimeline.labels ?? {},
  );

  const expectedFunctions = definedFunctionKeys(ffdecTimeline.control?.definedFunctions);
  const actualFunctions = definedFunctionKeys(enriched.definedFunctions);
  compareLists(`${scene}: definedFunctions`, actualFunctions, expectedFunctions);

  const expectedButtons = Object.keys(ffdecTimeline.control?.buttonActions ?? {}).sort(numeric);
  const actualButtons = Object.keys(enriched.buttonActions ?? {}).sort(numeric);
  compareLists(`${scene}: button action ids`, actualButtons, expectedButtons);

  for (const buttonId of actualButtons) {
    const expectedOwners = ffdecTimeline.control?.buttonActions?.[buttonId]?.ownerSpriteIds ?? [];
    const actualOwners = enriched.buttonActions?.[buttonId]?.ownerSpriteIds ?? [];
    compareLists(`${scene}: button ${buttonId} ownerSpriteIds`, actualOwners.map(String), expectedOwners.map(String));
    compareButtonRootLabelFrames(`${scene}: button ${buttonId}`, enriched.buttonActions?.[buttonId], ffdecTimeline.control?.buttonActions?.[buttonId]);
    compareExitNavigation(`${scene}: button ${buttonId}`, enriched.buttonActions?.[buttonId], ffdecTimeline.control?.buttonActions?.[buttonId]);
  }

  const expectedNested = ffdecTimeline.control?.nestedSectionTargets ?? {};
  const actualNested = enriched.nestedSectionTargets ?? {};
  compareObjects(`${scene}: nestedSectionTargets`, actualNested, expectedNested);

  console.log(`${scene}: ${actualFunctions.length} function(s), ${actualButtons.length} button action(s), owner sprites and nested targets match FFDec data`);
}

if (failures.length) {
  console.error(`\n${failures.length} browser-control enrichment mismatch(es):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

function compareLists(label, actual, expected) {
  const a = [...actual].sort(numeric);
  const e = [...expected].sort(numeric);
  if (a.join(",") !== e.join(",")) failures.push(`${label}: expected [${e.join(", ")}], got [${a.join(", ")}]`);
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

function definedFunctionKeys(definedFunctions) {
  return Object.values(definedFunctions ?? {})
    .map((definition) => `${definition.scope ?? "root"}:${definition.spriteId ?? "root"}:${definition.functionName}`)
    .sort(numeric);
}

function compareButtonRootLabelFrames(label, actualGroup, expectedGroup) {
  for (const event of ["release", "rollOver", "rollOut", "press"]) {
    const expected = expectedGroup?.[event];
    if (!expected?.label || !isRootTimelineTarget(expected.target)) continue;
    const actual = actualGroup?.[event];
    if (actual?.label !== expected.label) continue;
    if (actual?.label !== expected.label || actual?.frame !== expected.frame) {
      failures.push(`${label} ${event}: expected root label ${expected.label} frame ${expected.frame}, got label ${actual?.label} frame ${actual?.frame}`);
    }
  }
}

function compareExitNavigation(label, actualGroup, expectedGroup) {
  for (const event of ["release", "rollOver", "rollOut", "press"]) {
    const expected = expectedGroup?.[event]?.exitNavigation;
    if (!expected) continue;
    const actual = actualGroup?.[event]?.exitNavigation;
    if (!actual) {
      failures.push(`${label} ${event}: missing exitNavigation ${JSON.stringify(expected)}`);
      continue;
    }
    for (const field of ["variable", "value", "swf", "exitLabel", "exitFrame", "level"]) {
      if (actual[field] !== expected[field]) {
        failures.push(`${label} ${event}: exitNavigation.${field} expected ${JSON.stringify(expected[field])}, got ${JSON.stringify(actual[field])}`);
      }
    }
  }
}

function isRootTimelineTarget(target) {
  return target === "_root" || target === "_level0" || target === "root";
}

function numeric(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}
