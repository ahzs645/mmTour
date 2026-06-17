// Filesystem helpers for the timeline extractor (extracted/generated dir access).

import { ctx } from "./extractContext.mjs";
import { cpSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export function findSpriteDir(id) {
  return listDir("sprites").find((name) => name === `DefineSprite_${id}` || name.startsWith(`DefineSprite_${id}_`));
}

export function listDir(name) {
  const dir = join(ctx.extractedDir, name);
  return existsSync(dir) ? readdirSync(dir) : [];
}

export function relativeExtractedPath(filePath) {
  return filePath.slice(ctx.extractedDir.length + 1).replaceAll("\\", "/");
}

export function copyIfExists(name) {
  const src = join(ctx.extractedDir, name);
  if (existsSync(src)) {
    cpSync(src, join(ctx.publicDir, name), { recursive: true });
  }
}

export function preserveGeneratedReports() {
  if (!existsSync(ctx.secondaryDir) && !existsSync(ctx.parserReportPath)) return "";
  const tempDir = mkdtempSync(join(ctx.root, ".tmp-secondary-"));
  if (existsSync(ctx.secondaryDir)) renameSync(ctx.secondaryDir, join(tempDir, "secondary"));
  if (existsSync(ctx.parserReportPath)) renameSync(ctx.parserReportPath, join(tempDir, "swf-parser-report.json"));
  return tempDir;
}

export function restoreGeneratedReports(tempDir) {
  if (!tempDir) return;
  const backupDir = join(tempDir, "secondary");
  if (existsSync(backupDir)) renameSync(backupDir, ctx.secondaryDir);
  const backupParserReport = join(tempDir, "swf-parser-report.json");
  if (existsSync(backupParserReport)) renameSync(backupParserReport, ctx.parserReportPath);
  rmSync(tempDir, { recursive: true, force: true });
}

export function listPublicDir(name) {
  const dir = join(ctx.publicDir, name);
  return existsSync(dir) ? readdirSync(dir) : [];
}

export function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}
