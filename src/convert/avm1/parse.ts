// AVM1 bytecode → a structured action list where DefineFunction/DefineFunction2
// carry their body as a nested program (the flat disassembler inlines bodies,
// which a VM can't execute). Pure, browser-safe.

import type { Avm1Op } from "../../data/avm1Bytecode.ts";

/** The parser's action type is the shared canonical op shape (see data/avm1Bytecode). */
export type Avm1Action = Avm1Op;

const dec = new TextDecoder("utf-8");
const readCStr = (b: Uint8Array, o: number) => {
  let e = o;
  while (e < b.length && b[e] !== 0) e++;
  return { str: dec.decode(b.subarray(o, e)), next: e + 1 };
};
const u16 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8));
const s16 = (b: Uint8Array, o: number) => { const v = u16(b, o); return v & 0x8000 ? v - 0x10000 : v; };
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function decodePush(body: Uint8Array, pool: string[]): any[] {
  const out: any[] = [];
  let c = 0;
  while (c < body.length) {
    const t = body[c++];
    if (t === 0) { const r = readCStr(body, c); out.push({ type: "string", value: r.str }); c = r.next; }
    else if (t === 1) { out.push({ type: "float", value: new DataView(body.buffer, body.byteOffset + c, 4).getFloat32(0, true) }); c += 4; }
    else if (t === 2) out.push({ type: "null", value: null });
    else if (t === 3) out.push({ type: "undefined", value: undefined });
    else if (t === 4) out.push({ type: "register", value: body[c++] });
    else if (t === 5) out.push({ type: "boolean", value: body[c++] !== 0 });
    else if (t === 6) { out.push({ type: "double", value: new DataView(body.buffer, body.byteOffset + c, 8).getFloat64(0, true) }); c += 8; }
    else if (t === 7) { out.push({ type: "integer", value: (u32(body, c) | 0) }); c += 4; }
    else if (t === 8) { const i = body[c++]; out.push({ type: "constant", value: pool[i] }); }
    else if (t === 9) { const i = u16(body, c); out.push({ type: "constant", value: pool[i] }); c += 2; }
    else { out.push({ type: "unknown" }); break; }
  }
  return out;
}

const NAMES: Record<number, string> = {
  0x04: "NextFrame", 0x05: "PrevFrame", 0x06: "Play", 0x07: "Stop", 0x0a: "Add", 0x0b: "Subtract", 0x0c: "Multiply",
  0x0d: "Divide", 0x0e: "Equals", 0x0f: "Less", 0x10: "And", 0x11: "Or", 0x12: "Not", 0x13: "StringEquals",
  0x17: "Pop", 0x18: "ToInteger", 0x1c: "GetVariable", 0x1d: "SetVariable", 0x20: "SetTarget2",
  0x21: "StringAdd", 0x22: "GetProperty", 0x23: "SetProperty", 0x24: "CloneSprite", 0x25: "RemoveSprite",
  0x26: "Trace", 0x34: "GetTime", 0x3a: "Delete", 0x3b: "Delete2", 0x3c: "DefineLocal", 0x3d: "CallFunction",
  0x3e: "Return", 0x3f: "Modulo", 0x40: "NewObject", 0x41: "DefineLocal2", 0x42: "InitArray",
  0x43: "InitObject", 0x44: "TypeOf", 0x47: "Add2", 0x48: "Less2", 0x49: "Equals2", 0x4a: "ToNumber",
  0x4b: "ToString", 0x4c: "PushDuplicate", 0x4d: "StackSwap", 0x4e: "GetMember", 0x4f: "SetMember",
  0x50: "Increment", 0x51: "Decrement", 0x52: "CallMethod", 0x53: "NewMethod", 0x54: "InstanceOf",
  0x55: "Enumerate2", 0x66: "StrictEquals", 0x67: "Greater", 0x69: "Extends", 0x9a: "GetUrl2", 0x9e: "Call",
};

/** Parse an AVM1 bytecode block into actions, nesting DefineFunction bodies and
 *  resolving If/Jump offsets to action indices. */
export function parseProgram(bytes: Uint8Array<ArrayBufferLike>): Avm1Action[] {
  return parseProgramWithPool(bytes, []);
}

