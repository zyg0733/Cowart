import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { assertCowartAssetWritableDestination } from "../shared/cowart-page-assets.mjs";
import { nonEmptyString, pathResolve } from "./paths.mjs";

export function extensionFromMimeType(mimeType) {
  switch (mimeType) {
    case "image/apng":
      return ".apng";
    case "image/avif":
      return ".avif";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/svg+xml":
      return ".svg";
    case "image/webp":
      return ".webp";
    case "image/png":
    default:
      return ".png";
  }
}

export function parseDataUrl(src) {
  const match = /^data:([^;,]+)?(?:;[^,]*)?,(.*)$/s.exec(src);
  if (!match) return null;
  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = /^data:[^,]*;base64,/i.test(src);
  const buffer = isBase64 ? Buffer.from(match[2], "base64") : Buffer.from(decodeURIComponent(match[2]));
  return { buffer, mimeType };
}

export async function resolveImageSource(args) {
  const dataUrl = nonEmptyString(args.imageDataUrl);
  const base64 = nonEmptyString(args.imageBase64);
  if (dataUrl || base64) {
    let buffer;
    let mimeType;
    if (dataUrl) {
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) throw new Error("imageDataUrl is not a valid data URL.");
      buffer = parsed.buffer;
      mimeType = nonEmptyString(args.mimeType) || parsed.mimeType;
    } else {
      buffer = Buffer.from(base64, "base64");
      mimeType = nonEmptyString(args.mimeType) || "image/png";
    }
    if (!buffer || buffer.length === 0) throw new Error("Decoded image data is empty.");
    let dimensions = null;
    try {
      dimensions = imageDimensionsFromBuffer(buffer);
    } catch {
      dimensions = null;
    }
    return {
      buffer,
      sourcePath: null,
      bytes: buffer.length,
      defaultName: nonEmptyString(args.fileName) || `image${extensionFromMimeType(mimeType)}`,
      dimensions,
    };
  }

  const imagePath = nonEmptyString(args.imagePath);
  if (!imagePath) throw new Error("Provide imagePath, imageBase64, or imageDataUrl.");
  const sourcePath = pathResolve(imagePath);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error(`imagePath is not a file: ${sourcePath}`);
  let dimensions = null;
  try {
    dimensions = imageDimensionsFromBuffer(await readFile(sourcePath));
  } catch {
    dimensions = null;
  }
  return {
    buffer: null,
    sourcePath,
    bytes: sourceStat.size,
    defaultName: nonEmptyString(args.fileName) || basename(sourcePath),
    dimensions,
  };
}

export async function writeResolvedImage(source, filePath, assetsDir) {
  const tempPath = join(dirname(filePath), `.cowart-tmp-${basename(filePath)}-${process.pid}-${randomUUID()}`);
  let handle = null;
  try {
    await assertCowartAssetWritableDestination(assetsDir, filePath);
    await assertCowartAssetWritableDestination(assetsDir, tempPath);
    handle = await open(tempPath, "wx", 0o600);
    if (source.buffer) await handle.writeFile(source.buffer);
    else await handle.writeFile(await readFile(source.sourcePath));
    await handle.close();
    handle = null;
    await assertCowartAssetWritableDestination(assetsDir, filePath);
    await rename(tempPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function getImageDimensions(filePath) {
  return imageDimensionsFromBuffer(await readFile(filePath));
}

export function imageDimensionsFromBuffer(buffer) {
  if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + size;
    }
  }
  if (buffer.length >= 16 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
    if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
      const b1 = buffer[21];
      const b2 = buffer[22];
      const b3 = buffer[23];
      const b4 = buffer[24];
      return {
        width: 1 + (b1 | ((b2 & 0x3f) << 8)),
        height: 1 + (((b2 & 0xc0) >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
      };
    }
  }
  throw new Error("Could not read image dimensions. Pass displayWidth/displayHeight and use a PNG/JPEG/WebP source.");
}
