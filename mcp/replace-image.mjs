import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { COWART_AI_IMAGE_SHAPE } from "./constants.mjs";
import { findPageIdForShape, getRecord, loadCanvasSnapshot, persistRecords, readSelectionState } from "./canvas-client.mjs";
import { firstSelectedShapeId, getPageShapes } from "./geometry.mjs";
import { resolveImageSource, writeResolvedImage } from "./image-io.mjs";
import {
  finiteNumber,
  isSafeChildPath,
  mimeTypeForFile,
  nonEmptyString,
  pageAssetUrl,
  pageDirName,
  resolveCanvasDir,
  sanitizeIdPart,
  uniqueFilePath,
  uniqueRecordId,
} from "./paths.mjs";
import { archiveRequest, assertExpectedRequest, currentHolderRequest, requestConditionList } from "./request-lifecycle.mjs";
import {
  assertSourcePrecondition,
  localAssetFileForShape,
  objectEditProvenance,
  resolveImageLikeShape,
  sourceCondition,
  sourceHashArg,
} from "./object-aware-deps.mjs";

export async function replaceCowartImage(args = {}, deps) {
  const source = await resolveImageSource(args);
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const { selection } = await readSelectionState(args);
  const targetShapeId = nonEmptyString(args.targetShapeId) || nonEmptyString(args.shapeId) || firstSelectedShapeId(selection);
  if (!targetShapeId) throw new Error("targetShapeId is required (or select the image to replace).");
  let targetShape = getRecord(store, targetShapeId, "target shape");
  const pageId = findPageIdForShape(store, targetShape.id);
  if (!pageId) throw new Error(`Could not determine the page for ${targetShapeId}.`);

  if (targetShape.type === "frame") {
    const child = getPageShapes(store, pageId).find((shape) => shape.parentId === targetShape.id && shape.type === "image");
    if (!child) throw new Error(`Frame ${targetShapeId} has no image to replace. Use insert_cowart_image with fillAnchor instead.`);
    targetShape = child;
  }
  const isHolder = targetShape.type === COWART_AI_IMAGE_SHAPE;
  if (targetShape.type !== "image" && !isHolder) throw new Error(`Target ${targetShape.id} is type "${targetShape.type}", not an image or AI 图片 holder.`);
  if (isHolder) assertExpectedRequest(targetShape, args.expectedRequestId, "replace holder image");

  const preconditionHash = sourceHashArg(args);
  const preconditionShape = preconditionHash ? resolveImageLikeShape(store, targetShape, { label: "Writeback source" }) : null;
  const sourcePrecondition = preconditionShape ? await assertSourcePrecondition(store, args, preconditionShape, preconditionHash, deps) : null;
  const imageSize = source.dimensions;
  const width = finiteNumber(args.displayWidth, finiteNumber(targetShape.props?.w, imageSize?.width ?? 1));
  const height = finiteNumber(args.displayHeight, finiteNumber(targetShape.props?.h, imageSize?.height ?? 1));
  const naturalSize = imageSize ?? { width: Math.round(width), height: Math.round(height) };
  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "pages", pageDirName(pageId), "assets");
  if (!isSafeChildPath(canvasDir, assetsDir)) throw new Error(`Unsafe page assets directory: ${assetsDir}`);

  const { fileName, filePath } = await uniqueFilePath(assetsDir, source.defaultName);
  const assetId = uniqueRecordId(store, "asset", sanitizeIdPart(fileName));
  const oldAssetId = nonEmptyString(targetShape.props?.assetId);
  const assetRecord = {
    id: assetId, typeName: "asset", type: "image",
    props: { name: fileName, src: pageAssetUrl(pageId, fileName), w: naturalSize.width, h: naturalSize.height, fileSize: source.bytes, mimeType: mimeTypeForFile(fileName), isAnimated: false },
    meta: args.assetMeta && typeof args.assetMeta === "object" ? args.assetMeta : {},
  };
  const updatedMeta = await replacementMeta({ targetShape, args, isHolder, sourcePrecondition, deps });
  const updatedShape = { ...targetShape, props: { ...targetShape.props, assetId, w: width, h: height, ...(isHolder ? { status: "filled" } : {}) }, meta: updatedMeta };
  const removeOldAsset = oldAssetId && args.keepOldAsset !== true && !assetReferencedByOthers(store, oldAssetId, targetShape.id);
  const oldAssetFile = removeOldAsset ? await localAssetFileForShape(store, targetShape, canvasDir) : null;

  if (!args.dryRun) {
    await mkdir(assetsDir, { recursive: true });
    await writeResolvedImage(source, filePath, assetsDir);
    try {
      await persistRecords(cowartUrl, store, snapshot, {
        put: [assetRecord, updatedShape],
        remove: removeOldAsset ? [oldAssetId] : [],
        conditions: [...requestConditionList(targetShape.id, args.expectedRequestId), ...(sourcePrecondition ? [sourceCondition(sourcePrecondition)] : [])],
      });
    } catch (error) {
      await rm(filePath, { force: true }).catch(() => {});
      throw error;
    }
    if (oldAssetFile && resolve(oldAssetFile) !== resolve(filePath)) await rm(oldAssetFile, { force: true }).catch(() => {});
  }

  return {
    cowartUrl, pageId, shapeId: targetShape.id, assetId, previousAssetId: oldAssetId ?? null, removedPreviousAsset: Boolean(removeOldAsset),
    removedPreviousAssetFile: Boolean(oldAssetFile), assetFile: filePath, assetUrl: assetRecord.props.src, imageSize: naturalSize,
    bounds: { w: width, h: height }, dryRun: Boolean(args.dryRun),
  };
}

function assetReferencedByOthers(store, assetId, exceptShapeId) {
  return Object.values(store).some((record) => record?.typeName === "shape" && record.id !== exceptShapeId && record.props?.assetId === assetId);
}

async function replacementMeta({ targetShape, args, isHolder, sourcePrecondition, deps }) {
  const updatedMeta = args.genParams && typeof args.genParams === "object" ? { ...(targetShape.meta ?? {}), cowartGen: args.genParams } : { ...(targetShape.meta ?? {}) };
  const objectEdit = await objectEditProvenance(args, sourcePrecondition, deps);
  if (objectEdit) updatedMeta.cowartObjectEdit = objectEdit;
  if (isHolder) {
    const activeRequest = currentHolderRequest(targetShape);
    const archived = archiveRequest(activeRequest, { completedAt: new Date().toISOString() });
    if (archived) updatedMeta.cowartLastRequest = archived;
    delete updatedMeta.cowartRequest;
  }
  return updatedMeta;
}

export async function readAssetBase64(filePath) {
  return (await readFile(filePath)).toString("base64");
}
