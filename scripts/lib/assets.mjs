// Asset discovery + SVG/text frame post-processing (shapes, sprites, images, text).

import { ctx } from "./extractContext.mjs";
import { findSpriteDir, listDir, listPublicDir, walkFiles } from "./fileUtils.mjs";
import { colorFromTag } from "./geom.mjs";
import { buttonDynamicTextField, dataUri, inlineSvgAsset, reflowSvgTextGroup, registrationShift, svgTextReplacement } from "./svgText.mjs";
import { asArray, compactObject, comparableText, htmlTextAlign, normalizeLoadedText, normalizeVariableName, number, textAlignFromTag } from "./util.mjs";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export function discoverAssets(allTags) {
  const defs = {};

  for (const tag of allTags) {
    if (!tag?.type) continue;

    if (tag.type.startsWith("DefineShape") && tag.shapeId) {
      const id = String(tag.shapeId);
      const src = `generated/${ctx.scene}/shapes/${id}.svg`;
      defs[id] = {
        id: Number(id),
        kind: "shape",
        src,
        origin: svgOrigin(join(ctx.extractedDir, "shapes", `${id}.svg`)),
      };
    }

    if (tag.type === "DefineSpriteTag" && tag.spriteId) {
      const id = String(tag.spriteId);
      const dirName = findSpriteDir(id);
      const hasPlacedChildren = asArray(tag.subTags?.item).some((sub) => sub?.type === "PlaceObject2Tag" || sub?.type === "PlaceObject3Tag");
      if (dirName) {
        const files = readdirSync(join(ctx.extractedDir, "sprites", dirName))
          .filter((file) => file.endsWith(".svg"))
          .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
        if (files.length) {
          defs[id] = {
            id: Number(id),
            kind: "sprite",
            frames: files.map((file) => `generated/${ctx.scene}/sprites/${dirName}/${file}`),
            origin: svgOrigin(join(ctx.extractedDir, "sprites", dirName, files[0])),
          };
        } else if (hasPlacedChildren) {
          defs[id] = { id: Number(id), kind: "sprite", origin: { x: 0, y: 0, width: 0, height: 0 } };
        }
      } else if (hasPlacedChildren) {
        // No baked sprite SVGs (native parse, or the tree-player optimize dropped
        // them): create a sprite asset with no frames[] so it tree-renders from its
        // attached timeline. Children carry absolute matrices in the sprite's local
        // space, so origin isn't needed for leaf positioning (only the baked path uses it).
        defs[id] = { id: Number(id), kind: "sprite", origin: { x: 0, y: 0, width: 0, height: 0 } };
      }
    }

    if (tag.type.startsWith("DefineText") && tag.characterID) {
      const id = String(tag.characterID);
      // A static DefineText is glyphs drawn in an embedded font at a fixed colour/size — not
      // the browser default. Capture the first text record's font/height/colour and the text
      // bounds so the runtime renders it faithfully (e.g. segment5's white 18px section titles)
      // instead of the app's default sans-serif. The string itself is the FFDec-exported .txt.
      const bounds = tag.textBounds;
      const styled = asArray(tag.textRecords?.item).find((r) => r && (r.styleFlagsHasFont === "true" || r.fontId));
      let content = "";
      try {
        content = readFileSync(join(ctx.extractedDir, "texts", `${id}.txt`), "utf8").trim();
      } catch { /* no exported text — fall back to a plain field */ }
      const width = bounds ? (number(bounds.Xmax, 0) - number(bounds.Xmin, 0)) / 20 : 0;
      const height = bounds ? (number(bounds.Ymax, 0) - number(bounds.Ymin, 0)) / 20 : 0;
      // textBounds is the glyph box in the character's PLACED space (the text matrix is already
      // folded in — placement.tx + textBounds-center reproduces the SWF stage position). So x is
      // just textBounds.Xmin: the left edge where the glyphs sit (e.g. segment5's section titles
      // are centered in their bar). Centre-align within the box so a font whose metrics differ
      // slightly from the embedded font still keeps the SWF's centre. Vertical: a DOM text box
      // positions its LINE box at `top`, whose ascent already drops the glyphs to ~Ymin, so y stays
      // at the origin (adding Ymin would double it and the title sits too low).
      const x = bounds ? number(bounds.Xmin, 0) / 20 : 0;
      const style = styled && content
        ? compactObject({
            fontId: number(styled.fontId, 0) || undefined,
            fontHeight: number(styled.textHeight, 0) / 20 || undefined,
            color: colorFromTag(styled.textColor),
            align: "center",
            x,
            y: 0,
            width: width || undefined,
            height: height || undefined,
            wordWrap: false,
            multiline: false,
            text: normalizeLoadedText(content) || undefined,
          })
        : undefined;
      defs[id] = {
        id: Number(id),
        kind: "text",
        src: `generated/${ctx.scene}/texts/${id}.txt`,
        origin: { x: style ? x : 0, y: 0, width: width || 0, height: height || 0 },
        ...(style ? { text: style } : {}),
      };
    }

    // DefineEditText fields carry their own styling (font, size, color, box).
    // Capture it for every field — not just the variable-loaded ones — so the
    // player can render them in the original typeface.
    if (tag.type === "DefineEditTextTag" && tag.characterID) {
      const id = String(tag.characterID);
      const bounds = tag.bounds;
      const width = bounds ? (number(bounds.Xmax, 0) - number(bounds.Xmin, 0)) / 20 : 0;
      const height = bounds ? (number(bounds.Ymax, 0) - number(bounds.Ymin, 0)) / 20 : 0;
      const style = compactObject({
        fontId: number(tag.fontId, 0) || undefined,
        fontHeight: number(tag.fontHeight, 0) / 20,
        leading: number(tag.leading, 0) / 20,
        color: colorFromTag(tag.textColor),
        align: htmlTextAlign(tag, tag.initialText),
        x: bounds ? number(bounds.Xmin, 0) / 20 : undefined,
        y: bounds ? number(bounds.Ymin, 0) / 20 : undefined,
        width: width || undefined,
        height: height || undefined,
        multiline: tag.multiline === "true",
        wordWrap: tag.wordWrap === "true",
        html: tag.html === "true",
        text: normalizeLoadedText(String(tag.initialText ?? "")) || undefined,
        // Variable binding (e.g. `_root.skipIntro`) so the runtime can fill the
        // field from loadVariables() — these fields are baked empty in sprites.
        variableName: tag.variableName || undefined,
        normalizedVariableName: tag.variableName ? normalizeVariableName(tag.variableName) : undefined,
      });
      defs[id] = {
        id: Number(id),
        kind: "text",
        src: `generated/${ctx.scene}/texts/${id}.txt`,
        origin: { x: style.x ?? 0, y: style.y ?? 0, width: width, height: height },
        text: style,
      };
    }
  }

  for (const file of listDir("texts")) {
    const id = basename(file, ".txt");
    defs[id] ??= {
      id: Number(id),
      kind: "text",
      src: `generated/${ctx.scene}/texts/${file}`,
      origin: { x: 0, y: 0, width: 0, height: 0 },
    };
  }

  for (const file of listDir("images")) {
    // FFDec exports .png; the native extractor keeps JPEGs as .jpg — accept both.
    const id = file.replace(/\.(png|jpe?g)$/i, "");
    defs[id] ??= {
      id: Number(id),
      kind: "image",
      src: `generated/${ctx.scene}/images/${file}`,
      origin: { x: 0, y: 0, width: 0, height: 0 },
    };
  }

  const buttonsDir = join(ctx.extractedDir, "buttons");
  for (const path of existsSync(buttonsDir) ? walkFiles(buttonsDir) : []) {
    if (!path.endsWith(".svg")) continue;
    const relative = path.slice(buttonsDir.length + 1).replaceAll("\\", "/");
    const id = relative.match(/DefineButton2?_(\d+)/)?.[1] ?? basename(path, ".svg").match(/\d+/)?.[0] ?? basename(path, ".svg");
    const state = basename(path, ".svg").replace(/^\d+_/, "");
    const key = `button:${id}`;
    const stateEntry = {
      src: `generated/${ctx.scene}/buttons/${relative}`,
      origin: svgOrigin(path),
    };
    defs[key] ??= {
      id: Number(id),
      kind: "button",
      origin: stateEntry.origin,
      states: {},
    };
    defs[key].states[state] = stateEntry;
    if (!defs[key].src && state !== "hittest") defs[key].src = stateEntry.src;
    // A button wrapping a bound editText (e.g. the nav "Skip Intro" button): record
    // the field's button-record placement so the runtime can overlay the live
    // loadVariables() value with the field's own bounds. FFDec bakes it at the field
    // registration (mispositioned) and leaves the composited sprite frame empty.
    if (state === "up") {
      const field = buttonDynamicTextField(
        path,
        (cid) => defs[String(cid)]?.kind === "text" && Boolean(defs[String(cid)]?.text?.normalizedVariableName),
      );
      if (field) defs[key].textFields = [field];
    }
  }

  for (const file of listDir("fonts")) {
    const id = basename(file).match(/\d+/)?.[0] ?? basename(file);
    defs[`font:${id}`] = {
      id: Number(id),
      kind: "font",
      src: `generated/${ctx.scene}/fonts/${file}`,
      origin: { x: 0, y: 0, width: 0, height: 0 },
    };
  }

  for (const file of listDir("sounds")) {
    const id = basename(file).match(/\d+/)?.[0] ?? basename(file);
    defs[`sound:${id}`] = {
      id: Number(id),
      kind: "sound",
      src: `generated/${ctx.scene}/sounds/${file}`,
      origin: { x: 0, y: 0, width: 0, height: 0 },
    };
  }

  return defs;
}

