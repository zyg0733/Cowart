import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import { fetchJson, loadCanvasSnapshot, readSelectionState } from "./canvas-client.mjs";
import { finiteNumber, mimeTypeForFile, nonEmptyString, pathResolve, resolveCanvasDir } from "./paths.mjs";
import { exportTimestamp, localAssetFileForShape, resolveImageLikeShape } from "./object-aware-deps.mjs";

function resolveSingleImageShape(store, { mode, shapeIds, selection }) {
  let ids = null;
  if (mode === "shapes" && Array.isArray(shapeIds)) ids = shapeIds;
  else if (mode === "selection") ids = (selection?.selectedShapes ?? []).map((shape) => shape.id);
  else return null;
  if (!ids || ids.length !== 1) return null;
  const shape = store[ids[0]];
  if (!shape) return null;
  return resolveImageLikeShape(store, shape, { label: "Export target" });
}

export async function exportCowartView(args = {}) {
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const { selection } = await readSelectionState(args);
  const explicitShapeId = nonEmptyString(args.targetShapeId) || nonEmptyString(args.shapeId);
  let mode = nonEmptyString(args.mode);
  let shapeIds = Array.isArray(args.shapeIds) ? args.shapeIds.filter((value) => typeof value === "string") : null;
  if (!mode) {
    if (explicitShapeId) mode = "shapes";
    else if ((selection?.selectedShapes ?? []).length > 0) mode = "selection";
    else mode = "currentPage";
  }
  if (mode === "shapes" && (!shapeIds || shapeIds.length === 0) && explicitShapeId) shapeIds = [explicitShapeId];
  const requestedFormat = ["png", "jpeg", "svg", "webp"].includes(args.format) ? args.format : null;
  const canvasDir = resolveCanvasDir(args);
  let strategy = null;
  let assetSourceFile = null;
  if (!args.render && !requestedFormat) {
    const single = resolveSingleImageShape(store, { mode, shapeIds, selection });
    if (single) {
      const file = await localAssetFileForShape(store, single, canvasDir);
      if (file) {
        try {
          await stat(file);
          strategy = "asset";
          assetSourceFile = file;
        } catch {
          strategy = null;
        }
      }
    }
  }
  const format = requestedFormat ?? "png";
  const ext = strategy === "asset" ? extname(assetSourceFile) || ".png" : `.${format === "jpeg" ? "jpg" : format}`;
  const outputPath = nonEmptyString(args.outputPath) ? pathResolve(args.outputPath) : join(canvasDir, "exports", `cowart-export-${exportTimestamp()}${ext}`);
  if (args.dryRun) return { cowartUrl, strategy: strategy ?? "render", mode, shapeIds: shapeIds ?? null, format: strategy === "asset" ? "asset" : format, outputPath, dryRun: true };
  await mkdir(dirname(outputPath), { recursive: true });
  if (strategy === "asset") return exportAsset({ args, cowartUrl, outputPath, assetSourceFile });
  return exportRendered({ args, cowartUrl, mode, shapeIds, format, outputPath });
}

async function exportAsset({ args, cowartUrl, outputPath, assetSourceFile }) {
  await copyFile(assetSourceFile, outputPath);
  const bytes = (await stat(outputPath)).size;
  const result = { cowartUrl, strategy: "asset", outputPath, sourceFile: assetSourceFile, bytes, dryRun: false };
  if (args.returnBase64 === true) {
    result.base64 = (await readFile(assetSourceFile)).toString("base64");
    result.mimeType = mimeTypeForFile(assetSourceFile);
  }
  return result;
}

async function exportRendered({ args, cowartUrl, mode, shapeIds, format, outputPath }) {
  const render = await fetchJson(`${cowartUrl}/api/canvas/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode, shapeIds: shapeIds ?? undefined, pageId: nonEmptyString(args.pageId) || undefined, format,
      scale: finiteNumber(args.scale, undefined), padding: finiteNumber(args.padding, undefined),
      background: typeof args.background === "boolean" ? args.background : undefined, timeoutMs: finiteNumber(args.timeoutMs, undefined),
    }),
  });
  if (!render?.base64) throw new Error("The Cowart browser returned no image data for the export.");
  const buffer = Buffer.from(render.base64, "base64");
  await writeFile(outputPath, buffer);
  const result = { cowartUrl, strategy: "render", outputPath, format, width: render.width ?? null, height: render.height ?? null, bytes: buffer.length, dryRun: false };
  if (args.returnBase64 === true) {
    result.base64 = render.base64;
    result.mimeType = mimeTypeForFile(outputPath);
  }
  return result;
}
