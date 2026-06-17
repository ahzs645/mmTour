// loadVariables() scene-variable loading + global-default discovery.

import { ctx } from "./extractContext.mjs";
import { normalizeGeneratedGlobalName, parseActionScriptLiteral } from "./asParse.mjs";
import { normalizeLoadedText, normalizeVariableName } from "./util.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export function loadSceneVariables(sceneName) {
  const variablesPath = findSceneVariablesPath(sceneName);
  if (!variablesPath) return {};

  const source = readFileSync(variablesPath, "utf8").replace(/\r\n/g, "\n");
  const variables = {};
  for (const chunk of source.split("&")) {
    const separator = chunk.indexOf("=");
    if (separator <= 0) continue;

    const key = chunk.slice(0, separator).trim();
    const value = chunk.slice(separator + 1).trim();
    if (!key) continue;
    variables[normalizeVariableName(key)] = normalizeLoadedText(value);
  }

  return variables;
}

export function findSceneVariablesPath(sceneName) {
  const publicRoot = join(ctx.root, "public");
  const exact = join(publicRoot, `${sceneName}.txt`);
  if (existsSync(exact)) return exact;

  const lowerName = `${sceneName.toLowerCase()}.txt`;
  return readdirSync(publicRoot)
    .filter((file) => file.toLowerCase() === lowerName)
    .map((file) => join(publicRoot, file))
    .find((path) => existsSync(path));
}

export function resolveVariableSource(fileName) {
  const publicRoot = join(ctx.root, "public");
  const lowerName = String(fileName).toLowerCase();
  const exactFile = readdirSync(publicRoot).find((file) => file.toLowerCase() === lowerName);
  if (exactFile) return { publicPath: exactFile };

  const locMatch = lowerName.match(/^(.+)_loc\.fla$/);
  if (locMatch?.[1] === ctx.scene.toLowerCase()) {
    const sceneVariablesPath = findSceneVariablesPath(ctx.scene);
    if (sceneVariablesPath && Object.keys(ctx.loadedVariables).length) {
      return {
        publicPath: basename(sceneVariablesPath),
        compatibility: "Resolved missing *_loc.fla variable load to the exported scene .txt variable file.",
      };
    }
  }

  return null;
}

export function discoverGlobalDefaults() {
  const sourcePath = join(ctx.root, "extracted", "A-tour", "scripts", "frame_1", "DoAction.as");
  if (!existsSync(sourcePath)) return {};

  const source = readFileSync(sourcePath, "utf8");
  const defaults = {};
  for (const match of source.matchAll(/\bbkgd\.([A-Za-z_$][\w$]*)\s*=\s*("[^"]*"|'[^']*'|[-]?\d+(?:\.\d+)?|true|false)\s*;/g)) {
    defaults[`bkgd.${match[1]}`] = parseActionScriptLiteral(match[2]);
  }
  return defaults;
}

export function evaluateGeneratedCondition(condition) {
  const normalized = condition.replaceAll("_level0.", "").trim();
  const equality = normalized.match(/^(.+?)\s*==\s*("[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false)$/);
  if (equality) return ctx.globalDefaults[normalizeGeneratedGlobalName(equality[1])] === parseActionScriptLiteral(equality[2]);

  const inequality = normalized.match(/^(.+?)\s*!=\s*("[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false)$/);
  if (inequality) return ctx.globalDefaults[normalizeGeneratedGlobalName(inequality[1])] !== parseActionScriptLiteral(inequality[2]);

  const value = ctx.globalDefaults[normalizeGeneratedGlobalName(normalized)];
  return Boolean(value);
}
