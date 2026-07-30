import {
  TOOL_ADD_SHAPES,
  TOOL_CREATE_HOLDER,
  TOOL_CREATE_VARIANT_GRID,
  TOOL_EXPORT_VIEW,
  TOOL_EXTRACT_OBJECT,
  TOOL_GET_ANNOTATIONS,
  TOOL_GET_CANVAS,
  TOOL_GET_REFERENCES,
  TOOL_GET_REQUESTS,
  TOOL_GET_SELECTION,
  TOOL_INSERT_IMAGE,
  TOOL_MAKE_MASK,
  TOOL_REFINE_SEGMENT,
  TOOL_REPLACE_IMAGE,
  TOOL_SEGMENT_IMAGE,
  TOOL_SELECT_VARIANT,
  TOOL_UPDATE_HOLDER,
} from "./constants.mjs";
import { getRecord, loadCanvasSnapshot, readSelectionState } from "./canvas-client.mjs";
import { createObjectAwareDeps, confirmedSegmentsBySource, refineCowartSegmentTool, segmentCowartImageTool } from "./object-aware-deps.mjs";
import { addCowartShapes } from "./shape-authoring.mjs";
import { createCowartImageHolder, getCowartReferences, updateCowartHolder } from "./holder-tools.mjs";
import { describeShape, getCowartAnnotations, getCowartCanvas, getCowartRequests } from "./readouts.mjs";
import { exportCowartView } from "./export-tool.mjs";
import { insertCowartImage } from "./insert-image.mjs";
import { makeCowartMask } from "./mask-tool.mjs";
import { extractCowartObject } from "./object-actions.mjs";
import { replaceCowartImage } from "./replace-image.mjs";
import { createCowartVariantGrid, selectCowartVariant } from "./variant-tools.mjs";
import { sendError, sendResult, JsonRpcError } from "./transport.mjs";

const objectAwareDeps = createObjectAwareDeps(loadCanvasSnapshot, getRecord);

export async function handleToolCall(id, params) {
  const toolArgs = params.arguments ?? {};
  if (params?.name === TOOL_GET_SELECTION) return sendSelection(id, toolArgs);
  if (params?.name === TOOL_INSERT_IMAGE) return sendInsertImage(id, toolArgs);
  if (params?.name === TOOL_GET_CANVAS) return sendCanvas(id, toolArgs);
  if (params?.name === TOOL_GET_ANNOTATIONS) return sendAnnotations(id, toolArgs);
  if (params?.name === TOOL_GET_REQUESTS) return sendRequests(id, toolArgs);
  if (params?.name === TOOL_CREATE_HOLDER) return sendCreateHolder(id, toolArgs);
  if (params?.name === TOOL_REPLACE_IMAGE) return sendReplaceImage(id, toolArgs);
  if (params?.name === TOOL_EXPORT_VIEW) return sendExportView(id, toolArgs);
  if (params?.name === TOOL_ADD_SHAPES) return sendAddShapes(id, toolArgs);
  if (params?.name === TOOL_MAKE_MASK) return sendMakeMask(id, toolArgs);
  if (params?.name === TOOL_SEGMENT_IMAGE) return sendSegmentImage(id, toolArgs);
  if (params?.name === TOOL_REFINE_SEGMENT) return sendRefineSegment(id, toolArgs);
  if (params?.name === TOOL_EXTRACT_OBJECT) return sendExtractObject(id, toolArgs);
  if (params?.name === TOOL_CREATE_VARIANT_GRID) return sendCreateVariantGrid(id, toolArgs);
  if (params?.name === TOOL_SELECT_VARIANT) return sendSelectVariant(id, toolArgs);
  if (params?.name === TOOL_UPDATE_HOLDER) return sendUpdateHolder(id, toolArgs);
  if (params?.name === TOOL_GET_REFERENCES) return sendReferences(id, toolArgs);
  sendError(id, JsonRpcError.INVALID_PARAMS, `Unknown tool: ${params?.name ?? ""}`);
}

