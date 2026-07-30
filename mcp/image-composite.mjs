import sharp from "sharp";

const MAX_IMAGE_PIXELS = 40_000_000;

function assertDimensions(width, height, label) {
  const pixels = width * height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    pixels > MAX_IMAGE_PIXELS
  ) {
    throw new Error(`${label} dimensions must be positive integers and no larger than 40MP.`);
  }
}

async function rgbaPixels(bytes, width, height, { resize = false } = {}) {
  let pipeline = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).ensureAlpha();
  const metadata = await pipeline.metadata();
  if (metadata.width !== width || metadata.height !== height) {
    if (!resize) {
      throw new Error(`Image dimensions ${metadata.width}x${metadata.height} do not match ${width}x${height}.`);
    }
    pipeline = pipeline.resize(width, height, { fit: "fill" });
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels !== 4) {
    throw new Error("Image could not be decoded to the expected RGBA dimensions.");
  }
  return data;
}

async function selectionPixels(maskBytes, width, height) {
  const { data, info } = await sharp(maskBytes, { limitInputPixels: MAX_IMAGE_PIXELS })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels !== 1) {
    throw new Error(`Selection mask dimensions ${info.width}x${info.height} do not match ${width}x${height}.`);
  }
  return data;
}

function encodeRgba(pixels, width, height) {
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

export async function preserveOutsideComposite({
  sourceBytes,
  candidateBytes,
  selectionMaskBytes,
  width,
  height,
}) {
  assertDimensions(width, height, "Composite");
  const [source, candidate, selection] = await Promise.all([
    rgbaPixels(sourceBytes, width, height),
    rgbaPixels(candidateBytes, width, height, { resize: true }),
    selectionPixels(selectionMaskBytes, width, height),
  ]);
  const output = Buffer.allocUnsafe(source.length);
  for (let pixel = 0; pixel < selection.length; pixel += 1) {
    const alpha = selection[pixel];
    const offset = pixel * 4;
    if (alpha === 0) {
      source.copy(output, offset, offset, offset + 4);
      continue;
    }
    if (alpha === 255) {
      candidate.copy(output, offset, offset, offset + 4);
      continue;
    }
    const inverse = 255 - alpha;
    for (let channel = 0; channel < 4; channel += 1) {
      output[offset + channel] = Math.round(
        (source[offset + channel] * inverse + candidate[offset + channel] * alpha) / 255
      );
    }
  }
  return encodeRgba(output, width, height);
}

export async function extractMaskedObject({
  sourceBytes,
  selectionMaskBytes,
  width,
  height,
  bbox,
  crop = true,
}) {
  assertDimensions(width, height, "Extraction");
  const [source, selection] = await Promise.all([
    rgbaPixels(sourceBytes, width, height),
    selectionPixels(selectionMaskBytes, width, height),
  ]);
  const output = Buffer.from(source);
  for (let pixel = 0; pixel < selection.length; pixel += 1) {
    output[pixel * 4 + 3] = Math.round((output[pixel * 4 + 3] * selection[pixel]) / 255);
  }

  if (!crop) {
    return { buffer: await encodeRgba(output, width, height), width, height, bbox: { x: 0, y: 0, w: width, h: height } };
  }
  if (
    !bbox ||
    !Number.isInteger(bbox.x) ||
    !Number.isInteger(bbox.y) ||
    !Number.isInteger(bbox.w) ||
    !Number.isInteger(bbox.h) ||
    bbox.x < 0 ||
    bbox.y < 0 ||
    bbox.w <= 0 ||
    bbox.h <= 0 ||
    bbox.x + bbox.w > width ||
    bbox.y + bbox.h > height
  ) {
    throw new Error("Extraction requires a non-empty mask bounding box inside the source image.");
  }
  const buffer = await sharp(output, { raw: { width, height, channels: 4 } })
    .extract({ left: bbox.x, top: bbox.y, width: bbox.w, height: bbox.h })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  return { buffer, width: bbox.w, height: bbox.h, bbox };
}

export async function decodeRgbaForTest(bytes) {
  return sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}
