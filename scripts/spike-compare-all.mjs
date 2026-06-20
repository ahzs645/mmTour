// Capstone: run all four pure-TS converters (shapes, images, fonts, sounds)
// against FFDec's golden output across every scene, and print one comparison
// matrix — the browser-native pipeline vs the Java FFDec pipeline, side by side.
//
//   node scripts/spike-compare-all.mjs
//
// Delegates to the per-asset spike scripts (each already validated) and parses
// their summary lines, so this stays a thin orchestrator over trusted checks.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const scenes = ["A-tour", "intro", "nav", "segment1", "segment2", "segment3", "segment4", "segment5"];
const jobs = [
  { key: "shapes", label: "shapes→SVG", script: "spike-shape-to-svg.mjs", metric: "geometric" },
  { key: "images", label: "images→PNG", script: "spike-image-decode.mjs", metric: "pixel" },
  { key: "fonts", label: "fonts→TTF", script: "spike-font-build.mjs", metric: "render" },
  { key: "sounds", label: "sounds→MP3", script: "spike-sound-extract.mjs", metric: "byte-exact" },
];

const summaryRe = /comparable=(\d+)\s+PASS=(\d+)\s+FAIL=(\d+)\s+no-gold=(\d+)/;

function run(script, scene) {
  const res = spawnSync("node", [`scripts/${script}`, scene], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  const line = (res.stdout || "").split("\n").find((l) => summaryRe.test(l));
  if (!line) return { error: (res.stderr || "no summary").trim().split("\n").pop() };
  const [, comparable, pass, fail, noGold] = line.match(summaryRe);
  return { comparable: +comparable, pass: +pass, fail: +fail, noGold: +noGold };
}

const totals = Object.fromEntries(jobs.map((j) => [j.key, { comparable: 0, pass: 0, fail: 0, noGold: 0 }]));
const grid = {};

process.stdout.write(`Running ${jobs.length} converters × ${scenes.length} scenes vs FFDec golden…\n\n`);
for (const scene of scenes) {
  grid[scene] = {};
  for (const job of jobs) {
    const r = run(job.script, scene);
    grid[scene][job.key] = r;
    if (!r.error) {
      for (const k of ["comparable", "pass", "fail", "noGold"]) totals[job.key][k] += r[k];
    }
    process.stdout.write(`  ${scene} / ${job.key} … ${cell(r)}\n`);
  }
}

function cell(r) {
  if (r.error) return `ERR (${r.error})`;
  const base = `${r.pass}/${r.comparable}`;
  return r.noGold ? `${base} (+${r.noGold} no-gold)` : base;
}

// --- matrix ---
const col = 16;
const head = ["scene".padEnd(10), ...jobs.map((j) => j.label.padEnd(col))].join("");
console.log(`\n${head}`);
console.log("─".repeat(head.length));
for (const scene of scenes) {
  const cells = jobs.map((j) => cell(grid[scene][j.key]).padEnd(col));
  console.log(scene.padEnd(10) + cells.join(""));
}
console.log("─".repeat(head.length));
const totalCells = jobs.map((j) => {
  const t = totals[j.key];
  const s = t.noGold ? `${t.pass}/${t.comparable} (+${t.noGold})` : `${t.pass}/${t.comparable}`;
  return s.padEnd(col);
});
console.log("TOTAL".padEnd(10) + totalCells.join(""));

const grandPass = Object.values(totals).reduce((a, t) => a + t.pass, 0);
const grandComparable = Object.values(totals).reduce((a, t) => a + t.comparable, 0);
const grandFail = Object.values(totals).reduce((a, t) => a + t.fail, 0);
const grandNoGold = Object.values(totals).reduce((a, t) => a + t.noGold, 0);
console.log(
  `\nGRAND TOTAL: ${grandPass}/${grandComparable} assets match FFDec (${((grandPass / grandComparable) * 100).toFixed(2)}%)` +
    `  ·  FAIL=${grandFail}  ·  no-gold=${grandNoGold} (FFDec-deduped duplicates)`,
);
console.log("metrics: shapes=geometric outline, images=pixel, fonts=rendered-text pixel, sounds=byte-exact");
