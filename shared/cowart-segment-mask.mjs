import { createHash } from "node:crypto";
import zlib from "node:zlib";

export class CowartSegmentMaskError extends Error {
  constructor(code, message, details = {}) { super(message); Object.assign(this, { name: "CowartSegmentMaskError", code, details }); }
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const SEGMENT_MASK_LIMITS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxPixels: 40_000_000, maxDimension: 8192 });
export const MORPHOLOGY_LIMITS = Object.freeze({ expandPixels: 64, contractPixels: 64, featherPixels: 32 });
const fail = (code, message, details) => {
  throw new CowartSegmentMaskError(code, message, details);
};
const failTooLarge = (bytes, maxBytes) => fail("png_too_large", "Encoded PNG exceeds configured byte limit.", { bytes, maxBytes });
const crc32 = (parts) => zlib.crc32(Buffer.concat(parts)) >>> 0;
const checkedDimensions = (width, height, options = {}) => {
  const limits = { ...SEGMENT_MASK_LIMITS, ...options };
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) fail("invalid_mask_dimensions", "Mask dimensions must be positive integers.", { width, height });
  if (width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) fail("png_too_large", "Decoded PNG dimensions exceed configured limits.", { width, height, maxPixels: limits.maxPixels, maxDimension: limits.maxDimension });
  return limits;
};
const checkedPixels = (mask) => {
  if (!(mask?.pixels instanceof Uint8Array) || mask.pixels.length !== mask.width * mask.height) {
    fail("invalid_mask_pixels", "Mask pixel bytes must match width * height.", { actual: mask?.pixels?.length, expected: mask?.width * mask?.height });
  }
  return mask.pixels;
};
const chunk = (type, data) => {
  const typeBuffer = Buffer.from(type, "ascii");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  typeBuffer.copy(header, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([typeBuffer, data]), 0);
  return Buffer.concat([header, data, crc]);
};

export function encodeCanonicalMaskPng(mask, options = {}) {
  const width = mask?.width;
  const height = mask?.height;
  checkedDimensions(width, height, options);
  const pixels = checkedPixels(mask);
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width + 1);
    raw[row] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width, width).copy(raw, row + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const boundedBufferFrom = (input, limits) => {
  if (input == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(input)) {
    if (input.length > limits.maxBytes) failTooLarge(input.length, limits.maxBytes);
    return input;
  }
  if (typeof input === "string") {
    const bytes = Buffer.byteLength(input);
    if (bytes > limits.maxBytes) failTooLarge(bytes, limits.maxBytes);
    return Buffer.from(input);
  }
  if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && input instanceof SharedArrayBuffer)) {
    if (input.byteLength > limits.maxBytes) failTooLarge(input.byteLength, limits.maxBytes);
    return Buffer.from(input);
  }
  if (ArrayBuffer.isView(input)) {
    if (input.byteLength > limits.maxBytes) failTooLarge(input.byteLength, limits.maxBytes);
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) {
    if (input.length > limits.maxBytes) failTooLarge(input.length, limits.maxBytes);
    return Buffer.from(input);
  }
  fail("invalid_png_input", "PNG input must be a Buffer, string, ArrayBuffer, typed array, or byte array.");
};

