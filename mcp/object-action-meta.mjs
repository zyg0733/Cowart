import { codedError } from "./object-aware-errors.mjs";
import { objectEditSegment } from "./object-aware-provenance.mjs";

export const OBJECT_ACTION_OPERATIONS = ["modify", "replace", "remove"];

export async function trustedObjectAction(args, input, deps) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const operation = deps.nonEmptyString(input.operation);
  if (!OBJECT_ACTION_OPERATIONS.includes(operation)) {
    codedError("invalid_object_action", `objectAction.operation must be one of: ${OBJECT_ACTION_OPERATIONS.join(", ")}.`, 400);
  }
  const trusted = await objectEditSegment(args, input, null, deps);
  if (!trusted.segment || !trusted.source) {
    codedError("missing_segment_id", "objectAction.segmentId must reference a confirmed segment.", 400);
  }
  return {
    operation,
    segmentId: trusted.segment.segmentId,
    sourcePageId: trusted.source.pageId,
    sourceShapeId: trusted.source.shapeId,
    sourceAssetId: trusted.source.assetId,
    sourceSha256: trusted.source.assetSha256,
    sourceWidth: trusted.source.width,
    sourceHeight: trusted.source.height,
    prompt: typeof input.prompt === "string" ? input.prompt : typeof args.prompt === "string" ? args.prompt : "",
    synthetic: true,
    requestedAt: new Date().toISOString(),
  };
}