export function svgOrigin(path) {
  if (!path || !existsSync(path)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const sample = readFileSync(path, "utf8").slice(0, 1200);
  const width = Number.parseFloat(sample.match(/\bwidth="([\d.]+)px"/)?.[1] ?? "0");
  const height = Number.parseFloat(sample.match(/\bheight="([\d.]+)px"/)?.[1] ?? "0");
  const transform = sample.match(/<g[^>]+transform="matrix\(([^)]+)\)"/)?.[1];
  const parts = transform ? transform.split(",").map((part) => Number.parseFloat(part.trim())) : [];
  return {
    x: Number.isFinite(parts[4]) ? parts[4] : 0,
    y: Number.isFinite(parts[5]) ? parts[5] : 0,
    width,
    height,
  };
}

export function replacementForMissingUse(tag, hrefId, characterId, frame, assetDefs) {
  const asset = assetDefs[characterId];
  if (!asset) return "";

  const transform = tag.match(/\btransform="([^"]+)"/)?.[1] ?? "";
  const transformAttribute = transform ? ` transform="${transform}"` : "";
  const width = tag.match(/\bwidth="([^"]+)"/)?.[1] ?? "0";
  const height = tag.match(/\bheight="([^"]+)"/)?.[1] ?? "0";

  if (asset.kind === "shape") {
    return inlineSvgAsset(ctx.scene, join(ctx.publicDir, "shapes", `${characterId}.svg`), `${hrefId}_${characterId}`, transformAttribute);
  }

  if (asset.kind === "image") {
    const href = dataUri(join(ctx.publicDir, "images", `${characterId}.png`), "image/png");
    return href ? `<image ffdec:characterId="${characterId}" width="${width}" height="${height}"${transformAttribute} href="${href}" xlink:href="${href}" preserveAspectRatio="none"/>` : "";
  }

  if (asset.kind === "sprite" && asset.frames?.length) {
    const src = spriteFrameForRootFrame(characterId, frame, asset);
    const relative = src.split(`generated/${ctx.scene}/`).pop();
    return relative
      ? inlineSvgAsset(ctx.scene, join(ctx.publicDir, relative), `${hrefId}_${characterId}`, transformAttribute, characterId, registrationShift(asset))
      : "";
  }

  return "";
}