const parsePng = (input, options) => {
  const limits = { ...SEGMENT_MASK_LIMITS, ...options };
  const buffer = boundedBufferFrom(input, limits);
  if (buffer.length > limits.maxBytes) fail("png_too_large", "Encoded PNG exceeds configured byte limit.", { bytes: buffer.length, maxBytes: limits.maxBytes });
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) fail("png_malformed", "Input is not a PNG file.");
  let offset = 8;
  const chunks = [];
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) fail("png_malformed", "PNG chunk is truncated.", { offset });
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8);
    const typeName = type.toString("ascii");
    if (chunks.length === 0 && typeName !== "IHDR") fail("png_malformed", "PNG first chunk must be IHDR.", { type: typeName });
    if (typeName === "IHDR" && chunks.length > 0) fail("png_malformed", "PNG IHDR chunk must appear first.");
    if (typeName === "IHDR" && length !== 13) fail("png_malformed", "PNG IHDR chunk must be 13 bytes.", { length });
    if (typeName === "IEND" && length !== 0) fail("png_malformed", "PNG IEND chunk must be empty.", { length });
    const dataStart = offset + 8, dataEnd = dataStart + length, crcEnd = dataEnd + 4;
    if (crcEnd > buffer.length) fail("png_malformed", "PNG chunk data is truncated.", { offset, length });
    const expected = buffer.readUInt32BE(dataEnd);
    const actual = crc32([type, buffer.subarray(dataStart, dataEnd)]);
    if (expected !== actual) fail("png_malformed", "PNG chunk CRC mismatch.", { type: type.toString("ascii") });
    if (typeName === "IEND" && crcEnd !== buffer.length) fail("png_malformed", "PNG IEND chunk must be final.", { offset: crcEnd, bytes: buffer.length });
    chunks.push({ type: typeName, data: buffer.subarray(dataStart, dataEnd) });
    if (typeName === "IHDR") {
      const ihdr = chunks.at(-1).data;
      checkedDimensions(ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), limits);
      if (ihdr[8] !== 8 || ihdr[9] !== 0) fail("png_unsupported_color_type", "Only 8-bit grayscale PNG masks are supported.", { bitDepth: ihdr[8], colorType: ihdr[9] });
      if (ihdr[10] !== 0 || ihdr[11] !== 0) fail("png_malformed", "PNG uses unsupported compression or filter method.");
      if (ihdr[12] !== 0) fail("png_interlaced", "Interlaced PNG masks are not supported.");
    }
    offset = crcEnd;
    if (chunks.at(-1).type === "IEND") break;
  }
  if (chunks.at(-1)?.type !== "IEND") fail("png_malformed", "PNG is missing an IEND chunk.");
  return chunks;
};
const unfilter = (raw, width, height) => {
  const stride = width + 1;
  if (raw.length !== stride * height) fail("png_malformed", "Inflated grayscale data has an unexpected size.", { actual: raw.length, expected: stride * height });
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride, out = y * width;
    const prev = y === 0 ? null : pixels.subarray(out - width, out);
    for (let x = 0; x < width; x += 1) {
      const left = x === 0 ? 0 : pixels[out + x - 1];
      const up = prev ? prev[x] : 0, upLeft = prev && x > 0 ? prev[x - 1] : 0;
      const pa = Math.abs(up - upLeft), pb = Math.abs(left - upLeft), pc = Math.abs(left + up - 2 * upLeft);
      const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      const byte = raw[row + 1 + x];
      switch (raw[row]) {
        case 0: pixels[out + x] = byte; break;
        case 1: pixels[out + x] = (byte + left) & 255; break;
        case 2: pixels[out + x] = (byte + up) & 255; break;
        case 3: pixels[out + x] = (byte + Math.floor((left + up) / 2)) & 255; break;
        case 4: pixels[out + x] = (byte + predictor) & 255; break;
        default: fail("png_malformed", "PNG uses an invalid scanline filter.", { filter: raw[row] });
      }
    }
  }
  return pixels;
};

export function decodeCanonicalMaskPng(input, options = {}) {
  const chunks = parsePng(input, options);
  const ihdr = chunks.find((item) => item.type === "IHDR")?.data;
  if (!ihdr || ihdr.length !== 13) fail("png_malformed", "PNG is missing a valid IHDR chunk.");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  checkedDimensions(width, height, options);
  const idat = Buffer.concat(chunks.filter((item) => item.type === "IDAT").map((item) => item.data));
  if (idat.length === 0) fail("png_malformed", "PNG is missing image data.");
  const expected = height * (width + 1);
  let raw;
  try { raw = zlib.inflateSync(idat, { maxOutputLength: expected }); }
  catch (error) { fail("png_malformed", "PNG image data could not be inflated.", { cause: error instanceof Error ? error.message : String(error) }); }
  return { width, height, pixels: unfilter(raw, width, height) };
}

export function summarizeSelectionMask(mask) {
  checkedDimensions(mask?.width, mask?.height);
  const pixels = checkedPixels(mask);
  let minX = mask.width, minY = mask.height, maxX = -1, maxY = -1, area = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    if (pixels[index] === 0) continue;
    const x = index % mask.width;
    const y = Math.floor(index / mask.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    area += 1;
  }
  const bbox = area === 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  return { bbox, area, sha256: createHash("sha256").update(encodeCanonicalMaskPng(mask)).digest("hex") };
}

