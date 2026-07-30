import { readFile } from "node:fs/promises";

import { preserveOutsideComposite } from "./image-composite.mjs";
import { codedError } from "./object-aware-errors.mjs";
import { segmentStoreForArgs, validateSegmentSource } from "./object-aware-segments.mjs";

function preserveOutsideConfig(args) {
  if (args.preserveOutside === false || args.preserveOutside == null) return null;
  const value = args.preserveOutside === true ? {} : args.preserveOutside;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    codedError("invalid_preserve_outside", "preserveOutside must be true, false, or an object.", 400);
  }
  const objectEdit = args.objectEdit && typeof args.objectEdit === "object" ? args.objectEdit : {};
  const segmentId = value.segmentId ?? objectEdit.segmentId;
  if (typeof segmentId !== "string" || segmentId.length === 0) {
    codedError("missing_segment_id", "preserveOutside requires segmentId or objectEdit.segmentId.", 400);
  }
  return { segmentId };
}

export async function protectResolvedImage(args, candidate, deps) {
  const config = preserveOutsideConfig(args);
  if (!config) return { image: candidate, protection: null };
  const segmentStore = segmentStoreForArgs(args, deps.resolveCanvasDir);
  let segment;
  try {
    segment = await segmentStore.get(config.segmentId);
  } catch (error) {
    if (error?.code === "segment_not_found") {
      codedError("segment_not_found", "Segment not found.", 404, { segmentId: config.segmentId });
    }
    throw error;
  }
  const { source } = await validateSegmentSource(args, segment, deps);
  const [sourceBytes, selectionMaskBytes, candidateBytes] = await Promise.all([
    readFile(source.sourceFile),
    segmentStore.binary(config.segmentId, "mask.png"),
    candidate.buffer ? Promise.resolve(candidate.buffer) : readFile(candidate.sourcePath),
  ]);
  const buffer = await preserveOutsideComposite({
    sourceBytes,
    candidateBytes,
    selectionMaskBytes,
    width: source.width,
    height: source.height,
  });
  return {
    image: {
      buffer,
      sourcePath: null,
      bytes: buffer.length,
      defaultName: candidate.defaultName.replace(/\.[^.]+$/, "") + "-protected.png",
      dimensions: { width: source.width, height: source.height },
    },
    protection: {
      segmentId: segment.segmentId,
      source,
      selectionMaskSha256: segment.mask?.sha256 ?? null,
    },
  };
}
