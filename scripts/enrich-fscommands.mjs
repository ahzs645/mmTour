// Conversion step: merge AVM1 `fscommand(...)` button handlers into each scene's
// generated timeline.json. FFDec's decompiled .as doesn't translate fscommand, so a
// button like the nav toolbar's quit button (`fscommand("quit")`) ends up with an empty
// on(release). We recover it straight from the SWF bytecode (no Java) and write a real
// `{ command: "fsCommand", value, arguments }` action the runtime can surface via onFsCommand.
//
// Non-destructive: only fills button events that have no real action yet (never clobbers a
// parsed goto/call). Reads public/<scene>.swf + public/generated/<scene>/timeline.json.
// Run: node scripts/enrich-fscommands.mjs   (also part of the convert / pack:tour pipeline)
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeButtonFsCommands } from "./lib/decodeFsCommands.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const genRoot = join(root, "public/generated");
const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const scenes = requested.length
  ? requested
  : readdirSync(genRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(genRoot, e.name, "timeline.json")))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

let grandTotal = 0;
for (const scene of scenes) {
  const swfPath = ["", "public/"].map((p) => join(root, p, `${scene}.swf`)).find((p) => existsSync(p));
  const tlPath = join(genRoot, scene, "timeline.json");
  if (!swfPath || !existsSync(tlPath)) { console.log(`${scene}: skip (no swf/timeline)`); continue; }

  const fsByButton = decodeButtonFsCommands(new Uint8Array(readFileSync(swfPath)));
  const ids = Object.keys(fsByButton);
  if (!ids.length) { console.log(`${scene}: no fscommand buttons`); continue; }

  const tl = JSON.parse(readFileSync(tlPath, "utf8"));
  tl.control ??= {};
  tl.control.buttonActions ??= {};
  let added = 0;
  const detail = [];
  for (const id of ids) {
    for (const [event, fs] of Object.entries(fsByButton[id])) {
      const group = (tl.control.buttonActions[id] ??= {});
      const existing = group[event];
      if (existing && (existing.command || existing.functionCalls?.length)) continue; // keep real actions
      group[event] = { ...(existing ?? {}), command: "fsCommand", value: fs.value, arguments: fs.args, supported: true };
      added += 1;
      detail.push(`char ${id} ${event}=fscommand("${fs.value}"${fs.args ? `,"${fs.args}"` : ""})`);
    }
  }
  if (added) writeFileSync(tlPath, JSON.stringify(tl));
  grandTotal += added;
  console.log(`${scene}: +${added} fscommand action(s)${detail.length ? ` — ${detail.join("; ")}` : ""}`);
}
console.log(`\nTOTAL fscommand actions merged: ${grandTotal}`);