export function firstNonEmptySpriteFrame(frames) {
  return (
    frames.find((src) => {
      const relative = src.split(`generated/${ctx.scene}/`).pop();
      if (!relative) return false;
      const svg = readFileSync(join(ctx.publicDir, relative), "utf8");
      return /<(path|use|text|image|polygon|polyline|ellipse|circle|rect)\b/.test(svg);
    }) ?? frames[0]
  );
}

export function spriteFrameForRootFrame(characterId, frame, asset) {
  const instance = frame?.instances?.find((item) => String(item.characterId) === String(characterId));
  if (!instance || !asset.frames?.length) return firstNonEmptySpriteFrame(asset.frames);

  const relativeFrame = Math.max(0, frame.index - (instance.placedFrame ?? frame.index));
  const stoppedFrame = firstReachedStopFrame(characterId, relativeFrame);
  const spriteFrame = stoppedFrame ?? relativeFrame % asset.frames.length;
  return asset.frames[spriteFrame] ?? firstNonEmptySpriteFrame(asset.frames);
}

export function firstReachedStopFrame(characterId, relativeFrame) {
  const stops = ctx.spriteStopFrames[String(characterId)] ?? [];
  return stops.find((stopFrame) => stopFrame <= relativeFrame);
}

export function discoverButtonOwnerSprites(characterId) {
  const marker = `ffdec:characterId="${characterId}"`;
  return Object.values(ctx.assets)
    .filter((asset) => asset.kind === "sprite" && asset.frames?.length)
    .filter((asset) =>
      asset.frames.some((src) => {
        const relative = src.split(`generated/${ctx.scene}/`).pop();
        return relative ? readFileSync(join(ctx.extractedDir, relative), "utf8").includes(marker) : false;
      }),
    )
    .map((asset) => asset.id)
    .sort((a, b) => a - b);
}

