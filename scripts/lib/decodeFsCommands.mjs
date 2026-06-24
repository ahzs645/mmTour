// Decode AVM1 `fscommand(command, args)` calls out of a SWF's DefineButton2 button
// handlers, straight from the action bytecode (no FFDec/Java needed). In AVM1,
// `fscommand("quit")` compiles to ActionGetURL (0x83) with url "FSCommand:quit" and
// the second string as the args, so we scan each button condition's bytecode for that.
//
// Returns: { [characterId: string]: { [event]: { value, args } } }  (events: release/press/rollOver/rollOut)
import { parseSwf } from "swf-parser";

const FS_PREFIX = "FSCommand:";

// AVM1 bytecode: action codes < 0x80 have no payload; codes >= 0x80 are followed by a
// u16 LE length then that many payload bytes. 0x00 ends the action list. 0x83 = GetURL.
function findFsCommandInBytecode(bytes) {
  let i = 0;
  while (i < bytes.length) {
    const code = bytes[i++];
    if (code === 0x00) break;
    if (code < 0x80) continue;
    const len = bytes[i] | (bytes[i + 1] << 8);
    i += 2;
    const payload = bytes.subarray(i, i + len);
    i += len;
    if (code === 0x83) {
      // two NUL-terminated strings: url, target(window/args)
      let z = payload.indexOf(0);
      if (z < 0) z = payload.length;
      const url = Buffer.from(payload.subarray(0, z)).toString("utf8");
      const rest = payload.subarray(z + 1);
      let z2 = rest.indexOf(0);
      if (z2 < 0) z2 = rest.length;
      const target = Buffer.from(rest.subarray(0, z2)).toString("utf8");
      if (url.toLowerCase().startsWith(FS_PREFIX.toLowerCase())) {
        return { value: url.slice(FS_PREFIX.length), args: target };
      }
    }
  }
  return null;
}

// Map a DefineButton2 condition record to the player's button event name.
function conditionToEvent(cond) {
  const c = cond ?? {};
  if (c.overDownToOverUp) return "release";
  if (c.overUpToOverDown) return "press";
  if (c.idleToOverUp || c.idleToOverDown || c.outDownToOverDown) return "rollOver";
  if (c.overUpToIdle || c.overDownToOutDown || c.outDownToIdle || c.overDownToIdle) return "rollOut";
  return "release";
}

export function decodeButtonFsCommands(swfBytes) {
  const movie = parseSwf(swfBytes);
  const out = {};
  for (const tag of movie.tags) {
    const conds = Array.isArray(tag.actions) ? tag.actions : null;
    if (!conds || tag.id == null) continue;
    // DefineButton2: each entry is a ButtonCondAction (has conditions + raw action bytes).
    if (!conds.length || !(conds[0]?.conditions || conds[0]?.condition)) continue;
    for (const a of conds) {
      const raw = a.actions instanceof Uint8Array ? a.actions : a.actions ? new Uint8Array(a.actions) : null;
      if (!raw?.length) continue;
      const fs = findFsCommandInBytecode(raw);
      if (!fs) continue;
      const event = conditionToEvent(a.conditions ?? a.condition);
      (out[String(tag.id)] ??= {})[event] = fs;
    }
  }
  return out;
}
