import { codedError } from "./object-aware-errors.mjs";
import { segmentStoreForArgs, validateSegmentSource } from "./object-aware-segments.mjs";
import { segmentSourceMatchesCurrent } from "./object-aware-source.mjs";

export async function objectEditSegment(args, input, source, deps) {
  const segmentId = deps.nonEmptyString(input.segmentId);
  if (!segmentId) return { segment: null, source };
  let segment;
  try {
    segment = await segmentStoreForArgs(args, deps.resolveCanvasDir).get(segmentId);
  } catch (error) {
    if (error?.code === "segment_not_found") codedError("segment_not_found", "Segment not found.", 404, { segmentId });
    throw error;
  }
  const validated = await validateSegmentSource(args, segment, deps);
  if (source && !segmentSourceMatchesCurrent({ source }, validated.source)) {
    codedError("object_edit_source_mismatch", "Object edit segment source does not match the validated writeback source.", 409, { segmentId });
  }
  return { segment, source: validated.source };
}

export async function objectEditProvenance(args = {}, source = null, deps) {
  const input = args.objectEdit && typeof args.objectEdit === "object" ? args.objectEdit : args.cowartObjectEdit;
  if (!input || typeof input !== "object") return null;
  const trusted = await objectEditSegment(args, input, source, deps);
  const trustedSource = trusted.source ?? source;
  const segment = trusted.segment;
  const segmentMask = segment ? await deps.segmentEditMaskMaterial(args, segment, trustedSource) : null;
  const callerEditMaskSha256 = deps.nonEmptyString(input.editMaskSha256);
  if (segmentMask && callerEditMaskSha256 && callerEditMaskSha256 !== segmentMask.editMaskSha256) {
    codedError("object_edit_mask_mismatch", "objectEdit.editMaskSha256 does not match the validated segment edit mask.", 409, {
      segmentId: segment.segmentId,
      expectedEditMaskSha256: segmentMask.editMaskSha256,
    });
  }
  const provenance = {
    segmentId: segment?.segmentId ?? deps.nonEmptyString(input.segmentId) ?? null,
    parentSegmentId: segment ? segment.parentSegmentId ?? null : deps.nonEmptyString(input.parentSegmentId) ?? null,
    parentRevision: deps.finiteNumber(input.parentRevision, null),
    sourceShapeId: trustedSource?.shapeId ?? null,
    sourceAssetId: trustedSource?.assetId ?? null,
    sourceSha256: trustedSource?.assetSha256 ?? null,
    selectionMaskSha256: segmentMask?.selectionMaskSha256 ?? null,
    operation: deps.nonEmptyString(input.operation) ?? null,
    prompt: typeof input.prompt === "string" ? input.prompt : deps.nonEmptyString(args.prompt),
    provider: deps.nonEmptyString(input.provider) ?? deps.nonEmptyString(args.provider) ?? null,
    model: deps.nonEmptyString(input.model) ?? deps.nonEmptyString(args.model) ?? null,
    timestamp: deps.nonEmptyString(input.timestamp) ?? new Date().toISOString(),
  };
  if (segmentMask) provenance.editMaskSha256 = segmentMask.editMaskSha256;
  return provenance;
}
