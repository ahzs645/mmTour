// Pure leaf utilities for the timeline extractor (scripts/build-asset-timeline.mjs).
// No module state, no filesystem — plain functions of their inputs.

export function number(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function hex(value) {
  return value.toString(16).padStart(2, "0");
}

export function rectSize(max, min) {
  return (number(max, 0) - number(min, 0)) / 20;
}

export function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function roundSvgNumber(value) {
  return Math.round(value * 100) / 100;
}

export function escapeXmlAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

export function escapeXmlText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function decodeXmlEntities(value) {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", "\"")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeVariableName(name) {
  return String(name).replace(/^_root\./, "").split(".").pop();
}

export function normalizeName(name) {
  return String(name).replace(/^_root\./, "").replace(/^_parent\./, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function normalizeLoadedText(value) {
  const decoded = safeDecodeURIComponent(value.replace(/\+/g, "%20"));
  return decodeXmlEntities(decoded)
    .replace(/\\r\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

export function comparableText(value) {
  return normalizeLoadedText(value).replace(/\s+/g, " ").trim();
}

export function textAlignFromTag(value) {
  if (String(value) === "1") return "right";
  if (String(value) === "2") return "center";
  if (String(value) === "3") return "justify";
  return "left";
}

/**
 * Alignment for an edit-text field. For HTML fields the field's `align` attribute
 * is just the placeholder format; the rendered HTML governs and defaults to LEFT
 * (matching Flash/Ruffle) unless the content carries a <P ALIGN="…">. Non-HTML
 * fields use the field's align attribute directly.
 */
export function htmlTextAlign(tag, content) {
  if (tag.html !== "true") return textAlignFromTag(tag.align);
  const match = String(content ?? "").match(/ALIGN\s*=\s*["']?(LEFT|RIGHT|CENTER|JUSTIFY)/i);
  return match ? match[1].toLowerCase() : "left";
}

export function actionBytesStartWith(actionBytes, opcodeHex) {
  return typeof actionBytes === "string" && actionBytes.toLowerCase().startsWith(opcodeHex.toLowerCase());
}
