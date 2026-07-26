import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveCowartAssetUrlPath } from "../shared/cowart-page-assets.mjs";
import { codedError } from "./object-aware-errors.mjs";

export function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sourceHashArg(args = {}, nonEmptyString) {
  return nonEmptyString(args.expectedSourceAssetHash) || nonEmptyString(args.expectedSourceSha256) || null;
}

export function pageAssetResolveOptions(canvasDir) {
  return {
    globalAssetsDir: join(canvasDir, "assets"),
    canvasPagesDir: join(canvasDir, "pages"),
  };
}

export async function localAssetFileForShape(store, shape, canvasDir, { pageAssetsRoute }) {
  const assetId = shape?.props?.assetId;
  const asset = assetId ? store[assetId] : null;
  const src = asset?.props?.src;
  if (!src || typeof src !== "string" || !src.startsWith(pageAssetsRoute)) return null;
  return resolveCowartAssetUrlPath(src, pageAssetResolveOptions(canvasDir));
}

export async function currentSourceIdentity(store, sourceShape, canvasDir, deps) {
  const { nonEmptyString, finiteNumber, findPageIdForShape, imageDimensionsFromBuffer, pageAssetsRoute } = deps;
  const assetId = nonEmptyString(sourceShape?.props?.assetId);
  const asset = assetId ? store[assetId] : null;
  if (!asset) codedError("source_asset_missing", "Source asset is missing.", 409, { shapeId: sourceShape?.id ?? null });
  const sourceFile = await localAssetFileForShape(store, sourceShape, canvasDir, { pageAssetsRoute });
  if (!sourceFile) codedError("source_asset_not_local", "Source asset is not a page-local Cowart asset.", 409, { shapeId: sourceShape.id, assetId });
  let bytes;
  try {
    bytes = await readFile(sourceFile);
  } catch {
    codedError("source_asset_missing", "Source asset bytes are missing.", 409, { shapeId: sourceShape.id, assetId });
  }
  let dimensions = null;
  try {
    dimensions = imageDimensionsFromBuffer(bytes);
  } catch {
    dimensions = {
      width: Math.round(finiteNumber(asset.props?.w, sourceShape.props?.w ?? 0)),
      height: Math.round(finiteNumber(asset.props?.h, sourceShape.props?.h ?? 0)),
    };
  }
  return {
    pageId: findPageIdForShape(store, sourceShape.id),
    shapeId: sourceShape.id,
    assetId,
    assetSha256: hashBuffer(bytes),
    width: dimensions.width,
    height: dimensions.height,
    sourceFile,
  };
}

export async function assertSourcePrecondition(store, args, sourceShape, expectedHash, deps) {
  const { resolveCanvasDir, nonEmptyString } = deps;
  const source = await currentSourceIdentity(store, sourceShape, resolveCanvasDir(args), deps);
  if (!source.pageId) codedError("source_shape_page_mismatch", "Source shape is not owned by a page.", 409, { shapeId: sourceShape.id });
  const expected = nonEmptyString(expectedHash) || null;
  if (expected && source.assetSha256 !== expected) {
    codedError("source_asset_changed", "Source asset changed before writeback.", 409, {
      sourceShapeId: source.shapeId,
      sourceAssetId: source.assetId,
      expectedSourceAssetHash: expected,
      currentSourceAssetHash: source.assetSha256,
    });
  }
  return source;
}

export function sourceCondition(source) {
  return {
    type: "sourceAsset",
    source: {
      pageId: source.pageId,
      shapeId: source.shapeId,
      assetId: source.assetId,
      assetSha256: source.assetSha256,
      width: source.width,
      height: source.height,
    },
  };
}

export function segmentSourceMatchesCurrent(segment, current) {
  const declared = segment?.source ?? {};
  return (
    current.pageId === declared.pageId &&
    current.shapeId === declared.shapeId &&
    current.assetId === declared.assetId &&
    current.assetSha256 === declared.assetSha256 &&
    current.width === declared.width &&
    current.height === declared.height
  );
}
