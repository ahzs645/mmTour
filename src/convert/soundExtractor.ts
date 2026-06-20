// Browser-native SWF sound extractor (Route B). Replaces FFDec's `sound:mp3_wav`
// export. swf-parser surfaces `DefineSound { format, soundRate, soundSize,
// soundType, sampleCount, data }`.
//
//   format 2 (MP3)          → strip the 2-byte seekSamples prefix; the rest is a
//                             ready-to-play MP3 stream (no decode/re-encode)
//   format 0/3 (PCM)        → wrap the samples in a WAV header
//   format 1 (ADPCM)        → decode SWF-ADPCM to 16-bit PCM, then WAV
//
// MP3 is by far the common case (the whole tour is MP3); extraction is lossless
// and byte-exact, so the platform <audio>/AudioContext plays it directly.

import { swf } from "swf-parser";

const FMT_PCM_NATIVE = 0;
const FMT_ADPCM = 1;
const FMT_MP3 = 2;
const FMT_PCM_LE = 3;

/** soundRate is the actual sample rate in some swf-parser builds, an enum index in others. */
const RATE_TABLE = [5512, 11025, 22050, 44100];
function sampleRate(soundRate: number): number {
  return soundRate <= 3 ? RATE_TABLE[soundRate] : soundRate;
}

export function collectSounds(movie: any): any[] {
  return movie.tags.filter((t: any) => t.type === swf.TagType.DefineSound);
}

export interface ExtractedSound {
  id: number;
  mime: string;
  ext: "mp3" | "wav";
  bytes: Uint8Array;
}

export function extractSound(tag: any): ExtractedSound {
  if (tag.format === FMT_MP3) {
    // data = seekSamples (Int16) + MP3 frames. Drop the 2-byte seek.
    return { id: tag.id, mime: "audio/mpeg", ext: "mp3", bytes: tag.data.subarray(2) };
  }
  const channels = tag.soundType ? 2 : 1; // 0 mono, 1 stereo
  const rate = sampleRate(tag.soundRate);
  if (tag.format === FMT_PCM_NATIVE || tag.format === FMT_PCM_LE) {
    const bits = tag.soundSize ? 16 : 8;
    return { id: tag.id, mime: "audio/wav", ext: "wav", bytes: wav(tag.data, rate, channels, bits) };
  }
  if (tag.format === FMT_ADPCM) {
    const pcm = decodeAdpcm(tag.data, channels);
    return { id: tag.id, mime: "audio/wav", ext: "wav", bytes: wav(pcm, rate, channels, 16) };
  }
  throw new Error(`sound format ${tag.format} not supported (id ${tag.id})`);
}

function bytesToBase64(bytes: Uint8Array): string {
  const nodeBuffer = (globalThis as any).Buffer;
  if (nodeBuffer) return nodeBuffer.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function soundToDataUrl(tag: any): { id: number; mime: string; dataUrl: string } {
  const s = extractSound(tag);
  return { id: s.id, mime: s.mime, dataUrl: `data:${s.mime};base64,${bytesToBase64(s.bytes)}` };
}

/** Wrap raw little-endian PCM in a canonical 44-byte WAV header. */
function wav(pcm: Uint8Array, rate: number, channels: number, bits: number): Uint8Array {
  const blockAlign = (channels * bits) >> 3;
  const byteRate = rate * blockAlign;
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true); // PCM fmt chunk size
  dv.setUint16(20, 1, true); // audio format = PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bits, true);
  ascii(36, "data");
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

// --- SWF ADPCM decoder (unused by this tour, included for completeness) ---
const ADPCM_STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80,
  88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544,
  598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749,
  3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635,
  13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX_TABLE_2 = [-1, 2];
const INDEX_TABLE_3 = [-1, -1, 2, 4];
const INDEX_TABLE_4 = [-1, -1, -1, -1, 2, 4, 6, 8];
const INDEX_TABLE_5 = [-1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 4, 6, 8, 10, 13, 16];

function decodeAdpcm(data: Uint8Array, channels: number): Uint8Array {
  const reader = new BitReader(data);
  const codeSize = reader.read(2) + 2; // 2..5 bits per sample
  const indexTable = [INDEX_TABLE_2, INDEX_TABLE_3, INDEX_TABLE_4, INDEX_TABLE_5][codeSize - 2];
  const out: number[] = [];
  const sample = new Int32Array(channels);
  const index = new Int32Array(channels);

  while (reader.remaining() >= codeSize * channels + 1) {
    for (let c = 0; c < channels; c++) {
      sample[c] = signExtend(reader.read(16), 16);
      index[c] = reader.read(6);
    }
    out.push(...emit(sample, channels));
    for (let n = 0; n < 4095 && reader.remaining() >= codeSize * channels; n++) {
      for (let c = 0; c < channels; c++) {
        const code = reader.read(codeSize);
        const step = ADPCM_STEP[index[c]];
        let diff = step >> (codeSize - 1);
        for (let bit = 0; bit < codeSize - 1; bit++) if (code & (1 << bit)) diff += step >> (codeSize - 2 - bit);
        sample[c] += code & (1 << (codeSize - 1)) ? -diff : diff;
        sample[c] = Math.max(-32768, Math.min(32767, sample[c]));
        index[c] = Math.max(0, Math.min(88, index[c] + indexTable[code & ((1 << (codeSize - 1)) - 1)]));
      }
      out.push(...emit(sample, channels));
    }
  }
  const buf = new Uint8Array(out.length * 2);
  const dv = new DataView(buf.buffer);
  out.forEach((s, i) => dv.setInt16(i * 2, s, true));
  return buf;
}

function emit(sample: Int32Array, channels: number): number[] {
  const r: number[] = [];
  for (let c = 0; c < channels; c++) r.push(sample[c]);
  return r;
}
function signExtend(v: number, bits: number): number {
  const m = 1 << (bits - 1);
  return (v ^ m) - m;
}

class BitReader {
  private pos = 0;
  private data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.pos >> 3] ?? 0;
      const bit = (byte >> (7 - (this.pos & 7))) & 1;
      v = (v << 1) | bit;
      this.pos++;
    }
    return v;
  }
  remaining(): number {
    return this.data.length * 8 - this.pos;
  }
}
