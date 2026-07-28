import { readFile } from "node:fs/promises";

import { AI_IMAGE_HOLDER_DEFAULT_H, AI_IMAGE_HOLDER_DEFAULT_W, AI_IMAGE_HOLDER_LABEL, AI_IMAGE_HOLDER_STATUSES, COWART_AI_IMAGE_SHAPE } from "./constants.mjs";
import { codedError } from "./object-aware-errors.mjs";
import { findPageIdForShape, getRecord, loadCanvasSnapshot, persistRecords, readSelectionState, readViewState } from "./canvas-client.mjs";
import { chooseIndex, choosePlacement, firstSelectedShapeId } from "./geometry.mjs";
import { localAssetFileForShape } from "./object-aware-deps.mjs";
import { trustedObjectAction } from "./object-action-meta.mjs";
import { sourceCondition } from "./object-aware-deps.mjs";
import {
  archiveRequest,
  assertExpectedRequest,
  currentHolderRequest,
  makeCowartRequest,
  redactRequestError,
  requestConditionList,
} from "./request-lifecycle.mjs";
import { finiteNumber, nonEmptyString, resolveCanvasDir, sanitizeIdPart, uniqueRecordId } from "./paths.mjs";
import { decompositionReferences } from "./decomposition-tools.mjs";

export async function createCowartImageHolder(args = {}, deps) {
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const { selection } = await readSelectionState(args);
  const viewState = await readViewState(args);
  const objectAction = await trustedObjectAction(args, args.objectAction, deps);
  const anchorShapeId = nonEmptyString(args.anchorShapeId) || objectAction?.sourceShapeId || firstSelectedShapeId(selection);
  const anchorShape = anchorShapeId ? getRecord(store, anchorShapeId, "anchor shape") : null;
  const pageId = nonEmptyString(args.pageId) || (anchorShape ? findPageIdForShape(store, anchorShape.id) : null) || nonEmptyString(viewState?.currentPageId) || Object.values(store).find((record) => record?.typeName === "page")?.id;
  if (!pageId || !store[pageId]) throw new Error("Could not determine target pageId.");

  const width = Math.max(1, finiteNumber(args.width, AI_IMAGE_HOLDER_DEFAULT_W));
  const height = Math.max(1, finiteNumber(args.height, AI_IMAGE_HOLDER_DEFAULT_H));
  const margin = Math.max(0, finiteNumber(args.margin, 40));
  const placement = ["right", "left", "below"].includes(args.placement) ? args.placement : "right";
  const { x, y } = choosePlacement({ store, pageId, parentId: pageId, anchorShape, width, height, margin, placement });
  const name = nonEmptyString(args.name) || AI_IMAGE_HOLDER_LABEL;
  const shapeId = uniqueRecordId(store, "shape", sanitizeIdPart(name, "ai-image"));
  const meta = { cowartAiImageHolder: true, cowartAiImageHolderVersion: 1, ...(args.shapeMeta && typeof args.shapeMeta === "object" ? args.shapeMeta : {}) };
  if (objectAction) {
    meta.cowartObjectAction = objectAction;
    meta.cowartRequest = makeCowartRequest(meta, { ...args, requestKind: "object_action", objectAction });
  }
  const shapeRecord = {
    x, y, rotation: 0, isLocked: false, opacity: 1, id: shapeId, type: COWART_AI_IMAGE_SHAPE, parentId: pageId,
    index: chooseIndex(store, pageId), typeName: "shape",
    meta,
    props: { w: width, h: height, name, prompt: objectAction?.prompt || nonEmptyString(args.prompt) || "", status: objectAction ? "requested" : "empty", assetId: null },
  };
  if (!args.dryRun) {
    await persistRecords(cowartUrl, store, snapshot, {
      put: [shapeRecord],
      conditions: objectAction ? [sourceCondition({
        pageId: objectAction.sourcePageId,
        shapeId: objectAction.sourceShapeId,
        assetId: objectAction.sourceAssetId,
        assetSha256: objectAction.sourceSha256,
        width: objectAction.sourceWidth,
        height: objectAction.sourceHeight,
      })] : [],
    });
  }
  return {
    cowartUrl, pageId, parentId: pageId, shapeId, index: shapeRecord.index, bounds: { x, y, w: width, h: height },
    status: shapeRecord.props.status, request: shapeRecord.meta.cowartRequest ?? null, objectAction, dryRun: Boolean(args.dryRun),
  };
}

