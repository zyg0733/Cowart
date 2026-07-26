import { join } from "node:path";

import { createSegmentStore } from "../shared/cowart-segment-store.mjs";
import { codedError } from "./object-aware-errors.mjs";
import {
  currentSourceIdentity,
  segmentSourceMatchesCurrent,
  sourceHashArg,
} from "./object-aware-source.mjs";

export function segmentStoreForArgs(args = {}, resolveCanvasDir) {
  return createSegmentStore({ pagesDir: join(resolveCanvasDir(args), "pages") });
}

export function segmentSummary(segment) {
  return {
    segmentId: segment.segmentId,
    parentSegmentId: segment.parentSegmentId ?? null,
    source: {
      pageId: segment.source?.pageId ?? null,
      shapeId: segment.source?.shapeId ?? null,
      assetId: segment.source?.assetId ?? null,
      assetSha256: segment.source?.assetSha256 ?? null,
      width: segment.source?.width ?? null,
      height: segment.source?.height ?? null,
    },
    mask: {
      sha256: segment.mask?.sha256 ?? null,
      bbox: segment.mask?.bbox ?? null,
      area: segment.mask?.area ?? null,
    },
    selectionMode: segment.selection?.mode ?? null,
    provider: segment.provider
      ? {
          id: segment.provider.id ?? null,
          runtime: segment.provider.runtime ?? null,
          processing: segment.provider.processing ?? null,
          model: segment.provider.model ?? null,
          version: segment.provider.version ?? null,
        }
      : null,
    createdAt: segment.createdAt ?? null,
  };
}

export async function confirmedSegmentsBySource(args = {}, store = null, deps) {
  const map = new Map();
  const identityCache = new Map();
  const canvasDir = deps.resolveCanvasDir(args);
  for (const segment of await segmentStoreForArgs(args, deps.resolveCanvasDir).list()) {
    const source = segment.source ?? {};
    if (!source.shapeId || !source.assetId || !store) continue;
    const rawShape = store[source.shapeId];
    if (!rawShape) continue;
    let sourceShape;
    try {
      sourceShape = deps.resolveImageLikeShape(store, rawShape, { label: "Segment source" });
    } catch {
      continue;
    }
    if (!sourceShape || sourceShape.id !== source.shapeId) continue;
    let current = identityCache.get(source.shapeId);
    if (!current) {
      current = currentSourceIdentity(store, sourceShape, canvasDir, deps).catch(() => null);
      identityCache.set(source.shapeId, current);
    }
    const identity = await current;
    if (!identity || !segmentSourceMatchesCurrent(segment, identity)) continue;
    const key = `${source.shapeId}\0${source.assetId}`;
    const list = map.get(key) ?? [];
    list.push(segmentSummary(segment));
    map.set(key, list);
  }
  return map;
}

export function confirmedSegmentsForShape(segmentMap, shape, nonEmptyString) {
  const assetId = nonEmptyString(shape?.props?.assetId);
  if (!shape?.id || !assetId) return [];
  return segmentMap.get(`${shape.id}\0${assetId}`) ?? [];
}

export function publicShapeMeta(meta = {}) {
  if (!meta || typeof meta !== "object") return {};
  const clean = {};
  for (const [key, value] of Object.entries(meta)) {
    if (/candidate/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

export async function validateSegmentSource(args, segment, deps) {
  const { snapshot } = await deps.loadCanvasSnapshot(args);
  const store = snapshot.store;
  const declared = segment.source ?? {};
  const rawShape = declared.shapeId ? deps.getRecord(store, declared.shapeId, "segment source shape") : null;
  const sourceShape = deps.resolveImageLikeShape(store, rawShape, { label: "Segment source" });
  if (!sourceShape) codedError("segment_stale", "Segment source shape is no longer an image.", 409, { segmentId: segment.segmentId });
  const current = await currentSourceIdentity(store, sourceShape, deps.resolveCanvasDir(args), deps);
  if (current.pageId !== declared.pageId) {
    codedError("segment_stale", "Segment source page ownership changed.", 409, { segmentId: segment.segmentId });
  }
  if (current.assetId !== declared.assetId || current.assetSha256 !== declared.assetSha256) {
    codedError("segment_stale", "Segment source asset changed.", 409, { segmentId: segment.segmentId });
  }
  if (current.width !== declared.width || current.height !== declared.height) {
    codedError("segment_size_mismatch", "Segment source dimensions changed.", 409, {
      segmentId: segment.segmentId,
      expected: { width: declared.width, height: declared.height },
      current: { width: current.width, height: current.height },
    });
  }
  const expected = sourceHashArg(args, deps.nonEmptyString);
  if (expected && expected !== current.assetSha256) {
    codedError("source_asset_changed", "Source asset changed before segment use.", 409, {
      sourceShapeId: current.shapeId,
      sourceAssetId: current.assetId,
      expectedSourceAssetHash: expected,
      currentSourceAssetHash: current.assetSha256,
    });
  }
  return { snapshot, store, sourceShape, source: current };
}
