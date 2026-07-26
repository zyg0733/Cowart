import zlib from "node:zlib";

import { codedError } from "./object-aware-errors.mjs";

const PNG_CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = PNG_CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export function encodeMaskPng(width, height, region, { invert = false } = {}) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    const inRow = y >= region.y && y < region.y + region.h;
    for (let x = 0; x < width; x += 1) {
      const inRegion = inRow && x >= region.x && x < region.x + region.w;
      const transparent = invert ? !inRegion : inRegion;
      const o = rowStart + 1 + x * 4;
      raw[o] = 0;
      raw[o + 1] = 0;
      raw[o + 2] = 0;
      raw[o + 3] = transparent ? 0 : 255;
    }
  }
  return encodeRgbaPng(width, height, raw);
}

export function encodeAlphaMaskPng(width, height, alphaPixels) {
  if (!(alphaPixels instanceof Uint8Array) || alphaPixels.length !== width * height) {
    codedError("invalid_mask_pixels", "Edit alpha bytes must match width * height.", 400, { width, height });
  }
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = rowStart + 1 + x * 4;
      raw[o] = 0;
      raw[o + 1] = 0;
      raw[o + 2] = 0;
      raw[o + 3] = alphaPixels[y * width + x];
    }
  }
  return encodeRgbaPng(width, height, raw);
}

function encodeRgbaPng(width, height, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