export async function updateCowartHolder(args = {}) {
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const { selection } = await readSelectionState(args);
  const holderId = nonEmptyString(args.holderId) || nonEmptyString(args.targetShapeId) || nonEmptyString(args.shapeId) || firstSelectedShapeId(selection);
  if (!holderId) throw new Error("holderId is required (or select a holder).");
  const holder = getRecord(store, holderId, "holder");
  if (holder.type !== COWART_AI_IMAGE_SHAPE) throw new Error(`Shape ${holderId} is type "${holder.type}", not a cowart-ai-image holder.`);
  const props = { ...holder.props };
  const meta = { ...holder.meta };
  const previousDecompositionRevision = finiteNumber(meta.cowartDecomposition?.revision, null);
  let changed = updateHolderStatus({ args, holder, props, meta });
  if (typeof args.prompt === "string") {
    props.prompt = args.prompt;
    changed = true;
  }
  changed = updateHolderReferences({ args, store, meta }) || changed;
  if (args.genParams && typeof args.genParams === "object") {
    meta.cowartGen = args.genParams;
    changed = true;
  }
  if (!changed) throw new Error("Provide status, prompt, references, styleRef, or genParams to update.");
  assertExpectedRequest(holder, args.expectedRequestId, "update holder");
  const updated = { ...holder, props, meta };
  if (!args.dryRun) {
    const extraConditions = nonEmptyString(args.status) === "generating" && nonEmptyString(args.expectedRequestId) ? [{ id: holder.id, field: "props.status", equals: "requested" }] : [];
    if (previousDecompositionRevision !== null && meta.cowartDecomposition?.revision !== previousDecompositionRevision) {
      extraConditions.push({ id: holder.id, field: "meta.cowartDecomposition.revision", equals: previousDecompositionRevision });
    }
    await persistRecords(cowartUrl, store, snapshot, { put: [updated], conditions: requestConditionList(holder.id, args.expectedRequestId, extraConditions) });
  }
  return {
    cowartUrl, holderId, status: props.status, prompt: props.prompt, references: meta.cowartReferences ?? null,
    styleRef: meta.cowartStyleRef ?? null, genParams: meta.cowartGen ?? null, request: meta.cowartRequest ?? null,
    lastRequest: meta.cowartLastRequest ?? null, dryRun: Boolean(args.dryRun),
  };
}

function updateHolderStatus({ args, holder, props, meta }) {
  if (!nonEmptyString(args.status)) return false;
  if (!AI_IMAGE_HOLDER_STATUSES.includes(args.status)) {
    codedError("invalid_holder_status", `Invalid status "${args.status}". Use one of: ${AI_IMAGE_HOLDER_STATUSES.join(", ")}.`, 400, { status: args.status, allowed: AI_IMAGE_HOLDER_STATUSES });
  }
  const nextStatus = args.status;
  assertExpectedRequest(holder, args.expectedRequestId, `mark holder ${nextStatus}`);
  const activeRequest = currentHolderRequest(holder);
  if (nextStatus === "requested") {
    const previous = archiveRequest(activeRequest, { supersededAt: new Date().toISOString() });
    if (previous) meta.cowartLastRequest = previous;
    meta.cowartRequest = makeCowartRequest(meta, {
      ...args,
      objectAction: args.objectAction ?? meta.cowartObjectAction,
      variant: args.variant ?? meta.cowartVariant,
      decomposition: meta.cowartDecomposition ? {
        id: meta.cowartDecomposition.id,
        sourceShapeId: meta.cowartDecomposition.sourceShapeId,
        sourceSha256: meta.cowartDecomposition.sourceSha256,
        segmentIds: meta.cowartDecomposition.segmentIds,
        artifactKinds: ["depth_hint", "clean_plate"],
      } : undefined,
      requestKind: args.requestKind ?? (meta.cowartDecomposition ? "scene_decomposition" : meta.cowartVariant ? "variant" : meta.cowartObjectAction ? "object_action" : undefined),
    });
  } else if (nextStatus === "generating" && activeRequest) {
    meta.cowartRequest = { ...activeRequest, startedAt: nonEmptyString(activeRequest.startedAt) || new Date().toISOString() };
  } else if (nextStatus === "failed") {
    if (!activeRequest) throw new Error(`Cannot mark holder ${holder.id} failed without an active request.`);
    meta.cowartRequest = { ...activeRequest, failedAt: new Date().toISOString(), error: { message: redactRequestError(args.error ?? args.errorMessage) } };
  } else if (nextStatus === "empty" || nextStatus === "filled") {
    const archived = archiveRequest(activeRequest, { [nextStatus === "empty" ? "cancelledAt" : "completedAt"]: new Date().toISOString() });
    if (archived) meta.cowartLastRequest = archived;
    delete meta.cowartRequest;
  }
  props.status = nextStatus;
  if (meta.cowartDecomposition) {
    const decompositionStatus = nextStatus === "requested"
      ? "requested"
      : nextStatus === "generating"
        ? "generating"
        : nextStatus === "failed"
          ? "failed"
          : nextStatus === "empty"
            ? "cancelled"
            : meta.cowartDecomposition.status;
    if (decompositionStatus !== meta.cowartDecomposition.status) {
      meta.cowartDecomposition = {
        ...meta.cowartDecomposition,
        status: decompositionStatus,
        revision: finiteNumber(meta.cowartDecomposition.revision, 0) + 1,
      };
    }
  }
  return true;
}

