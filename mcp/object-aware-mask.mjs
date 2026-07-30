import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  decodeCanonicalMaskPng,
  encodeCanonicalMaskPng,
  refineSelectionMask,
  selectionToEditAlpha,
} from "../shared/cowart-segment-mask.mjs";
import { codedError } from "./object-aware-errors.mjs";
import { segmentStoreForArgs, segmentSummary, validateSegmentSource } from "./object-aware-segments.mjs";
import { hashBuffer } from "./object-aware-source.mjs";
import { callSegmentationSidecar, sidecarIsConfigured } from "./sidecar-client.mjs";

export async function segmentEditMaskMaterial(args, segment, source, deps) {
  const segmentId = segment.segmentId;
  const selectionPng = await segmentStoreForArgs(args, deps.resolveCanvasDir).binary(segmentId, "mask.png");
  const selectionMask = decodeCanonicalMaskPng(selectionPng);
  if (selectionMask.width !== source.width || selectionMask.height !== source.height) {
    codedError("segment_size_mismatch", "Segment mask dimensions do not match the current source.", 409, {
      segmentId,
      expected: { width: source.width, height: source.height },
      actual: { width: selectionMask.width, height: selectionMask.height },
    });
  }
  const maskBuffer = deps.encodeAlphaMaskPng(source.width, source.height, selectionToEditAlpha(selectionMask.pixels));
  return {
    selectionMaskSha256: segment.mask?.sha256 ?? hashBuffer(selectionPng),
    editMaskSha256: hashBuffer(maskBuffer),
    maskBuffer,
  };
}

export async function makeSegmentCowartMask(args, deps) {
  const segmentId = deps.nonEmptyString(args.segmentId);
  let segment;
  try {
    segment = await segmentStoreForArgs(args, deps.resolveCanvasDir).get(segmentId);
  } catch (error) {
    if (error?.code === "segment_not_found") codedError("segment_not_found", "Segment not found.", 404, { segmentId });
    throw error;
  }
  if (deps.nonEmptyString(args.targetShapeId) && deps.nonEmptyString(args.targetShapeId) !== segment.source?.shapeId) {
    codedError("segment_stale", "Requested targetShapeId does not match the segment source.", 409, { segmentId });
  }
  const { source } = await validateSegmentSource(args, segment, deps);
  const segmentMask = await segmentEditMaskMaterial(args, segment, source, deps);
  const maskBuffer = segmentMask.maskBuffer;
  const canvasDir = deps.resolveCanvasDir(args);
  const outDir = deps.nonEmptyString(args.outputDir) ? deps.pathResolve(args.outputDir) : join(canvasDir, "masks");
  const maskFileName = deps.sanitizeFileName(deps.nonEmptyString(args.maskFileName) || `cowart-mask-${deps.exportTimestamp()}.png`, "cowart-mask.png");
  const maskFile = join(outDir, maskFileName);
  if (!deps.isSafeChildPath(outDir, maskFile)) {
    codedError("unsafe_mask_destination", "Mask file must stay inside the selected output directory.", 400);
  }
  if (!args.dryRun) {
    await mkdir(outDir, { recursive: true });
    await writeFile(maskFile, maskBuffer);
  }
  const result = {
    targetShapeId: segment.source.shapeId,
    pageId: segment.source.pageId,
    segmentId,
    source: {
      shapeId: source.shapeId,
      assetId: source.assetId,
      assetSha256: source.assetSha256,
      naturalSize: { width: source.width, height: source.height },
    },
    naturalSize: { width: source.width, height: source.height },
    selectionMaskSha256: segmentMask.selectionMaskSha256,
    editMaskSha256: segmentMask.editMaskSha256,
    mask: { fileName: maskFileName, sha256: segmentMask.editMaskSha256, bytes: maskBuffer.length },
    maskFile,
    dryRun: Boolean(args.dryRun),
  };
  if (args.returnBase64 === true) {
    result.maskBase64 = maskBuffer.toString("base64");
    try {
      result.sourceImageBase64 = (await readFile(source.sourceFile)).toString("base64");
    } catch {
      result.sourceImageBase64 = null;
    }
  }
  return result;
}

