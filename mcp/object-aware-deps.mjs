import {
  makeSegmentCowartMask,
  refineCowartSegment as refineCowartSegmentTool,
  segmentCowartImage as segmentCowartImageTool,
  segmentEditMaskMaterial as objectAwareSegmentEditMaskMaterial,
} from "./object-aware-mask.mjs";
import {
  confirmedSegmentsBySource as objectAwareConfirmedSegmentsBySource,
  confirmedSegmentsForShape,
  publicShapeMeta,
} from "./object-aware-segments.mjs";
import {
  assertSourcePrecondition as objectAwareAssertSourcePrecondition,
  currentSourceIdentity as objectAwareCurrentSourceIdentity,
  hashBuffer,
  localAssetFileForShape as objectAwareLocalAssetFileForShape,
  sourceCondition,
  sourceHashArg as objectAwareSourceHashArg,
} from "./object-aware-source.mjs";
import { objectEditProvenance as objectAwareObjectEditProvenance } from "./object-aware-provenance.mjs";
import { COWART_AI_IMAGE_SHAPE, PAGE_ASSETS_ROUTE, SERVER_VERSION } from "./constants.mjs";
import { findPageIdForShape } from "./canvas-client.mjs";
import { getPageShapes } from "./geometry.mjs";
import {
  finiteNumber,
  isSafeChildPath,
  nonEmptyString,
  pathResolve,
  sanitizeFileName,
  sanitizeIdPart,
  resolveCanvasDir,
} from "./paths.mjs";
import { imageDimensionsFromBuffer } from "./image-io.mjs";
import { encodeAlphaMaskPng } from "./mask-png.mjs";
import { codedError } from "./object-aware-errors.mjs";

export { confirmedSegmentsForShape, hashBuffer, publicShapeMeta, sourceCondition };
export { makeSegmentCowartMask, refineCowartSegmentTool, segmentCowartImageTool };

export function exportTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function createObjectAwareDeps(loadCanvasSnapshot, getRecord) {
  const deps = {
    serverVersion: SERVER_VERSION,
    pageAssetsRoute: PAGE_ASSETS_ROUTE,
    resolveCanvasDir,
    loadCanvasSnapshot,
    getRecord,
    findPageIdForShape,
    resolveImageLikeShape: (store, shape, options) => resolveImageLikeShape(store, shape, options),
    imageDimensionsFromBuffer,
    nonEmptyString,
    finiteNumber,
    sanitizeFileName,
    sanitizeIdPart,
    pathResolve,
    exportTimestamp,
    isSafeChildPath,
    encodeAlphaMaskPng,
    currentSourceIdentity: (store, sourceShape, canvasDir) =>
      objectAwareCurrentSourceIdentity(store, sourceShape, canvasDir, deps),
    segmentEditMaskMaterial: (args, segment, source) =>
      objectAwareSegmentEditMaskMaterial(args, segment, source, deps),
  };
  return deps;
}

export async function confirmedSegmentsBySource(args = {}, store = null, deps) {
  return objectAwareConfirmedSegmentsBySource(args, store, deps);
}

export async function localAssetFileForShape(store, shape, canvasDir) {
  return objectAwareLocalAssetFileForShape(store, shape, canvasDir, { pageAssetsRoute: PAGE_ASSETS_ROUTE });
}

export async function currentSourceIdentity(store, sourceShape, canvasDir, deps) {
  return deps.currentSourceIdentity(store, sourceShape, canvasDir);
}

export async function assertSourcePrecondition(store, args, sourceShape, expectedHash, deps) {
  return objectAwareAssertSourcePrecondition(store, args, sourceShape, expectedHash, deps);
}

export function sourceHashArg(args = {}) {
  return objectAwareSourceHashArg(args, nonEmptyString);
}

export async function objectEditProvenance(args = {}, source = null, deps) {
  return objectAwareObjectEditProvenance(args, source, deps);
}

export function resolveImageLikeShape(store, shape, { label = "Target" } = {}) {
  if (!shape) return null;
  if (shape.type === "image") return shape;
  if (shape.type === "frame") {
    const pageId = findPageIdForShape(store, shape.id);
    const child = pageId
      ? getPageShapes(store, pageId).find((candidate) => candidate.parentId === shape.id && candidate.type === "image")
      : null;
    if (!child) throw new Error(`Frame ${shape.id} has no image.`);
    return child;
  }
  if (shape.type === COWART_AI_IMAGE_SHAPE) {
    const status = nonEmptyString(shape.props?.status) || "empty";
    const assetId = nonEmptyString(shape.props?.assetId);
    if (status !== "filled" || !assetId) {
      codedError("holder_not_filled", `${label} cowart-ai-image holder ${shape.id} is not filled (status=${status}).`, 409, {
        holderId: shape.id,
        status,
      });
    }
    if (!store[assetId]) {
      codedError("holder_asset_missing", `${label} cowart-ai-image holder ${shape.id} is filled but asset ${assetId} is missing.`, 409, {
        holderId: shape.id,
        assetId,
      });
    }
    return shape;
  }
  return null;
}