function parseProgramWithPool(bytes: Uint8Array<ArrayBufferLike>, inheritedPool: string[]): Avm1Action[] {
  const pool: string[] = inheritedPool.slice();
  // first pass: linear decode with byte offsets so we can resolve branch targets
  const raw: { offset: number; end: number; action: Avm1Action }[] = [];
  let o = 0;
  while (o < bytes.length) {
    const start = o;
    const code = bytes[o++];
    if (code === 0) { raw.push({ offset: start, end: o, action: { op: "End", code } }); break; }
    let body: Uint8Array<ArrayBufferLike> = new Uint8Array();
    if (code >= 0x80) {
      const len = u16(bytes, o); o += 2;
      body = bytes.subarray(o, o + len); o += len;
    }
    raw.push({ offset: start, end: o, action: decode(code, body, bytes, o, pool, raw) });
    // DefineFunction(2) consume their body bytes from the stream
    const a = raw[raw.length - 1].action;
    if (a.op === "DefineFunction" || a.op === "DefineFunction2") {
      const size = (a as any)._codeSize ?? 0;
      a.body = parseProgramWithPool(bytes.subarray(o, o + size), pool);
      o += size;
      raw[raw.length - 1].end = o;
      delete (a as any)._codeSize;
    }
  }
  // resolve branch offsets (If/Jump) — byte delta from end of the action to a target offset
  const offsetToIndex = new Map<number, number>();
  raw.forEach((r, i) => offsetToIndex.set(r.offset, i));
  raw.forEach((r) => {
    const a = r.action;
    if ((a.op === "If" || a.op === "Jump") && a.branchOffset !== undefined) {
      const targetOffset = r.end + a.branchOffset;
      const fallback = targetOffset >= bytes.length ? raw.length : raw.findIndex((x) => x.offset >= targetOffset);
      a.jumpTo = offsetToIndex.get(targetOffset) ?? fallback;
    }
  });
  return raw.map((r) => r.action);
}

function decode(code: number, body: Uint8Array, _all: Uint8Array, _after: number, pool: string[], _raw: any[]): Avm1Action {
  switch (code) {
    case 0x88: { // ConstantPool
      pool.length = 0;
      const count = u16(body, 0); let c = 2;
      for (let i = 0; i < count; i++) { const r = readCStr(body, c); pool.push(r.str); c = r.next; }
      return { op: "ConstantPool", code, values: pool.slice() };
    }
    case 0x96: return { op: "Push", code, values: decodePush(body, pool) };
    case 0x81: return { op: "GotoFrame", code, frame: u16(body, 0) };
    case 0x8c: return { op: "GotoLabel", code, label: readCStr(body, 0).str };
    case 0x8b: return { op: "SetTarget", code, target: readCStr(body, 0).str };
    case 0x87: return { op: "StoreRegister", code, register: body[0] };
    case 0x99: return { op: "Jump", code, branchOffset: s16(body, 0) };
    case 0x9d: return { op: "If", code, branchOffset: s16(body, 0) };
    case 0x9a: return {
      op: "GetUrl2",
      code,
      // JPEXS reads these as the high bits: loadVariables, loadTarget, reserved, sendVars.
      loadVariablesFlag: (body[0] & 0x80) !== 0,
      loadTargetFlag: (body[0] & 0x40) !== 0,
      sendVarsMethod: body[0] & 0x03,
    };
    case 0x9f: return { op: "GotoFrame2", code, play: (body[0] & 1) !== 0 };
    case 0x83: { const u = readCStr(body, 0); const t = readCStr(body, u.next); return { op: "GetUrl", code, url: u.str, target: t.str }; }
    case 0x9b: { // DefineFunction
      const n = readCStr(body, 0); let c = n.next;
      const np = u16(body, c); c += 2;
      const params: { name: string }[] = [];
      for (let i = 0; i < np; i++) { const p = readCStr(body, c); params.push({ name: p.str }); c = p.next; }
      const codeSize = u16(body, c);
      return { op: "DefineFunction", code, name: n.str, params, _codeSize: codeSize } as any;
    }
    case 0x8e: { // DefineFunction2
      const n = readCStr(body, 0); let c = n.next;
      const np = u16(body, c); c += 2;
      const registerCount = body[c++];
      const flags = u16(body, c); c += 2;
      const params: { register?: number; name: string }[] = [];
      for (let i = 0; i < np; i++) { const reg = body[c++]; const p = readCStr(body, c); params.push({ register: reg, name: p.str }); c = p.next; }
      const codeSize = u16(body, c);
      return { op: "DefineFunction2", code, name: n.str, params, registerCount, flags, _codeSize: codeSize } as any;
    }
    default:
      return { op: NAMES[code] ?? `Op${code.toString(16)}`, code };
  }
}