export /**
 * Strip baked dynamic-text `<use>`s from sprite frame SVGs. FFDec bakes a loadVariables()
 * editText's INITIAL content into the composited frame at the field registration (ignoring
 * the bounds offset), so it renders mispositioned/clipped (e.g. nav "Skip Intro"). The runtime
 * overlays the live value at the correct position, so drop the baked copy. Only variable-bound
 * fields are stripped — static editText (incl. masked title strips like the nav section
 * headings) stay baked, since FFDec composites their masks correctly and the runtime can't
 * mask-clip a DOM overlay.
 */
function stripBakedDynamicText(assetDefs) {
  const ids = new Set(
    Object.values(assetDefs)
      .filter((a) => a?.kind === "text" && a?.text)
      .map((a) => a.id),
  );
  const spritesDir = join(ctx.publicDir, "sprites");
  if (!ids.size || !existsSync(spritesDir)) return;
  for (const dir of readdirSync(spritesDir)) {
    let entries;
    try {
      entries = readdirSync(join(spritesDir, dir));
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".svg")) continue;
      const path = join(spritesDir, dir, file);
      const svg = readFileSync(path, "utf8");
      const stripped = svg.replace(/<use\b[^>]*\/>/g, (m) => {
        const cid = m.match(/ffdec:characterId="(\d+)"/);
        return cid && ids.has(Number(cid[1])) ? "" : m;
      });
      if (stripped !== svg) writeFileSync(path, stripped);
    }
  }
}

export /**
 * Strip a button's embedded editText `<use>` from its UP-state SVG. A button that wraps a
 * bound editText (segment5's Replay icon, the nav "Skip Intro") bakes the field's glyphs into
 * the up-state art — FFDec clips them to the narrow field box (so "Skip Intro" renders as
 * "Skip I"). The runtime draws the live field value on top (collectButtonText), so drop the
 * baked glyphs here, leaving just the button's icon. Mirrors stripBakedDynamicText for sprites.
 */
