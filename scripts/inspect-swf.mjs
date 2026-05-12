import { readFileSync } from "node:fs";

const tagNames = new Map([
  [0, "End"],
  [1, "ShowFrame"],
  [2, "DefineShape"],
  [4, "PlaceObject"],
  [5, "RemoveObject"],
  [6, "DefineBits"],
  [7, "DefineButton"],
  [8, "JPEGTables"],
  [9, "SetBackgroundColor"],
  [10, "DefineFont"],
  [11, "DefineText"],
  [12, "DoAction"],
  [14, "DefineSound"],
  [15, "StartSound"],
  [17, "DefineButtonSound"],
  [18, "SoundStreamHead"],
  [19, "SoundStreamBlock"],
  [20, "DefineBitsLossless"],
  [21, "DefineBitsJPEG2"],
  [22, "DefineShape2"],
  [23, "DefineButtonCxform"],
  [26, "PlaceObject2"],
  [28, "RemoveObject2"],
  [32, "DefineShape3"],
  [33, "DefineText2"],
  [34, "DefineButton2"],
  [35, "DefineBitsJPEG3"],
  [36, "DefineBitsLossless2"],
  [37, "DefineEditText"],
  [39, "DefineSprite"],
  [43, "FrameLabel"],
  [46, "DefineMorphShape"],
  [48, "DefineFont2"],
  [56, "ExportAssets"],
  [57, "ImportAssets"],
  [58, "EnableDebugger"],
  [59, "DoInitAction"],
  [60, "DefineVideoStream"],
  [61, "VideoFrame"],
  [62, "DefineFontInfo2"],
  [64, "EnableDebugger2"],
  [65, "ScriptLimits"],
  [66, "SetTabIndex"],
  [69, "FileAttributes"],
  [73, "DefineFontAlignZones"],
  [74, "CSMTextSettings"],
  [75, "DefineFont3"],
  [76, "SymbolClass"],
  [77, "Metadata"],
  [78, "DefineScalingGrid"],
  [82, "DoABC"],
  [83, "DefineShape4"],
  [84, "DefineMorphShape2"],
  [86, "DefineSceneAndFrameLabelData"],
  [87, "DefineBinaryData"],
  [88, "DefineFontName"],
  [89, "StartSound2"],
  [90, "DefineBitsJPEG4"],
]);

for (const file of process.argv.slice(2)) {
  const bytes = readFileSync(file);
  if (bytes.toString("ascii", 0, 3) !== "FWS") {
    throw new Error(`${file}: only uncompressed FWS is supported by this inspector`);
  }

  const version = bytes[3];
  const fileLength = bytes.readUInt32LE(4);
  const rectBits = bytes[8] >> 3;
  const rectBytes = Math.ceil((5 + rectBits * 4) / 8);
  let offset = 8 + rectBytes;
  const frameRate = bytes.readUInt16LE(offset) / 256;
  const frameCount = bytes.readUInt16LE(offset + 2);
  offset += 4;

  const counts = new Map();
  const idsByTag = new Map();
  const spriteFrames = [];
  let timelineTags = 0;

  while (offset < bytes.length) {
    const header = bytes.readUInt16LE(offset);
    offset += 2;
    const code = header >> 6;
    let length = header & 0x3f;
    if (length === 0x3f) {
      length = bytes.readUInt32LE(offset);
      offset += 4;
    }
    const bodyOffset = offset;
    const name = tagNames.get(code) ?? `Tag${code}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (isDefinitionWithId(code) && length >= 2) {
      const id = bytes.readUInt16LE(bodyOffset);
      const ids = idsByTag.get(name) ?? [];
      ids.push(id);
      idsByTag.set(name, ids);
    }
    if (code === 39 && length >= 4) {
      spriteFrames.push({ id: bytes.readUInt16LE(bodyOffset), frames: bytes.readUInt16LE(bodyOffset + 2) });
    }
    if (code === 1 || code === 4 || code === 5 || code === 12 || code === 26 || code === 28 || code === 43) {
      timelineTags += 1;
    }
    offset += length;
    if (code === 0) break;
  }

  const orderedCounts = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(JSON.stringify({
    file,
    version,
    fileLength,
    frameRate,
    frameCount,
    timelineTags,
    counts: Object.fromEntries(orderedCounts),
    definitions: Object.fromEntries([...idsByTag.entries()].map(([name, ids]) => [name, ids.length])),
    largestSprites: spriteFrames.sort((a, b) => b.frames - a.frames).slice(0, 10),
  }, null, 2));
}

function isDefinitionWithId(code) {
  return [
    2, 6, 7, 10, 11, 14, 20, 21, 22, 32, 33, 34, 35, 36, 37, 39, 46, 48, 60, 75, 83, 84, 87, 90,
  ].includes(code);
}
