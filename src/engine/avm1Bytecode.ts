// Pure AVM1 bytecode readers for the Direct SWF renderer: constant pool, push
// values, function definitions, and value equality. Operate on raw byte slices.

import type { Avm1FunctionDef, Avm1Value } from "./GsapSwfRenderer.types";
import { decodeBytes, toAvm1Number, toAvm1String } from "./avm1Values";

export function readConstantPool(bytes: Uint8Array): string[] {
  if (bytes.length < 2) return [];

  const poolSize = bytes[0] | (bytes[1] << 8);
  const pool: string[] = [];
  let pos = 2;

  for (let i = 0; i < poolSize && pos < bytes.length; i++) {
    const end = bytes.indexOf(0, pos);
    if (end === -1) {
      pool.push(decodeBytes(bytes.subarray(pos)));
      break;
    }
    pool.push(decodeBytes(bytes.subarray(pos, end)));
    pos = end + 1;
  }

  return pool;
}

export function readPushValues(bytes: Uint8Array, constantPool: string[], stack: Avm1Value[]) {
  let pos = 0;

  while (pos < bytes.length) {
    const valueType = bytes[pos++];

    switch (valueType) {
      case 0x00: {
        const end = bytes.indexOf(0, pos);
        if (end === -1) {
          stack.push(decodeBytes(bytes.subarray(pos)));
          return;
        }
        stack.push(decodeBytes(bytes.subarray(pos, end)));
        pos = end + 1;
        break;
      }

      case 0x02:
        stack.push(null);
        break;

      case 0x03:
        stack.push(undefined);
        break;

      case 0x05:
        stack.push(bytes[pos++] !== 0);
        break;

      case 0x07:
        stack.push(
          bytes[pos] |
          (bytes[pos + 1] << 8) |
          (bytes[pos + 2] << 16) |
          (bytes[pos + 3] << 24),
        );
        pos += 4;
        break;

      case 0x08:
        stack.push(constantPool[bytes[pos++]] ?? undefined);
        break;

      case 0x09: {
        const index = bytes[pos] | (bytes[pos + 1] << 8);
        stack.push(constantPool[index] ?? undefined);
        pos += 2;
        break;
      }

      default:
        return;
    }
  }
}

export function readFunctionDefinition(
  bytes: Uint8Array,
  headerStart: number,
  headerEnd: number,
  constantPool: string[],
): { def: Avm1FunctionDef; nextPos: number } | null {
  const header = bytes.subarray(headerStart, headerEnd);
  let pos = 0;
  const nameEnd = header.indexOf(0, pos);
  if (nameEnd === -1) return null;

  const name = decodeBytes(header.subarray(pos, nameEnd));
  pos = nameEnd + 1;
  if (pos + 2 > header.length) return null;

  const paramCount = header[pos] | (header[pos + 1] << 8);
  pos += 2;

  const params: string[] = [];
  for (let i = 0; i < paramCount && pos < header.length; i++) {
    const end = header.indexOf(0, pos);
    if (end === -1) return null;
    params.push(decodeBytes(header.subarray(pos, end)));
    pos = end + 1;
  }

  if (pos + 2 > header.length) return null;
  const codeSize = header[pos] | (header[pos + 1] << 8);

  const bodyStart = headerEnd;
  const bodyEnd = Math.min(bytes.length, bodyStart + codeSize);
  return {
    def: {
      name,
      params,
      body: bytes.subarray(bodyStart, bodyEnd),
      constantPool: [...constantPool],
    },
    nextPos: bodyEnd,
  };
}

export function avm1Equals(a: Avm1Value, b: Avm1Value): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    return toAvm1Number(a) === toAvm1Number(b);
  }
  return toAvm1String(a) === toAvm1String(b);
}