export function selectionToEditAlpha(selectionWeights) {
  if (!(selectionWeights instanceof Uint8Array)) fail("invalid_mask_pixels", "Selection weights must be Uint8Array.");
  return Uint8Array.from(selectionWeights, (value) => 255 - value);
}

const binary = (pixels) => Uint8Array.from(pixels, (value) => (value > 0 ? 1 : 0));
const clampToByte = (value) => Math.max(0, Math.min(255, value));
const CARDINAL_NEIGHBORS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
const FORWARD_NEIGHBORS = [[-1, 0], [0, -1], [-1, -1], [1, -1]];
const BACKWARD_NEIGHBORS = [[1, 0], [0, 1], [1, 1], [-1, 1]];
const morph = (src, width, height, expand) => {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let any = false, all = true;
      for (const [dx, dy] of CARDINAL_NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        const hit = nx >= 0 && nx < width && ny >= 0 && ny < height && src[ny * width + nx] === 1;
        any ||= hit; all &&= hit;
      }
      out[y * width + x] = expand ? Number(any) : Number(all);
    }
  }
  return out;
};
const distanceTransformChebyshev = (src, width, height, seedValue, maxDistance) => {
  const distances = new Uint16Array(src.length);
  distances.fill(maxDistance);
  for (let index = 0; index < src.length; index += 1) if (src[index] === seedValue) distances[index] = 0;
  const relax = (index, candidate) => {
    if (candidate < distances[index]) distances[index] = candidate > maxDistance ? maxDistance : candidate;
  };
  const scan = (yStart, yEnd, yStep, xStart, xEnd, xStep, neighbors) => {
    for (let y = yStart; y !== yEnd; y += yStep) {
      for (let x = xStart; x !== xEnd; x += xStep) {
        const index = y * width + x;
        if (distances[index] === 0) continue;
        for (const [dx, dy] of neighbors) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) relax(index, distances[ny * width + nx] + 1);
        }
      }
    }
  };
  scan(0, height, 1, 0, width, 1, FORWARD_NEIGHBORS);
  scan(height - 1, -1, -1, width - 1, -1, -1, BACKWARD_NEIGHBORS);
  return distances;
};
const feather = (src, width, height, radius) => {
  if (radius <= 0) return Uint8Array.from(src, (value) => value * 255);
  const out = new Uint8Array(src.length);
  const maxDistance = radius + 1;
  const toBackground = distanceTransformChebyshev(src, width, height, 0, maxDistance);
  for (let index = 0; index < src.length; index += 1) {
    if (src[index] === 1) out[index] = clampToByte(Math.round((255 * (toBackground[index] + 1)) / (radius + 2)));
  }
  const toSelected = distanceTransformChebyshev(src, width, height, 1, maxDistance);
  for (let index = 0; index < src.length; index += 1) {
    if (src[index] === 0) out[index] = clampToByte(Math.round((255 * Math.max(0, radius + 1 - toSelected[index])) / (radius + 2)));
  }
  return out;
};
const checkedMorphologyAmount = (operations, field) => {
  const value = operations?.[field] ?? 0;
  const max = MORPHOLOGY_LIMITS[field];
  if (!Number.isInteger(value) || value < 0 || value > max) fail("invalid_morphology_parameter", "Morphology parameters must be finite non-negative integers within configured limits.", { field, received: String(value), max });
  return value;
};

export function refineSelectionMask(mask, operations = {}) {
  checkedDimensions(mask?.width, mask?.height);
  const pixels = checkedPixels(mask);
  const expandPixels = checkedMorphologyAmount(operations, "expandPixels");
  const contractPixels = checkedMorphologyAmount(operations, "contractPixels");
  const featherPixels = checkedMorphologyAmount(operations, "featherPixels");
  // Morphology is O(width * height * radius) with radius capped above; feather is O(width * height).
  let work = binary(pixels);
  for (let i = 0; i < expandPixels; i += 1) work = morph(work, mask.width, mask.height, true);
  for (let i = 0; i < contractPixels; i += 1) work = morph(work, mask.width, mask.height, false);
  return { width: mask.width, height: mask.height, pixels: feather(work, mask.width, mask.height, featherPixels) };
}