async function sendSelection(id, toolArgs) {
  const { selection, selectionFile } = await readSelectionState(toolArgs);
  let enrichedSelection = selection;
  try {
    const { snapshot } = await loadCanvasSnapshot(toolArgs);
    const segmentMap = await confirmedSegmentsBySource(toolArgs, snapshot.store, objectAwareDeps);
    enrichedSelection = {
      ...selection,
      selectedShapes: (selection.selectedShapes ?? []).map((selected) => {
        const shape = selected?.id ? snapshot.store[selected.id] : null;
        return shape ? { ...selected, ...describeShape(snapshot.store, shape, segmentMap) } : selected;
      }),
    };
  } catch {
    enrichedSelection = selection;
  }
  const selectedShapes = enrichedSelection.selectedShapes ?? [];
  const summary = selectedShapes.length === 0
    ? "No Cowart shapes are currently selected."
    : selectedShapes.map((shape) => `${shape.id} [${shape.type ?? "unknown"}]${shape.asset?.name ? ` (${shape.asset.name})` : ""}`).join("\n");
  sendResult(id, { content: [{ type: "text", text: summary }], structuredContent: { selection: enrichedSelection, selectionFile } }, toolArgs);
}

async function sendInsertImage(id, toolArgs) {
  const result = await insertCowartImage(toolArgs, objectAwareDeps);
  sendResult(id, { content: [{ type: "text", text: `${result.dryRun ? "Planned" : "Inserted"} ${result.shapeId} on ${result.pageId} at (${result.bounds.x}, ${result.bounds.y}) using ${result.index}.` }], structuredContent: result }, toolArgs);
}

async function sendCanvas(id, toolArgs) {
  const result = await getCowartCanvas(toolArgs, objectAwareDeps);
  const totalShapes = result.pages.reduce((sum, page) => sum + page.shapes.length, 0);
  const summary = result.pages.length === 0 ? "Cowart canvas has no pages." : `${result.pages.map((page) => `${page.name ?? page.pageId} (${page.pageId}): ${page.shapes.length} shape(s)`).join("\n")}\n${totalShapes} shape(s) total.`;
  sendResult(id, { content: [{ type: "text", text: summary }], structuredContent: result }, toolArgs);
}

async function sendAnnotations(id, toolArgs) {
  const result = await getCowartAnnotations(toolArgs);
  const summary = result.annotations.length === 0 ? "No Cowart annotations found." : result.annotations.map((annotation) => `${annotation.id}: "${annotation.text}"${annotation.target ? ` -> ${annotation.target.id} [${annotation.target.type}]${annotation.target.asset?.name ? ` (${annotation.target.asset.name})` : ""}` : " -> (no target)"}`).join("\n");
  sendResult(id, { content: [{ type: "text", text: summary }], structuredContent: result }, toolArgs);
}

async function sendRequests(id, toolArgs) {
  const result = await getCowartRequests(toolArgs);
  const summary = result.requests.length === 0 ? "No Cowart holder requests found." : result.requests.map((request) => `${request.holderId}: status=${request.status}, request=${request.requestId ?? "legacy"}`).join("\n");
  sendResult(id, { content: [{ type: "text", text: summary }], structuredContent: result }, toolArgs);
}

async function sendCreateHolder(id, toolArgs) {
  const result = await createCowartImageHolder(toolArgs, objectAwareDeps);
  sendResult(id, { content: [{ type: "text", text: `${result.dryRun ? "Planned" : "Created"} holder ${result.shapeId} on ${result.pageId} at (${result.bounds.x}, ${result.bounds.y}).` }], structuredContent: result }, toolArgs);
}

async function sendReplaceImage(id, toolArgs) {
  const result = await replaceCowartImage(toolArgs, objectAwareDeps);
  sendResult(id, { content: [{ type: "text", text: `${result.dryRun ? "Planned replacement of" : "Replaced"} ${result.shapeId} asset -> ${result.assetId}${result.removedPreviousAsset ? " (old asset removed)" : ""}.` }], structuredContent: result }, toolArgs);
}