function stripButtonStateText(assetDefs) {
  for (const asset of Object.values(assetDefs)) {
    if (asset?.kind !== "button" || !asset.textFields?.length) continue;
    const upSrc = asset.states?.up?.src;
    if (!upSrc) continue;
    const path = join(ctx.root, "public", upSrc);
    let svg;
    try {
      svg = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const fieldIds = new Set(asset.textFields.map((field) => field.id));
    const stripped = svg.replace(/<use\b[^>]*\/>/g, (m) => {
      const cid = m.match(/ffdec:characterId="(\d+)"/);
      return cid && fieldIds.has(Number(cid[1])) ? "" : m;
    });
    if (stripped !== svg) writeFileSync(path, stripped);
  }
}

export function normalizeFrameSvgs(rootFrames, assetDefs) {
  const framesDir = join(ctx.publicDir, "frames");
  if (!existsSync(framesDir)) return;

  for (const file of listPublicDir("frames").filter((name) => name.endsWith(".svg"))) {
    const path = join(framesDir, file);
    const frameIndex = Math.max(0, Number.parseInt(file, 10) - 1);
    const frame = rootFrames[frameIndex];
    let svg = readFileSync(path, "utf8");
    const ids = new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
    let changed = false;

    svg = svg.replace(/<use\b[^>]*(?:xlink:href|href)="#([^"]+)"[^>]*>/g, (tag, hrefId) => {
      if (ids.has(hrefId)) return tag;

      const characterId = tag.match(/\bffdec:characterId="(\d+)"/)?.[1];
      const width = Number.parseFloat(tag.match(/\bwidth="([^"]+)"/)?.[1] ?? "0");
      const height = Number.parseFloat(tag.match(/\bheight="([^"]+)"/)?.[1] ?? "0");

      changed = true;
      if (!characterId || width <= 0 || height <= 0) return "";

      return replacementForMissingUse(tag, hrefId, characterId, frame, assetDefs);
    });

    if (changed) writeFileSync(path, svg);
  }
}

export function normalizeSvgTextLayouts() {
  const svgFiles = walkFiles(ctx.publicDir).filter((path) => path.endsWith(".svg"));

  for (const path of svgFiles) {
    let svg = readFileSync(path, "utf8");
    let changed = false;

    const textReferences = [...svg.matchAll(/<use\b[^>]*ffdec:characterId="(\d+)"[^>]*(?:xlink:href|href)="#([^"]+)"[^>]*>/g)];
    for (const [, characterId, textId] of textReferences) {
      if (!textId.startsWith("text")) continue;
      const sourceText = readExtractedText(characterId);
      const expectedLines = sourceText ? sourceText.split(/\r\n|\r|\n/).filter((line) => line.length > 0).length : 0;
      if (expectedLines <= 0) continue;

      const nextSvg = reflowSvgTextGroup(svg, textId, expectedLines);
      if (nextSvg !== svg) {
        svg = nextSvg;
        changed = true;
      }
    }

    if (changed) writeFileSync(path, svg);
  }
}

export function readExtractedText(characterId) {
  const path = join(ctx.publicDir, "texts", `${characterId}.txt`);
  return existsSync(path) ? readFileSync(path, "utf8").trimEnd() : "";
}

export function replaceStaticVariableText(allTags) {
  const replacements = discoverStaticVariableTextReplacements(allTags);
  if (!Object.keys(replacements).length) return;

  for (const path of walkFiles(ctx.publicDir).filter((file) => file.endsWith(".svg"))) {
    let svg = readFileSync(path, "utf8");
    let changed = false;

    svg = svg.replace(/<use\b[^>]*ffdec:characterId="(\d+)"[^>]*>/g, (tag, characterId) => {
      const replacement = replacements[characterId];
      if (!replacement) return tag;

      const transform = tag.match(/\btransform="([^"]+)"/)?.[1] ?? "";
      const width = Number.parseFloat(tag.match(/\bwidth="([^"]+)"/)?.[1] ?? "0");
      const height = Number.parseFloat(tag.match(/\bheight="([^"]+)"/)?.[1] ?? "0");
      if (width <= 0 || height <= 0) return tag;

      changed = true;
      return svgTextReplacement(characterId, replacement, transform, width, height);
    });

    if (changed) writeFileSync(path, svg);
  }
}

export function discoverStaticVariableTextReplacements(allTags) {
  const replacements = {};

  for (const tag of allTags) {
    if (!tag?.characterID || !tag.variableName) continue;

    const variableName = normalizeVariableName(tag.variableName);
    const loadedText = ctx.loadedVariables[variableName];
    const initialText = normalizeLoadedText(String(tag.initialText ?? ""));
    if (!loadedText || !initialText.includes("\n")) continue;
    if (comparableText(initialText) !== comparableText(loadedText)) continue;
    if (number(tag.fontHeight, 0) / 20 > 16) continue;

    replacements[String(tag.characterID)] = {
      text: initialText,
      fontHeight: number(tag.fontHeight, 0) / 20,
      leading: number(tag.leading, 0) / 20,
      color: colorFromTag(tag.textColor),
      align: textAlignFromTag(tag.align),
    };
  }

  return replacements;
}
