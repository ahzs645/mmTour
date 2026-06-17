// Pure SVG asset/text post-processing for the timeline extractor: named-use
// collection, sprite-frame iteration, glyph-row text reflow, inline SVG embedding.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeXmlEntities, escapeRegExp, escapeXmlAttribute, escapeXmlText, normalizeName, number, roundSvgNumber } from "./util.mjs";
import { identityMatrix, matrixFromSvgTransform, multiplyMatrices } from "./geom.mjs";

export function collectNamedUses(svgPath) {
  const uses = new Map();
  const svg = readFileSync(svgPath, "utf8");
  for (const { attributes, matrix } of iterSpriteFrameUses(svg)) {
    const id = attributes.id;
    const characterId = Number(attributes["ffdec:characterId"] ?? attributes.characterId);
    if (!id || !Number.isFinite(characterId)) continue;

    uses.set(normalizeName(id), {
      characterId,
      matrix,
      width: number(attributes.width, 0),
      height: number(attributes.height, 0),
    });
  }
  return uses;
}

export function iterSpriteFrameUses(svg) {
  const body = svg.split(/<defs\b/i)[0] ?? svg;
  const stack = [];
  const uses = [];
  for (const match of body.matchAll(/<\/g>|<g\b[^>]*>|<use\b[^>]*>/g)) {
    const tag = match[0];
    if (tag.startsWith("</g")) {
      stack.pop();
      continue;
    }

    const attributes = parseSvgAttributes(tag);
    if (tag.startsWith("<g")) {
      stack.push(matrixFromSvgTransform(attributes.transform));
      continue;
    }

    const matrix = [...stack, matrixFromSvgTransform(attributes.transform)].reduce(multiplyMatrices, identityMatrix());
    uses.push({ attributes, matrix });
  }
  return uses;
}

export function parseSvgAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    attributes[match[1]] = decodeXmlEntities(match[2]);
  }
  return attributes;
}

export /**
 * Find a button's embedded dynamic editText in its up-state SVG and return its
 * button-record placement matrix. FFDec nests the field as
 * `<g transform="<bounds-shift>"><use ffdec:characterId="N" transform="<placement>"/></g>`,
 * where the outer g is exactly the bounds/origin shift — so the inner `<use>` transform
 * IS the field's placement relative to the button registration (what the runtime composes
 * with the button's instance matrix to reproduce the standalone field position).
 */
function buttonDynamicTextField(svgPath, isDynamic) {
  let svg;
  try {
    svg = readFileSync(svgPath, "utf8");
  } catch {
    return undefined;
  }
  for (const tag of svg.match(/<use\b[^>]*>/g) ?? []) {
    const cid = tag.match(/ffdec:characterId="(\d+)"/);
    if (!cid || !isDynamic(Number(cid[1]))) continue;
    const transform = tag.match(/transform="([^"]*)"/)?.[1];
    return { id: Number(cid[1]), matrix: matrixFromSvgTransform(transform) };
  }
  return undefined;
}

export function reflowSvgTextGroup(svg, textId, expectedLines) {
  const groupPattern = new RegExp(`(<g id="${escapeRegExp(textId)}">\\s*<g[^>]*>)([\\s\\S]*?)(\\s*</g>\\s*</g>)`);
  const match = svg.match(groupPattern);
  if (!match) return svg;

  const body = match[2];
  const glyphs = [...body.matchAll(/<use\b[^>]*\btransform="matrix\(([^"]+)\)"[^>]*>/g)].map((glyphMatch) => {
    const matrix = glyphMatch[1].split(/[\s,]+/).filter(Boolean).map((value) => Number.parseFloat(value));
    return { tag: glyphMatch[0], x: matrix[4], y: matrix[5] };
  });
  const rows = groupGlyphRows(glyphs);
  if (rows.length <= expectedLines || expectedLines <= 0) return svg;

  const extraRows = rows.length - expectedLines;
  const targetY = rows.slice(0, expectedLines).map((row) => row.y);
  const rowMoves = new Map();
  let firstRowMaxX = rows[0].glyphs.reduce((max, glyph) => Math.max(max, glyph.x), 0);

  rows.forEach((row, rowIndex) => {
    if (rowIndex <= extraRows) {
      rowMoves.set(row.y, {
        y: targetY[0],
        xOffset: rowIndex === 0 ? 0 : firstRowMaxX - row.glyphs[0].x + 7,
      });
      if (rowIndex > 0) {
        firstRowMaxX = Math.max(firstRowMaxX, row.glyphs.reduce((max, glyph) => Math.max(max, glyph.x + firstRowMaxX + 7), 0));
      }
      return;
    }

    rowMoves.set(row.y, { y: targetY[rowIndex - extraRows], xOffset: 0 });
  });

  const nextBody = body.replace(/<use\b[^>]*\btransform="matrix\(([^"]+)\)"[^>]*>/g, (glyphTag, matrixText) => {
    const matrix = matrixText.split(/[\s,]+/).filter(Boolean).map((value) => Number.parseFloat(value));
    const move = rowMoves.get(matrix[5]);
    if (!move) return glyphTag;
    matrix[4] = roundSvgNumber(matrix[4] + move.xOffset);
    matrix[5] = roundSvgNumber(move.y);
    return glyphTag.replace(matrixText, matrix.join(", "));
  });

  return svg.replace(match[0], `${match[1]}${nextBody}${match[3]}`);
}

