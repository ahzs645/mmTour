import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const scenes = process.argv.slice(2).length
  ? process.argv.slice(2).map((scene) => basename(scene, ".swf"))
  : ["A-tour", "intro", "nav", "segment1", "segment2", "segment3", "segment4", "segment5"];

const reports = scenes.map(readCoverage).filter(Boolean);
if (!reports.length) {
  throw new Error("No generated avm1Coverage data found. Run npm run build:control-flow first.");
}

const aggregate = aggregateCoverage(reports.map((report) => report.coverage));

for (const { scene, coverage } of reports) {
  printCoverage(scene, coverage);
}

printCoverage("aggregate", aggregate);

function readCoverage(scene) {
  const candidates = [
    join(root, "public/generated", scene, "control-flow.json"),
    join(root, "public/generated", scene, "timeline.json"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    console.warn(`${scene}: missing generated control data`);
    return undefined;
  }
  const json = JSON.parse(readFileSync(path, "utf8"));
  const coverage = json.avm1Coverage ?? json.control?.avm1Coverage;
  if (!coverage) {
    console.warn(`${scene}: missing avm1Coverage in ${path}`);
    return undefined;
  }
  return { scene, coverage };
}

function printCoverage(label, coverage) {
  const unsupported = coverage.unsupportedOpcodes ?? [];
  const supportedPct = coverage.totalActions
    ? ((coverage.supportedActions / coverage.totalActions) * 100).toFixed(1)
    : "100.0";
  console.log(`\n${label}`);
  console.log(`  actions: ${coverage.totalActions} (${supportedPct}% summarized), unsupported: ${coverage.unsupportedActions}`);
  console.log(`  sources: ${formatCounts(coverage.sourceCounts ?? {})}`);
  console.log(`  top opcodes: ${formatCounts(sortCounts(coverage.opcodeCounts ?? {}).slice(0, 12))}`);
  if (!unsupported.length) {
    console.log("  unsupported opcodes: none");
    return;
  }
  console.log("  unsupported opcodes:");
  for (const entry of unsupported.slice(0, 20)) {
    const first = entry.locations?.[0];
    const where = first ? ` first=${first.path}` : "";
    console.log(`    ${entry.op}: ${entry.count}${where}`);
  }
}

function aggregateCoverage(coverages) {
  const out = {
    schemaVersion: 1,
    opcodeCounts: {},
    opcodeCodes: {},
    unsupportedOpcodes: [],
    sourceCounts: {},
    totalActions: 0,
    supportedActions: 0,
    unsupportedActions: 0,
  };
  const unsupported = new Map();
  for (const coverage of coverages) {
    addCounts(out.opcodeCounts, coverage.opcodeCounts ?? {});
    Object.assign(out.opcodeCodes, coverage.opcodeCodes ?? {});
    addCounts(out.sourceCounts, coverage.sourceCounts ?? {});
    out.totalActions += coverage.totalActions ?? 0;
    out.supportedActions += coverage.supportedActions ?? 0;
    out.unsupportedActions += coverage.unsupportedActions ?? 0;
    for (const entry of coverage.unsupportedOpcodes ?? []) {
      const merged = unsupported.get(entry.op) ?? { op: entry.op, code: entry.code, count: 0, locations: [] };
      merged.count += entry.count ?? 0;
      merged.locations.push(...(entry.locations ?? []).slice(0, Math.max(0, 25 - merged.locations.length)));
      unsupported.set(entry.op, merged);
    }
  }
  out.unsupportedOpcodes = [...unsupported.values()].sort((a, b) => b.count - a.count || a.op.localeCompare(b.op));
  return out;
}

function addCounts(target, source) {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + Number(value);
}

function sortCounts(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function formatCounts(counts) {
  const entries = Array.isArray(counts) ? counts : sortCounts(counts);
  return entries.map(([key, value]) => `${key}=${value}`).join(", ") || "none";
}
