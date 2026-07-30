import { readFile } from "node:fs/promises";

import { extractMaskedObject } from "./image-composite.mjs";
import { insertCowartImage } from "./insert-image.mjs";
import { codedError } from "./object-aware-errors.mjs";
import { segmentStoreForArgs, validateSegmentSource } from "./object-aware-segments.mjs";
import { finiteNumber, nonEmptyString, sanitizeIdPart } from "./paths.mjs";

export async function extractCowartObject(args = {}, deps) {
  const segmentId = nonEmptyString(args.segmentId);
  if (!segmentId) codedError("missing_segment_id", "segmentId is required.", 400);
  const segmentStore = segmentStoreForArgs(args, deps.resolveCanvasDir);
  let segment;
  try {
    segment = await segmentStore.get(segmentId);
  } catch (error) {
    if (error?.code === "segment_not_found") codedError("segment_not_found", "Segment not found.", 404, { segmentId });
    throw error;
  }
  const { sourceShape, source } = await validateSegmentSource(args, segment, deps);
  const [sourceBytes, selectionMaskBytes] = await Promise.all([
    readFile(source.sourceFile),
    segmentStore.binary(segmentId, "mask.png"),
  ]);
  const cropToBounds = args.cropToBounds !== false;
  const extracted = await extractMaskedObject({
    sourceBytes,
    selectionMaskBytes,
    width: source.width,
    height: source.height,
    bbox: segment.mask?.bbox,
    crop: cropToBounds,
  });
  const displayWidth = cropToBounds
    ? finiteNumber(sourceShape.props?.w, source.width) * (extracted.width / source.width)
    : finiteNumber(sourceShape.props?.w, source.width);
  const displayHeight = cropToBounds
    ? finiteNumber(sourceShape.props?.h, source.height) * (extracted.height / source.height)
    : finiteNumber(sourceShape.props?.h, source.height);
  const fileName = nonEmptyString(args.fileName) || `${sanitizeIdPart(segmentId, "object")}-transparent.png`;
  const inserted = await insertCowartImage({
    ...args,
    imagePath: undefined,
    imageDataUrl: undefined,
    imageBase64: extracted.buffer.toString("base64"),
    mimeType: "image/png",
    fileName,
    anchorShapeId: source.shapeId,
    sourceShapeId: source.shapeId,
    matchAnchor: false,
    displayWidth,
    displayHeight,
    expectedSourceAssetHash: source.assetSha256,
    objectEdit: {
      segmentId,
      operation: "extract",
      provider: "sharp",
      model: "0.35.0",
    },
    shapeMeta: {
      ...(args.shapeMeta && typeof args.shapeMeta === "object" ? args.shapeMeta : {}),
      cowartObjectLayer: {
        segmentId,
        sourceShapeId: source.shapeId,
        sourceSha256: source.assetSha256,
        synthetic: false,
        crop: extracted.bbox,
      },
    },
  }, deps);
  return {
    ...inserted,
    segmentId,
    sourceShapeId: source.shapeId,
    sourceSha256: source.assetSha256,
    synthetic: false,
    extraction: {
      naturalSize: { width: extracted.width, height: extracted.height },
      sourceNaturalSize: { width: source.width, height: source.height },
      bbox: extracted.bbox,
      cropToBounds,
    },
  };
}
