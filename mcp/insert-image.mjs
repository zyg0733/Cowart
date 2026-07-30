import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { COWART_AI_IMAGE_SHAPE } from "./constants.mjs";
import { findPageIdForShape, getRecord, loadCanvasSnapshot, persistRecords, readSelectionState, readViewState } from "./canvas-client.mjs";
import { chooseIndex, choosePlacement, firstSelectedShapeId, pageBoundsForShape } from "./geometry.mjs";
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
import { assertSourcePrecondition, objectEditProvenance, resolveImageLikeShape, sourceCondition, sourceHashArg } from "./object-aware-deps.mjs";
import { makeArrowBinding, SHAPE_BUILDERS } from "./shape-authoring.mjs";

export async function insertCowartImage(args = {}, deps) {
  const source = await resolveImageSource(args);
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const { selection } = await readSelectionState(args);
  const viewState = await readViewState(args);
  const anchorShapeId = nonEmptyString(args.anchorShapeId) || nonEmptyString(args.sourceShapeId) || firstSelectedShapeId(selection);
  const anchorShape = anchorShapeId ? getRecord(store, anchorShapeId, "anchor shape") : null;
  const pageId = nonEmptyString(args.pageId) || (anchorShape ? findPageIdForShape(store, anchorShape.id) : null) || nonEmptyString(viewState?.currentPageId) || Object.values(store).find((record) => record?.typeName === "page")?.id;
  if (!pageId || !store[pageId]) throw new Error("Could not determine target pageId.");

  const fillAnchor = args.fillAnchor === true && Boolean(anchorShape);
  const anchorIsFrame = anchorShape?.type === "frame";
  if (fillAnchor && anchorShape?.type === COWART_AI_IMAGE_SHAPE) throw new Error("To fill a cowart-ai-image holder, use replace_cowart_image (it sets the holder's own image), not insert_cowart_image fillAnchor.");
  const parentId = fillAnchor ? anchorIsFrame ? anchorShape.id : nonEmptyString(anchorShape.parentId) ?? pageId : anchorShape?.parentId && store[anchorShape.parentId]?.typeName === "page" ? anchorShape.parentId : pageId;
  if (!store[parentId]) throw new Error(`Could not determine target parent: ${parentId}`);

  const preconditionHash = sourceHashArg(args);
  const preconditionShapeId = nonEmptyString(args.lineageOf) || anchorShapeId;
  const preconditionShape = preconditionHash && preconditionShapeId ? resolveImageLikeShape(store, getRecord(store, preconditionShapeId, "source shape"), { label: "Writeback source" }) : null;
  const sourcePrecondition = preconditionShape ? await assertSourcePrecondition(store, args, preconditionShape, preconditionHash, deps) : null;
  const imageSize = source.dimensions;
  const anchorBounds = anchorShape ? pageBoundsForShape(store, anchorShape) : null;
  const size = displaySizeForInsert({ args, fillAnchor, anchorShape, anchorBounds, imageSize, source });
  const naturalSize = imageSize ?? { width: Math.round(size.width), height: Math.round(size.height) };
  const placement = ["right", "left", "below"].includes(args.placement) ? args.placement : "right";
  const positioned = positionForInsert({ args, fillAnchor, anchorIsFrame, anchorShape, store, pageId, parentId, size, placement });
  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "pages", pageDirName(pageId), "assets");
  if (!isSafeChildPath(canvasDir, assetsDir)) throw new Error(`Unsafe page assets directory: ${assetsDir}`);

  const { fileName, filePath } = await uniqueFilePath(assetsDir, source.defaultName);
  const assetId = uniqueRecordId(store, "asset", sanitizeIdPart(fileName));
  const shapeId = uniqueRecordId(store, "shape", sanitizeIdPart(fileName));
  const assetRecord = imageAssetRecord({ assetId, fileName, pageId, naturalSize, source, mimeType: mimeTypeForFile(fileName), args });
  const shapeMeta = await imageShapeMeta({ args, fillAnchor, anchorShapeId, store, sourcePrecondition, deps });
  const shapeRecord = imageShapeRecord({ shapeId, assetId, parentId, index: chooseIndex(store, parentId), bounds: positioned, naturalSize, rotation: positioned.rotation, args, shapeMeta });
  const { lineageRecords, lineageConnectorId } = lineageForInsert({ args, store, pageId, shapeId, lineageParent: shapeMeta.lineageParent, positioned });

  if (!args.dryRun) {
    await mkdir(assetsDir, { recursive: true });
    await writeResolvedImage(source, filePath, assetsDir);
    try {
      await persistRecords(cowartUrl, store, snapshot, { put: [assetRecord, shapeRecord, ...lineageRecords], conditions: sourcePrecondition ? [sourceCondition(sourcePrecondition)] : [] });
    } catch (mergeError) {
      await rm(filePath, { force: true }).catch(() => {});
      throw mergeError;
    }
  }
  return {
    cowartUrl, pageId, parentId, anchorShapeId, assetId, shapeId, index: shapeRecord.index, sourceImagePath: source.sourcePath ?? null,
    assetFile: filePath, assetUrl: assetRecord.props.src, imageSize: naturalSize, fillAnchor,
    bounds: { x: positioned.x, y: positioned.y, w: size.width, h: size.height },
    lineage: shapeMeta.lineageParent ? { parentShapeId: shapeMeta.lineageParent.id, connectorId: lineageConnectorId, version: shapeMeta.cowartLineage.version, prompt: shapeMeta.cowartLineage.prompt } : null,
    dryRun: Boolean(args.dryRun),
  };
}

