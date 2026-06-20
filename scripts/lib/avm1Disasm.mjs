// AVM1 bytecode disassembly + low-level swf-parser binary readers for the
// control-flow builder (scripts/build-control-flow.mjs). Pure functions.

export function disassembleAvm1(bytes) {
  const actions = [];
  const pool = [];
  let offset = 0;

  while (offset < bytes.length) {
    const actionOffset = offset;
    const code = bytes[offset++];
    if (code === 0) {
      actions.push({ offset: actionOffset, op: "End" });
      break;
    }

    let body = new Uint8Array();
    if (code >= 0x80) {
      if (offset + 2 > bytes.length) {
        actions.push({ offset: actionOffset, op: `Action${hexByte(code)}`, malformed: true });
        break;
      }
      const length = bytes[offset] | (bytes[offset + 1] << 8);
      offset += 2;
      body = bytes.slice(offset, offset + length);
      offset += length;
    }

    actions.push(decodeAvm1Action(code, body, actionOffset, pool));
  }

  return actions;
}

export function decodeAvm1Action(code, body, offset, pool) {
  switch (code) {
    case 0x04:
      return { offset, op: "NextFrame" };
    case 0x05:
      return { offset, op: "PreviousFrame" };
    case 0x06:
      return { offset, op: "Play" };
    case 0x07:
      return { offset, op: "Stop" };
    case 0x17:
      return { offset, op: "Pop" };
    case 0x1c:
      return { offset, op: "GetVariable" };
    case 0x1d:
      return { offset, op: "SetVariable" };
    case 0x3d:
      return { offset, op: "CallFunction" };
    case 0x4e:
      return { offset, op: "GetMember" };
    case 0x52:
      return { offset, op: "CallMethod" };
    case 0x81:
      return { offset, op: "GotoFrame", frame: readU16(body, 0) };
    case 0x83:
      return { offset, op: "GetUrl", url: readCString(body, 0), target: readCString(body, readCString(body, 0).length + 1) };
    case 0x87:
      return { offset, op: "StoreRegister", register: body[0] };
    case 0x88: {
      pool.length = 0;
      const count = readU16(body, 0);
      let cursor = 2;
      for (let i = 0; i < count; i += 1) {
        const value = readCString(body, cursor);
        pool.push(value);
        cursor += value.length + 1;
      }
      return { offset, op: "ConstantPool", values: pool.slice() };
    }
    case 0x8a:
      return { offset, op: "WaitForFrame", frame: readU16(body, 0), skipCount: body[2] };
    case 0x8b:
      return { offset, op: "SetTarget", target: readCString(body, 0) };
    case 0x8c:
      return { offset, op: "GoToLabel", label: readCString(body, 0) };
    case 0x96:
      return { offset, op: "Push", values: decodePushValues(body, pool) };
    case 0x99:
      return { offset, op: "Jump", branchOffset: readS16(body, 0) };
    case 0x9d:
      return { offset, op: "If", branchOffset: readS16(body, 0) };
    case 0x9f:
      return { offset, op: "GotoFrame2", play: (body[0] & 1) !== 0, sceneBiasFlag: (body[0] & 2) !== 0, sceneBias: body.length >= 3 ? readU16(body, 1) : undefined };
    default:
      return { offset, op: actionName(code), actionCode: code, actionBytes: bytesToHex(body) };
  }
}

export function decodePushValues(body, pool) {
  const values = [];
  let cursor = 0;

  while (cursor < body.length) {
    const type = body[cursor++];
    if (type === 0) {
      const value = readCString(body, cursor);
      values.push({ type: "string", value });
      cursor += value.length + 1;
    } else if (type === 1) {
      values.push({ type: "float", value: new DataView(body.buffer, body.byteOffset + cursor, 4).getFloat32(0, true) });
      cursor += 4;
    } else if (type === 4) {
      values.push({ type: "register", value: body[cursor++] });
    } else if (type === 5) {
      values.push({ type: "boolean", value: body[cursor++] !== 0 });
    } else if (type === 6) {
      values.push({ type: "double", value: new DataView(body.buffer, body.byteOffset + cursor, 8).getFloat64(0, true) });
      cursor += 8;
    } else if (type === 7) {
      values.push({ type: "integer", value: readU32(body, cursor) });
      cursor += 4;
    } else if (type === 8) {
      const index = body[cursor++];
      values.push({ type: "constant8", index, value: pool[index] });
    } else if (type === 9) {
      const index = readU16(body, cursor);
      values.push({ type: "constant16", index, value: pool[index] });
      cursor += 2;
    } else {
      values.push({ type: `unknown:${type}` });
      break;
    }
  }

  return values;
}