async function sendExportView(id, toolArgs) {
  const result = await exportCowartView(toolArgs);
  sendResult(id, { content: [{ type: "text", text: `${result.dryRun ? "Planned export" : "Exported"} (${result.strategy}) -> ${result.outputPath}` }], structuredContent: result }, toolArgs);
}

async function sendAddShapes(id, toolArgs) {
  const result = await addCowartShapes(toolArgs);
  sendResult(id, { content: [{ type: "text", text: `${result.dryRun ? "Planned" : "Added"} ${result.count} shape(s)${result.bindingCount ? ` + ${result.bindingCount} binding(s)` : ""} on ${result.pageId}: ${result.created.map((shape) => `${shape.id} [${shape.type}]`).join(", ")}.` }], structuredContent: result }, toolArgs);
}

async function sendMakeMask(id, toolArgs) {
  const result = await makeCowartMask(toolArgs, objectAwareDeps);
  const detail = result.pixelRegion ? `region px (${result.pixelRegion.x},${result.pixelRegion.y},${result.pixelRegion.w}x${result.pixelRegion.h})` : `segment ${result.segmentId}`;
  sendResult(id, { content: [{ type: "text", text: `${result.dryRun ? "Planned" : "Built"} edit mask for ${result.targetShapeId} (${result.naturalSize.width}x${result.naturalSize.height}), ${detail} -> ${result.maskFile}` }], structuredContent: result }, toolArgs);
}

async function sendSegmentImage(id, toolArgs) {
  const result = await segmentCowartImageTool(toolArgs, objectAwareDeps);
  sendResult(id, { content: [{ type: "text", text: "Browser interaction is required to create a confirmed object segment." }], structuredContent: result }, toolArgs);
}

async function sendRefineSegment(id, toolArgs) {
  const result = await refineCowartSegmentTool(toolArgs, objectAwareDeps);
  sendResult(id, { content: [{ type: "text", text: `Refined ${result.parentSegmentId} -> ${result.segment.segmentId}.` }], structuredContent: result }, toolArgs);
}

async function sendExtractObject(id, toolArgs) {
  const result = await extractCowartObject(toolArgs, objectAwareDeps);
  sendResult(id, {
    content: [{ type: "text", text: `${result.dryRun ? "Planned extraction" : "Extracted"} ${result.segmentId} -> ${result.shapeId} (${result.extraction.naturalSize.width}x${result.extraction.naturalSize.height} transparent PNG).` }],
    structuredContent: result,
  }, toolArgs);
}

async function sendCreateVariantGrid(id, toolArgs) {
  const result = await createCowartVariantGrid(toolArgs, objectAwareDeps);
  sendResult(id, {
    content: [{ type: "text", text: `${result.dryRun ? "Planned" : "Created"} Variant Grid ${result.gridId} with ${result.count} queued holder(s).` }],
    structuredContent: result,
  }, toolArgs);
}

async function sendSelectVariant(id, toolArgs) {
  const result = await selectCowartVariant(toolArgs, objectAwareDeps);
  sendResult(id, {
    content: [{ type: "text", text: `${result.dryRun ? "Planned winner" : "Selected winner"} ${result.winnerHolderId} for ${result.gridId}; ${result.memberHolderIds.length - 1} alternative(s) retained.` }],
    structuredContent: result,
  }, toolArgs);
}

async function sendUpdateHolder(id, toolArgs) {
  const result = await updateCowartHolder(toolArgs);
  sendResult(id, { content: [{ type: "text", text: `${result.dryRun ? "Planned update for" : "Updated"} holder ${result.holderId}: status=${result.status}${result.prompt ? `, prompt="${result.prompt}"` : ""}${result.references ? `, refs=${result.references.length}` : ""}.` }], structuredContent: result }, toolArgs);
}

async function sendReferences(id, toolArgs) {
  const result = await getCowartReferences(toolArgs);
  const summary = result.references.map((reference) => `${reference.id} [${reference.role ?? "?"}]${reference.found === false ? " (missing)" : reference.assetFile ? "" : " (no local file)"}`).join("\n");
  sendResult(id, { content: [{ type: "text", text: summary || "No references." }], structuredContent: result }, toolArgs);
}