function updateHolderReferences({ args, store, meta }) {
  let changed = false;
  if (Array.isArray(args.references)) {
    const refs = args.references.filter((id) => typeof id === "string");
    for (const id of refs) if (!store[id] || store[id].typeName !== "shape") throw new Error(`reference is not a shape: ${id}`);
    meta.cowartReferences = refs;
    changed = true;
  }
  if (args.styleRef !== undefined) {
    const styleRef = nonEmptyString(args.styleRef);
    if (styleRef && (!store[styleRef] || store[styleRef].typeName !== "shape")) throw new Error(`styleRef is not a shape: ${styleRef}`);
    if (styleRef) meta.cowartStyleRef = styleRef;
    else delete meta.cowartStyleRef;
    changed = true;
  }
  return changed;
}

export async function getCowartReferences(args = {}, deps) {
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  if (nonEmptyString(args.decompositionId)) {
    const decomposition = await decompositionReferences(args, snapshot, deps);
    return {
      cowartUrl,
      decomposition: decomposition.manifest,
      references: decomposition.references,
    };
  }
  const { selection } = await readSelectionState(args);
  const canvasDir = resolveCanvasDir(args);
  let ids = Array.isArray(args.shapeIds) ? args.shapeIds.filter((id) => typeof id === "string") : null;
  let styleRefId = nonEmptyString(args.styleRef);
  const holderId = nonEmptyString(args.holderId);
  if (holderId) {
    const holder = getRecord(store, holderId, "holder");
    if (!ids) ids = Array.isArray(holder.meta?.cowartReferences) ? holder.meta.cowartReferences : [];
    if (!styleRefId) styleRefId = nonEmptyString(holder.meta?.cowartStyleRef);
  }
  if (!ids && !styleRefId) {
    const selectedIds = (selection?.selectedShapes ?? []).map((shape) => shape.id);
    ids = selectedIds.length > 0 ? selectedIds : null;
  }
  const allIds = [...new Set([...(ids ?? []), ...(styleRefId ? [styleRefId] : [])])];
  if (allIds.length === 0) throw new Error("No references found. Provide holderId (with references in its meta), shapeIds, styleRef, or select reference images.");
  const references = [];
  for (const id of allIds) references.push(await referenceForId({ args, store, canvasDir, id, styleRefId }));
  return { cowartUrl, references };
}

async function referenceForId({ args, store, canvasDir, id, styleRefId }) {
  const shape = store[id];
  if (!shape) return { id, found: false };
  const assetFile = await localAssetFileForShape(store, shape, canvasDir);
  const asset = shape.props?.assetId ? store[shape.props.assetId] : null;
  const reference = { id, found: true, role: id === styleRefId ? "style" : "reference", type: shape.type, assetFile, naturalSize: asset ? { width: asset.props?.w ?? null, height: asset.props?.h ?? null } : null };
  if (args.returnBase64 === true && assetFile) {
    try {
      reference.base64 = (await readFile(assetFile)).toString("base64");
    } catch {
      reference.base64 = null;
    }
  }
  return reference;
}