export function actionName(code) {
  const names = {
    0x0a: "Add",
    0x0b: "Subtract",
    0x0c: "Multiply",
    0x0d: "Divide",
    0x0e: "Equals",
    0x0f: "Less",
    0x10: "And",
    0x11: "Or",
    0x12: "Not",
    0x13: "StringEquals",
    0x14: "StringLength",
    0x21: "StringAdd",
    0x22: "GetProperty",
    0x23: "SetProperty",
    0x24: "CloneSprite",
    0x25: "RemoveSprite",
    0x26: "Trace",
    0x27: "StartDrag",
    0x28: "EndDrag",
    0x29: "StringLess",
    0x2a: "Throw",
    0x2b: "CastOp",
    0x2c: "ImplementsOp",
    0x30: "RandomNumber",
    0x31: "MbStringLength",
    0x32: "CharToAscii",
    0x33: "AsciiToChar",
    0x34: "GetTime",
    0x35: "MbStringExtract",
    0x36: "MbCharToAscii",
    0x37: "MbAsciiToChar",
    0x3a: "Delete",
    0x3b: "Delete2",
    0x3c: "DefineLocal",
    0x3e: "Return",
    0x3f: "Modulo",
    0x40: "NewObject",
    0x41: "DefineLocal2",
    0x42: "InitArray",
    0x43: "InitObject",
    0x44: "TypeOf",
    0x45: "TargetPath",
    0x46: "Enumerate",
    0x47: "Add2",
    0x48: "Less2",
    0x49: "Equals2",
    0x4a: "ToNumber",
    0x4b: "ToString",
    0x4c: "PushDuplicate",
    0x4d: "StackSwap",
    0x4f: "SetMember",
    0x50: "Increment",
    0x51: "Decrement",
    0x53: "NewMethod",
    0x54: "InstanceOf",
    0x55: "Enumerate2",
    0x60: "BitAnd",
    0x61: "BitOr",
    0x62: "BitXor",
    0x63: "BitLShift",
    0x64: "BitRShift",
    0x65: "BitURShift",
    0x66: "StrictEquals",
    0x67: "Greater",
    0x68: "StringGreater",
    0x69: "Extends",
    0x8e: "DefineFunction2",
    0x8f: "Try",
    0x94: "With",
    0x9b: "DefineFunction",
  };
  return names[code] ?? `Action${hexByte(code)}`;
}

export function matrixFromParser(matrix) {
  return {
    a: fixedPointValue(matrix.scaleX),
    b: fixedPointValue(matrix.rotateSkew1),
    c: fixedPointValue(matrix.rotateSkew0),
    d: fixedPointValue(matrix.scaleY),
    tx: matrix.translateX / 20,
    ty: matrix.translateY / 20,
  };
}

export function fixedPointValue(value) {
  if (typeof value?.toValue === "function") return value.toValue();
  if (typeof value?.epsilons === "number") return value.epsilons / 65536;
  return Number(value) || 0;
}

export function readU16(bytes, offset) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

export function readS16(bytes, offset) {
  const value = readU16(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

export function readU32(bytes, offset) {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
}

// Browser-safe (also fine in Node): avoid the Buffer global so the disassembler
// can run in the in-browser converter as well as the Node pipeline.
const utf8Decoder = new TextDecoder("utf-8");

export function readCString(bytes, offset) {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  return utf8Decoder.decode(bytes.slice(offset, end));
}

export function bytesToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

export function hexByte(code) {
  return `0x${code.toString(16).padStart(2, "0")}`;
}