function newSegmentId(seed = "refined", sanitizeIdPart) {
  const base = sanitizeIdPart(seed, "segment");
  return `segment:${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function refineCowartSegment(args = {}, deps) {
  const segmentId = deps.nonEmptyString(args.segmentId);
  if (!segmentId) codedError("missing_segment_id", "segmentId is required.", 400);
  let parent;
  try {
    parent = await segmentStoreForArgs(args, deps.resolveCanvasDir).get(segmentId);
  } catch (error) {
    if (error?.code === "segment_not_found") codedError("segment_not_found", "Segment not found.", 404, { segmentId });
    throw error;
  }
  const { source } = await validateSegmentSource(args, parent, deps);
  const maskBytes = await segmentStoreForArgs(args, deps.resolveCanvasDir).binary(segmentId, "mask.png");
  const mask = decodeCanonicalMaskPng(maskBytes);
  if (mask.width !== source.width || mask.height !== source.height) {
    codedError("segment_size_mismatch", "Segment mask dimensions do not match the current source.", 409, {
      segmentId,
      expected: { width: source.width, height: source.height },
      actual: { width: mask.width, height: mask.height },
    });
  }
  const refined = refineSelectionMask(mask, {
    expandPixels: deps.finiteNumber(args.expandPixels, 0),
    contractPixels: deps.finiteNumber(args.contractPixels, 0),
    featherPixels: deps.finiteNumber(args.featherPixels, 0),
  });
  const refinedPng = encodeCanonicalMaskPng(refined);
  const childSegmentId = deps.nonEmptyString(args.newSegmentId) || deps.nonEmptyString(args.outputSegmentId) || newSegmentId("refined", deps.sanitizeIdPart);
  const child = await segmentStoreForArgs(args, deps.resolveCanvasDir).refine(segmentId, {
    segmentId: childSegmentId,
    maskPng: refinedPng,
    previewPng: refinedPng,
    selection: {
      mode: "refine",
      parentSegmentId: segmentId,
      operations: {
        expandPixels: deps.finiteNumber(args.expandPixels, 0),
        contractPixels: deps.finiteNumber(args.contractPixels, 0),
        featherPixels: deps.finiteNumber(args.featherPixels, 0),
      },
    },
    provider: {
      id: "cowart-mcp-morphology",
      runtime: "server",
      processing: "local",
      model: "shared/cowart-segment-mask",
      version: deps.serverVersion,
    },
  });
  return { segment: segmentSummary(child), parentSegmentId: segmentId };
}

export async function segmentCowartImage(args = {}, deps) {
  const { snapshot } = await deps.loadCanvasSnapshot(args);
  const targetShapeId = deps.nonEmptyString(args.targetShapeId) || deps.nonEmptyString(args.shapeId);
  if (!targetShapeId) codedError("missing_target_shape", "targetShapeId is required.", 400);
  const target = deps.resolveImageLikeShape(snapshot.store, deps.getRecord(snapshot.store, targetShapeId, "target shape"), { label: "Segmentation target" });
  if (!target) codedError("invalid_target", "Segmentation target is not an image.", 400, { targetShapeId });
  if (!sidecarIsConfigured(args)) {
    return {
      status: "browser_interaction_required",
      code: "browser_interaction_required",
      provider: "browser-local",
      instructions:
        "Use the canvas object tool to create and confirm a segment in the browser, or configure the loopback Cowart Sidecar. No synthetic segment was created.",
      targetShapeId,
      requestedMode: args.mode ?? "point",
    };
  }
  const source = await deps.currentSourceIdentity(snapshot.store, target, deps.resolveCanvasDir(args));
  const expectedHash = deps.nonEmptyString(args.expectedSourceAssetHash) || deps.nonEmptyString(args.expectedSourceSha256);
  if (expectedHash && expectedHash !== source.assetSha256) {
    codedError("source_asset_changed", "Source asset changed before segmentation.", 409, {
      expectedSourceAssetHash: expectedHash,
      currentSourceAssetHash: source.assetSha256,
    });
  }
  const sourceBytes = await readFile(source.sourceFile);
  const sidecar = await callSegmentationSidecar(args, sourceBytes, source);
  const publicSource = {
    pageId: source.pageId,
    shapeId: source.shapeId,
    assetId: source.assetId,
    assetSha256: source.assetSha256,
    width: source.width,
    height: source.height,
  };
  const result = {
    status: "candidates_ready",
    targetShapeId,
    source: publicSource,
    requestedMode: args.mode ?? "point",
    provider: sidecar.provider,
    candidates: sidecar.publicCandidates,
    published: false,
  };
  if (args.publish !== true) return result;
  const candidateIndex = Math.round(Number(args.candidateIndex) || 0);
  const chosen = sidecar.candidates[candidateIndex];
  if (!chosen) codedError("invalid_candidate_index", "candidateIndex does not identify a returned sidecar candidate.", 400, { candidateIndex });
  const { snapshot: latest } = await deps.loadCanvasSnapshot(args);
  const latestTarget = deps.resolveImageLikeShape(latest.store, deps.getRecord(latest.store, targetShapeId, "target shape"), { label: "Segmentation target" });
  const current = await deps.currentSourceIdentity(latest.store, latestTarget, deps.resolveCanvasDir(args));
  if (
    current.pageId !== source.pageId ||
    current.assetId !== source.assetId ||
    current.assetSha256 !== source.assetSha256 ||
    current.width !== source.width ||
    current.height !== source.height
  ) {
    codedError("source_asset_changed", "Source asset changed while Sidecar segmentation was running.", 409, {
      expectedSourceAssetHash: source.assetSha256,
      currentSourceAssetHash: current.assetSha256,
    });
  }
  const segmentId = deps.nonEmptyString(args.segmentId) || newSegmentId(args.mode || "sidecar", deps.sanitizeIdPart);
  const segment = await segmentStoreForArgs(args, deps.resolveCanvasDir).confirm({
    segmentId,
    pageId: source.pageId,
    source: publicSource,
    maskPng: chosen.maskPng,
    previewPng: chosen.maskPng,
    selection: {
      mode: args.mode ?? "point",
      points: Array.isArray(args.points) ? args.points : undefined,
      box: args.box ?? undefined,
      prompt: deps.nonEmptyString(args.prompt),
      candidateIndex,
    },
    provider: sidecar.provider,
  });
  return {
    ...result,
    status: "published",
    published: true,
    candidateIndex,
    segment: segmentSummary(segment),
  };
}