function displaySizeForInsert({ args, fillAnchor, anchorShape, anchorBounds, imageSize, source }) {
  const explicitWidth = finiteNumber(args.displayWidth, null);
  const explicitHeight = finiteNumber(args.displayHeight, null);
  const holderWidth = finiteNumber(anchorShape?.props?.w, null);
  const holderHeight = finiteNumber(anchorShape?.props?.h, null);
  let width;
  let height;
  if (fillAnchor) {
    width = explicitWidth ?? holderWidth ?? anchorBounds?.w ?? (imageSize ? Math.min(imageSize.width, 512) : null);
    height = explicitHeight ?? holderHeight ?? anchorBounds?.h ?? (imageSize && width ? Math.round(width * (imageSize.height / imageSize.width)) : null);
  } else if (args.matchAnchor !== false && anchorBounds) {
    width = explicitWidth ?? anchorBounds.w;
    height = explicitHeight ?? anchorBounds.h;
  } else if (imageSize) {
    width = explicitWidth ?? Math.min(imageSize.width, 512);
    height = explicitHeight ?? Math.round(width * (imageSize.height / imageSize.width));
  } else if (explicitWidth && explicitHeight) {
    width = explicitWidth;
    height = explicitHeight;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Could not determine display size for ${source.sourcePath ?? "the image"}. Provide displayWidth and displayHeight, anchor to an existing shape, or use a PNG/JPEG/WebP source.`);
  }
  return { width, height };
}

function positionForInsert({ args, fillAnchor, anchorIsFrame, anchorShape, store, pageId, parentId, size, placement }) {
  if (fillAnchor) {
    const base = anchorIsFrame
      ? { x: 0, y: 0, rotation: 0 }
      : { x: finiteNumber(anchorShape.x, 0), y: finiteNumber(anchorShape.y, 0), rotation: finiteNumber(anchorShape.rotation, 0) };
    return { ...base, w: size.width, h: size.height };
  }
  const margin = Math.max(0, finiteNumber(args.margin, 40));
  return { ...choosePlacement({ store, pageId, parentId, anchorShape, width: size.width, height: size.height, margin, placement }), rotation: 0 };
}

function imageAssetRecord({ assetId, fileName, pageId, naturalSize, source, mimeType, args }) {
  return {
    id: assetId, typeName: "asset", type: "image",
    props: { name: fileName, src: pageAssetUrl(pageId, fileName), w: naturalSize.width, h: naturalSize.height, fileSize: source.bytes, mimeType, isAnimated: false },
    meta: args.assetMeta && typeof args.assetMeta === "object" ? args.assetMeta : {},
  };
}

async function imageShapeMeta({ args, fillAnchor, anchorShapeId, store, sourcePrecondition, deps }) {
  const shapeMeta = args.shapeMeta && typeof args.shapeMeta === "object" ? { ...args.shapeMeta } : {};
  if (fillAnchor && anchorShapeId && !shapeMeta.cowartGeneratedForAiImageHolder) shapeMeta.cowartGeneratedForAiImageHolder = anchorShapeId;
  if (!fillAnchor && anchorShapeId && !shapeMeta.cowartAnnotationSourceShapeId) shapeMeta.cowartAnnotationSourceShapeId = anchorShapeId;
  if (nonEmptyString(args.annotationScreenshot) && !shapeMeta.cowartAnnotationScreenshot) shapeMeta.cowartAnnotationScreenshot = nonEmptyString(args.annotationScreenshot);
  const objectEdit = await objectEditProvenance(args, sourcePrecondition, deps);
  if (objectEdit) shapeMeta.cowartObjectEdit = objectEdit;
  const lineageParentId = nonEmptyString(args.lineageOf);
  const lineageParent = lineageParentId ? store[lineageParentId] : null;
  if (lineageParentId && (!lineageParent || lineageParent.typeName !== "shape")) throw new Error(`lineageOf is not a shape: ${lineageParentId}`);
  if (lineageParent) shapeMeta.cowartLineage = { parentShapeId: lineageParentId, prompt: nonEmptyString(args.prompt) ?? null, version: finiteNumber(args.version, null), createdAt: new Date().toISOString() };
  shapeMeta.lineageParent = lineageParent;
  return shapeMeta;
}

function imageShapeRecord({ shapeId, assetId, parentId, index, bounds, naturalSize, rotation, args, shapeMeta }) {
  const { lineageParent, ...meta } = shapeMeta;
  return {
    x: bounds.x, y: bounds.y, rotation, isLocked: false, opacity: 1, meta, id: shapeId, type: "image",
    props: { w: bounds.w ?? naturalSize.width, h: bounds.h ?? naturalSize.height, assetId, playing: true, url: "", crop: null, flipX: false, flipY: false, altText: nonEmptyString(args.altText) || "Cowart inserted image" },
    parentId, index, typeName: "shape",
  };
}

function lineageForInsert({ args, store, pageId, shapeId, lineageParent, positioned }) {
  const lineageRecords = [];
  let lineageConnectorId = null;
  if (!lineageParent || args.lineageConnector === false) return { lineageRecords, lineageConnectorId };
  const parentBounds = pageBoundsForShape(store, lineageParent);
  if (!parentBounds) return { lineageRecords, lineageConnectorId };
  const parentCenter = { x: parentBounds.x + parentBounds.w / 2, y: parentBounds.y + parentBounds.h / 2 };
  const newCenter = { x: positioned.x + positioned.w / 2, y: positioned.y + positioned.h / 2 };
  lineageConnectorId = uniqueRecordId(store, "shape", "lineage");
  store[lineageConnectorId] = { id: lineageConnectorId, typeName: "shape" };
  lineageRecords.push({
    id: lineageConnectorId, typeName: "shape", type: "arrow", x: parentCenter.x, y: parentCenter.y, rotation: 0,
    index: chooseIndex(store, pageId), parentId: pageId, isLocked: false, opacity: 1, meta: { cowartLineageConnector: true },
    props: SHAPE_BUILDERS.arrow({ start: { x: 0, y: 0 }, end: { x: newCenter.x - parentCenter.x, y: newCenter.y - parentCenter.y }, color: "grey", dash: "dotted", size: "s", arrowheadEnd: "arrow" }),
  });
  lineageRecords.push(makeArrowBinding(store, lineageConnectorId, lineageParent.id, "start"));
  lineageRecords.push(makeArrowBinding(store, lineageConnectorId, shapeId, "end"));
  return { lineageRecords, lineageConnectorId };
}
