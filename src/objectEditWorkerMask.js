import { ObjectEditWorkerError } from './objectEditWorkerConfig.js'

const MAX_MASK_SIDE = 8192
const MAX_MASK_PIXELS = 40_000_000
const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const byte = (value) => value & 255

export function normalizeObjectEditRoi(selection) {
  if (selection?.mode === 'scribble' && Array.isArray(selection.points) && selection.points.length > 0) {
    const average = selection.points.reduce((sum, point) => ({
      x: sum.x + clamp01(point?.x),
      y: sum.y + clamp01(point?.y)
    }), { x: 0, y: 0 })
    return {
      keypoint: {
        x: Number((average.x / selection.points.length).toFixed(4)),
        y: Number((average.y / selection.points.length).toFixed(4))
      }
    }
  }
  return { keypoint: { x: clamp01(selection?.point?.x), y: clamp01(selection?.point?.y) } }
}

export function validateMaskDimensions(mask, label) {
  const width = Number(mask?.width)
  const height = Number(mask?.height)
  const area = width * height
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_MASK_SIDE ||
    height > MAX_MASK_SIDE ||
    area > MAX_MASK_PIXELS
  ) {
    throw new ObjectEditWorkerError(
      'invalid_mask_dimensions',
      `${label} dimensions must be positive integers, <=8192 per side, and <=40MP.`,
      { width, height }
    )
  }
  return { width, height, area }
}

function assertRawBytes(raw, expectedLength, ctor, label) {
  if (!(raw instanceof ctor) || raw.length !== expectedLength) {
    throw new ObjectEditWorkerError(
      'invalid_mask_bytes',
      `${label} raw data must be ${ctor.name} with expected ${expectedLength} values.`,
      { actualType: raw?.constructor?.name, actualLength: raw?.length, expectedLength }
    )
  }
}

function closeMask(mask) {
  try {
    mask?.close?.()
  } catch (error) {
    void error
  }
}

function resizeMask(pixels, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) return pixels
  const out = new Uint8Array(targetWidth * targetHeight)
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / targetHeight))
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / targetWidth))
      out[y * targetWidth + x] = pixels[sourceY * sourceWidth + sourceX]
    }
  }
  return out
}

function roiPixelIndex(roi, width, height) {
  const point = roi?.keypoint ?? { x: 0.5, y: 0.5 }
  const x = Math.min(width - 1, Math.max(0, Math.floor(clamp01(point.x) * width)))
  const y = Math.min(height - 1, Math.max(0, Math.floor(clamp01(point.y) * height)))
  return y * width + x
}

export function selectForegroundMaskBytes(result, width, height, roi = { keypoint: { x: 0.5, y: 0.5 } }) {
  validateMaskDimensions({ width, height }, 'target mask')
  if (result?.categoryMask) {
    const mask = result.categoryMask
    const dimensions = validateMaskDimensions({ width: mask.width ?? width, height: mask.height ?? height }, 'categoryMask')
    const raw = mask.getAsUint8Array()
    assertRawBytes(raw, dimensions.area, Uint8Array, 'categoryMask')
    const foregroundCategory = raw[roiPixelIndex(roi, dimensions.width, dimensions.height)]
    const pixels = Uint8Array.from(raw, (value) => (value === foregroundCategory ? 255 : 0))
    const resized = resizeMask(pixels, dimensions.width, dimensions.height, width, height)
    closeMask(mask)
    return { width, height, pixels: resized }
  }
  if (Array.isArray(result?.confidenceMasks) && result.confidenceMasks.length > 0) {
    const scored = result.confidenceMasks.map((mask, index) => {
      const dimensions = validateMaskDimensions({ width: mask.width ?? width, height: mask.height ?? height }, 'confidenceMask')
      const raw = mask.getAsFloat32Array()
      assertRawBytes(raw, dimensions.area, Float32Array, 'confidenceMask')
      return {
        index,
        raw,
        valueAtRoi: raw[roiPixelIndex(roi, dimensions.width, dimensions.height)],
        maskWidth: dimensions.width,
        maskHeight: dimensions.height
      }
    })
    const best = scored.reduce((current, next) => (next.valueAtRoi > current.valueAtRoi ? next : current), scored[0])
    const pixels = Uint8Array.from(best.raw, (value) => (value >= 0.5 ? 255 : 0))
    const resized = resizeMask(pixels, best.maskWidth, best.maskHeight, width, height)
    for (const item of result.confidenceMasks) closeMask(item)
    return { width, height, pixels: resized }
  }
  throw new ObjectEditWorkerError('empty_segmenter_result', 'Interactive Segmenter returned no category or confidence mask.')
}

function crc32(bytes) {
  let crc = -1
  for (const value of bytes) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ -1) >>> 0
}

function adler32(bytes) {
  let a = 1
  let b = 0
  for (const value of bytes) {
    a = (a + value) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function writeU32(out, offset, value) {
  out[offset] = (value >>> 24) & 255
  out[offset + 1] = (value >>> 16) & 255
  out[offset + 2] = (value >>> 8) & 255
  out[offset + 3] = value & 255
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function pngChunk(type, data) {
  const name = new TextEncoder().encode(type)
  const out = new Uint8Array(12 + data.length)
  writeU32(out, 0, data.length)
  out.set(name, 4)
  out.set(data, 8)
  writeU32(out, out.length - 4, crc32(out.subarray(4, out.length - 4)))
  return out
}

export function encodeGrayscalePng(mask) {
  validateMaskDimensions(mask, 'encoded mask')
  assertRawBytes(mask.pixels, mask.width * mask.height, Uint8Array, 'encoded mask')
  const scanlines = new Uint8Array(mask.height * (mask.width + 1))
  for (let y = 0; y < mask.height; y += 1) {
    scanlines[y * (mask.width + 1)] = 0
    scanlines.set(mask.pixels.subarray(y * mask.width, (y + 1) * mask.width), y * (mask.width + 1) + 1)
  }
  const blocks = []
  for (let offset = 0; offset < scanlines.length; offset += 65535) {
    const slice = scanlines.subarray(offset, Math.min(scanlines.length, offset + 65535))
    const header = new Uint8Array(5)
    header[0] = offset + slice.length >= scanlines.length ? 1 : 0
    header[1] = byte(slice.length)
    header[2] = byte(slice.length >>> 8)
    header[3] = byte(~slice.length)
    header[4] = byte(~slice.length >>> 8)
    blocks.push(header, slice)
  }
  const checksum = new Uint8Array(4)
  writeU32(checksum, 0, adler32(scanlines))
  const ihdr = new Uint8Array(13)
  writeU32(ihdr, 0, mask.width)
  writeU32(ihdr, 4, mask.height)
  ihdr[8] = 8
  ihdr[9] = 0
  return concatBytes([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', concatBytes([Uint8Array.from([0x78, 0x01]), ...blocks, checksum])),
    pngChunk('IEND', new Uint8Array(0))
  ])
}

export function summarizeMask(mask) {
  validateMaskDimensions(mask, 'summary mask')
  assertRawBytes(mask.pixels, mask.width * mask.height, Uint8Array, 'summary mask')
  let minX = mask.width
  let minY = mask.height
  let maxX = -1
  let maxY = -1
  let area = 0
  for (let index = 0; index < mask.pixels.length; index += 1) {
    if (mask.pixels[index] === 0) continue
    const x = index % mask.width
    const y = Math.floor(index / mask.width)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    area += 1
  }
  return { area, bbox: area === 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } }
}
