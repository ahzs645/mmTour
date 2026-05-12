import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const rootDir = process.cwd();
const generatedDir = join(rootDir, "public", "generated");
const sceneNames = ["A-tour", "intro", "nav", "segment1", "segment2", "segment3", "segment4", "segment5"];
const weirdTextPattern = /�|□|\bundefined\b|\bNaN\b/;
const fontStackPattern = /Franklin Gothic Medium|Franklin Gothic|FranklinGothic|XP Franklin Gothic/;
const failures = [];
const summaries = [];

for (const scene of sceneNames) {
  const sceneDir = join(generatedDir, scene);
  const timelinePath = join(sceneDir, "timeline.json");
  if (!existsSync(timelinePath)) {
    failures.push(`${scene}: missing timeline.json`);
    continue;
  }

  const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));
  const fontAssets = Object.values(timeline.assets ?? {}).filter((asset) => asset.kind === "font" && asset.src);
  const dynamicTexts = Object.values(timeline.control?.dynamicTexts ?? {});
  const textAssetCount = verifyTextAssets(scene, sceneDir);
  const svgSummary = verifyFrameSvgs(scene, join(sceneDir, "frames"));

  if (dynamicTexts.length && !fontAssets.length) {
    failures.push(`${scene}: has ${dynamicTexts.length} dynamic text field(s) but no exported font assets`);
  }

  for (const text of dynamicTexts) {
    const label = `${scene}:${text.variableName ?? text.normalizedVariableName ?? text.characterId}`;
    const value = String(text.text ?? "");
    if (!value.trim()) failures.push(`${label}: dynamic text is empty`);
    if (weirdTextPattern.test(value)) failures.push(`${label}: dynamic text contains replacement/debug text: ${JSON.stringify(value)}`);
    if (!Number.isFinite(Number(text.fontHeight)) || Number(text.fontHeight) <= 0) {
      failures.push(`${label}: dynamic text has invalid fontHeight ${JSON.stringify(text.fontHeight)}`);
    }
  }

  summaries.push({
    scene,
    fontAssets: fontAssets.length,
    dynamicTexts: dynamicTexts.length,
    textAssets: textAssetCount,
    svgTextNodes: svgSummary.textNodes,
    svgGlyphRefs: svgSummary.glyphRefs,
  });
}

for (const summary of summaries) {
  console.log(
    `${summary.scene}: fonts=${summary.fontAssets}, dynamicText=${summary.dynamicTexts}, textAssets=${summary.textAssets}, svgText=${summary.svgTextNodes}, glyphRefs=${summary.svgGlyphRefs}`,
  );
}

if (failures.length) {
  console.error("\nText/font verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("\nText/font verification passed.");

function verifyTextAssets(scene, sceneDir) {
  const textDir = join(sceneDir, "texts");
  if (!existsSync(textDir)) return 0;

  const textFiles = readdirSync(textDir).filter((file) => file.endsWith(".txt"));
  for (const file of textFiles) {
    const text = readFileSync(join(textDir, file), "utf8");
    if (weirdTextPattern.test(text)) {
      failures.push(`${scene}/texts/${file}: contains replacement/debug text`);
    }
  }

  return textFiles.length;
}

function verifyFrameSvgs(scene, frameDir) {
  if (!existsSync(frameDir)) return { textNodes: 0, glyphRefs: 0 };

  let textNodes = 0;
  let glyphRefs = 0;
  const svgFiles = readdirSync(frameDir).filter((file) => file.endsWith(".svg"));

  for (const file of svgFiles) {
    const svgPath = join(frameDir, file);
    const svg = stripEmbeddedImageData(readFileSync(svgPath, "utf8"));
    const ids = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

    for (const match of svg.matchAll(/<text\b([^>]*)>[\s\S]*?<\/text>/g)) {
      textNodes += 1;
      const [node, attributes] = match;
      const visibleText = node.replace(/<[^>]+>/g, "").trim();
      if (visibleText && weirdTextPattern.test(visibleText)) {
        failures.push(`${scene}/frames/${file}: text node contains replacement/debug text: ${JSON.stringify(visibleText)}`);
      }
      if (!/\bfont-family=/.test(attributes)) {
        failures.push(`${scene}/frames/${file}: visible SVG text node is missing font-family`);
      } else if (!fontStackPattern.test(attributes)) {
        failures.push(`${scene}/frames/${file}: visible SVG text node uses unexpected font-family`);
      }
    }

    for (const match of svg.matchAll(/\b(?:href|xlink:href)="#(font_[^"]+)"/g)) {
      glyphRefs += 1;
      const id = match[1];
      if (!ids.has(id)) {
        failures.push(`${scene}/frames/${file}: glyph reference #${id} has no matching symbol id`);
      }
    }
  }

  return { textNodes, glyphRefs };
}

function stripEmbeddedImageData(svg) {
  return svg
    .replace(/\b(?:href|xlink:href)="data:image\/[^"]+"/g, 'href="[embedded-image]"')
    .replace(/<image\b[^>]*>/g, (tag) => tag.replace(/data:image\/[^"]+/g, "[embedded-image]"));
}