export function groupGlyphRows(glyphs) {
  const rows = [];
  for (const glyph of glyphs) {
    let row = rows.find((item) => Math.abs(item.y - glyph.y) < 0.05);
    if (!row) {
      row = { y: glyph.y, glyphs: [] };
      rows.push(row);
    }
    row.glyphs.push(glyph);
  }

  return rows.sort((a, b) => a.y - b.y).map((row) => ({
    ...row,
    glyphs: row.glyphs.sort((a, b) => a.x - b.x),
  }));
}

export function svgTextReplacement(characterId, replacement, transform, width, height) {
  const lines = replacement.text.split("\n").filter(Boolean);
  const fontSize = Math.max(1, replacement.fontHeight || 12);
  const lineHeight = Math.max(fontSize, fontSize + (replacement.leading || 0));
  const anchor = replacement.align === "center" ? "middle" : replacement.align === "right" ? "end" : "start";
  const x = replacement.align === "center" ? width / 2 : replacement.align === "right" ? width : 0;
  const transformAttribute = transform ? ` transform="${escapeXmlAttribute(transform)}"` : "";
  const tspans = lines
    .map((line, index) => `<tspan x="${roundSvgNumber(x)}" y="${roundSvgNumber(fontSize + index * lineHeight)}">${escapeXmlText(line)}</tspan>`)
    .join("");

  return `<text ffdec:characterId="${characterId}"${transformAttribute} fill="${replacement.color}" font-family="Franklin Gothic Medium, Franklin Gothic, FranklinGothic, XP Franklin Gothic, Arial Narrow, Arial, sans-serif" font-size="${roundSvgNumber(fontSize)}" font-weight="700" text-anchor="${anchor}">${tspans}</text>`;
}

export function registrationShift(asset) {
  const x = number(asset.origin?.x, 0);
  const y = number(asset.origin?.y, 0);
  return x || y ? ` transform="matrix(1, 0, 0, 1, ${-x}, ${-y})"` : "";
}

export function inlineSvgAsset(scene, path, idPrefix, transformAttribute, characterId = "", contentTransformAttribute = "") {
  if (!existsSync(path)) return "";

  let svg = readFileSync(path, "utf8");
  const body = svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i)?.[1]?.trim();
  if (!body) return "";

  const prefix = `ffdec_${scene}_${idPrefix}_`.replace(/[^A-Za-z0-9_-]/g, "_");
  const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  let namespaced = body;

  for (const id of ids) {
    const escaped = escapeRegExp(id);
    namespaced = namespaced
      .replace(new RegExp(`\\sid="${escaped}"`, "g"), ` id="${prefix}${id}"`)
      .replace(new RegExp(`url\\(#${escaped}\\)`, "g"), `url(#${prefix}${id})`)
      .replace(new RegExp(`(xlink:href|href)="#${escaped}"`, "g"), `$1="#${prefix}${id}"`);
  }

  const characterAttribute = characterId ? ` ffdec:characterId="${characterId}"` : "";
  const content = contentTransformAttribute ? `<g${contentTransformAttribute}>${namespaced}</g>` : namespaced;
  return `<g ffdec:inlinedCharacter="${idPrefix}"${characterAttribute}${transformAttribute}>${content}</g>`;
}

export function dataUri(path, mimeType) {
  if (!existsSync(path)) return "";
  return `data:${mimeType};base64,${readFileSync(path).toString("base64")}`;
}
