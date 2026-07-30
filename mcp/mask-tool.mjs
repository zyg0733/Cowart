import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createImageCoordinateMapper } from "../shared/cowart-image-coordinates.mjs";
import { getRecord, loadCanvasSnapshot, readSelectionState } from "./canvas-client.mjs";
import { findPageIdForShape } from "./canvas-client.mjs";
import { firstSelectedShapeId, localBoundsForShape } from "./geometry.mjs";
import { makeSegmentCowartMask, localAssetFileForShape, resolveImageLikeShape, exportTimestamp } from "./object-aware-deps.mjs";
import { codedError } from "./object-aware-errors.mjs";
import { encodeMaskPng } from "./mask-png.mjs";
import { finiteNumber, isSafeChildPath, nonEmptyString, pathResolve, resolveCanvasDir, sanitizeFileName } from "./paths.mjs";

export async function makeCowartMask(args = {}, deps) {
  const { snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const { selection } = await readSelectionState(args);
  const selectors = [
    args.region && typeof args.region === "object" ? "region" : null,
    nonEmptyString(args.regionShapeId) ? "regionShapeId" : null,
    nonEmptyString(args.segmentId) ? "segmentId" : null,
  ].filter(Boolean);
  if (selectors.length !== 1) codedError("invalid_selector", "Provide exactly one selector: region, regionShapeId, or segmentId.", 400, { selectors });
  if (selectors[0] === "segmentId") return makeSegmentCowartMask(args, deps);

  const targetShapeId = nonEmptyString(args.targetShapeId) || nonEmptyString(args.shapeId) || firstSelectedShapeId(selection);
  if (!targetShapeId) throw new Error("targetShapeId is required (or select the image to edit).");
  let targetShape = getRecord(store, targetShapeId, "target shape");
  const pageId = findPageIdForShape(store, targetShape.id);
  if (!pageId) throw new Error(`Could not determine the page for ${targetShapeId}.`);
  targetShape = resolveImageLikeShape(store, targetShape, { label: "Mask target" });
  if (!targetShape) throw new Error(`Target ${targetShapeId} is type "${store[targetShapeId]?.type}", not an image.`);
  const asset = store[targetShape.props?.assetId];
  const naturalW = Math.round(finiteNumber(asset?.props?.w, finiteNumber(targetShape.props?.w, 0)));
  const naturalH = Math.round(finiteNumber(asset?.props?.h, finiteNumber(targetShape.props?.h, 0)));
  if (!(naturalW > 0 && naturalH > 0)) throw new Error("Could not determine the image's pixel size.");
  const imageMapper = coordinateMapperForShape(store, targetShape, {
    pageId,
    shapeId: targetShape.id,
    assetId: asset?.id,
    width: naturalW,
    height: naturalH,
  });
  const imgBounds = pageBoundsFromMapper(imageMapper, { x: 0, y: 0, ...imageMapper.localSize });
  if (!imgBounds || imgBounds.w <= 0 || imgBounds.h <= 0) throw new Error("Could not determine the image's page bounds.");
  let regionPage = regionInPageSpace({ args, store, selectors, imgBounds });
  const padding = Math.max(0, finiteNumber(args.padding, 0));
  regionPage = { x: regionPage.x - padding, y: regionPage.y - padding, w: regionPage.w + 2 * padding, h: regionPage.h + 2 * padding };
  const pixelRegion = clipPixelRegion(imageMapper.pageAabbToNaturalAabb(regionPage), naturalW, naturalH);
  if (pixelRegion.w <= 0 || pixelRegion.h <= 0) throw new Error("The region does not overlap the image.");
  return writeMaskResult({ args, store, targetShape, pageId, naturalW, naturalH, imgBounds, pixelRegion });
}

function regionInPageSpace({ args, store, selectors, imgBounds }) {
  if (selectors[0] === "region") {
    return { x: finiteNumber(args.region.x, imgBounds.x), y: finiteNumber(args.region.y, imgBounds.y), w: finiteNumber(args.region.w, imgBounds.w), h: finiteNumber(args.region.h, imgBounds.h) };
  }
  const regionShape = getRecord(store, nonEmptyString(args.regionShapeId), "region shape");
  const localBounds = localBoundsForShape(regionShape);
  const regionPage = localBounds
    ? pageBoundsFromMapper(coordinateMapperForShape(store, regionShape, { width: localBounds.w, height: localBounds.h }), localBounds)
    : null;
  if (!regionPage) throw new Error("Could not determine bounds for regionShapeId.");
  return regionPage;
}

function coordinateMapperForShape(store, shape, source) {
  const ancestors = [];
  const visited = new Set([shape.id]);
  let parent = store[shape.parentId];
  while (parent?.typeName === "shape" && !visited.has(parent.id)) {
    visited.add(parent.id);
    ancestors.push(parent);
    parent = store[parent.parentId];
  }
  return createImageCoordinateMapper({ source, shape, ancestors });
}

function pageBoundsFromMapper(mapper, box) {
  const points = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map(mapper.localPointToPagePoint);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const stable = (value) => Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value) : value;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: stable(x), y: stable(y), w: stable(Math.max(...xs) - x), h: stable(Math.max(...ys) - y) };
}

function clipPixelRegion(region, naturalW, naturalH) {
  const x0 = Math.max(0, Math.min(region.x, naturalW));
  const y0 = Math.max(0, Math.min(region.y, naturalH));
  const x1 = Math.max(0, Math.min(region.x + region.w, naturalW));
  const y1 = Math.max(0, Math.min(region.y + region.h, naturalH));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

async function writeMaskResult({ args, store, targetShape, pageId, naturalW, naturalH, imgBounds, pixelRegion }) {
  const maskBuffer = encodeMaskPng(naturalW, naturalH, pixelRegion, { invert: args.invert === true });
  const canvasDir = resolveCanvasDir(args);
  const sourceImageFile = await localAssetFileForShape(store, targetShape, canvasDir);
  const outDir = nonEmptyString(args.outputDir) ? pathResolve(args.outputDir) : join(canvasDir, "masks");
  const maskFile = join(outDir, sanitizeFileName(nonEmptyString(args.maskFileName) || `cowart-mask-${exportTimestamp()}.png`, "cowart-mask.png"));
  if (!isSafeChildPath(outDir, maskFile)) throw new Error(`Unsafe mask file path: ${maskFile}`);
  if (!args.dryRun) {
    await mkdir(outDir, { recursive: true });
    await writeFile(maskFile, maskBuffer);
  }
  const result = { targetShapeId: targetShape.id, pageId, naturalSize: { width: naturalW, height: naturalH }, imageBounds: imgBounds, pixelRegion, invert: args.invert === true, maskFile, sourceImageFile, dryRun: Boolean(args.dryRun) };
  if (args.returnBase64 === true) {
    result.maskBase64 = maskBuffer.toString("base64");
    if (sourceImageFile) {
      try {
        result.sourceImageBase64 = (await readFile(sourceImageFile)).toString("base64");
      } catch {
        result.sourceImageBase64 = null;
      }
    }
  }
  return result;
}
