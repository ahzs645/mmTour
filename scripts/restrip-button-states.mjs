// One-off: re-apply the button-label strip (scripts/lib/assets.mjs:stripButtonStateText)
// to ALREADY-generated data, for over/down states the original up-only strip missed. The
// runtime overlays the live label, so a baked copy in the over state doubled it on hover
// (the nav "Skip Intro" button). Reads each scene's timeline.json for button assets that
// carry textFields + state SVGs, and removes the text <use> from every state SVG on disk.
// No Java/FFDec needed. (Future full converts get this automatically via the fixed
// stripButtonStateText.) Run: node scripts/restrip-button-states.mjs
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const genRoot = join(root, "public/generated");
const scenes = readdirSync(genRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(genRoot, e.name, "timeline.json")))
  .map((e) => e.name)
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

let grandStripped = 0;
for (const scene of scenes) {
  const tl = JSON.parse(readFileSync(join(genRoot, scene, "timeline.json"), "utf8"));
  const assets = Object.values(tl.assets ?? {});
  let sceneStripped = 0;
  const detail = [];
  for (const asset of assets) {
    if (asset?.kind !== "button" || !asset.textFields?.length) continue;
    const fieldIds = new Set(asset.textFields.map((f) => f.id));
    const srcs = new Set(["up", "over", "down"].map((s) => asset.states?.[s]?.src).filter(Boolean));
    for (const src of srcs) {
      const path = join(root, "public", src);
      if (!existsSync(path)) continue;
      const svg = readFileSync(path, "utf8");
      const stripped = svg.replace(/<use\b[^>]*\/>/g, (m) => {
        const cid = m.match(/ffdec:characterId="(\d+)"/);
        if (cid && fieldIds.has(Number(cid[1]))) return "";
        if (/(?:xlink:href|href)="#text\d+"/.test(m)) return ""; // FFDec editText placeholder
        return m;
      });
      if (stripped !== svg) {
        writeFileSync(path, stripped);
        sceneStripped += 1;
        detail.push(`${src.split("/").slice(-2).join("/")} (button ${asset.id})`);
      }
    }
  }
  grandStripped += sceneStripped;
  if (sceneStripped) console.log(`${scene}: stripped ${sceneStripped} state svg(s) — ${detail.join(", ")}`);
}
console.log(`\nTOTAL state SVGs re-stripped: ${grandStripped}`);
