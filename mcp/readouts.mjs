import { COWART_AI_IMAGE_SHAPE, AI_IMAGE_HOLDER_STATUSES } from "./constants.mjs";
import { codedError } from "./object-aware-errors.mjs";
import { confirmedSegmentsBySource, confirmedSegmentsForShape, publicShapeMeta } from "./object-aware-deps.mjs";
import { loadCanvasSnapshot, readSelectionState, readViewState } from "./canvas-client.mjs";
import { getPageShapes, nearestGenSize, pageBoundsForShape } from "./geometry.mjs";
import { currentHolderRequest } from "./request-lifecycle.mjs";
import { buildLineageTimeline } from "./lineage-timeline.mjs";
import { finiteNumber, nonEmptyString } from "./paths.mjs";

export function plainTextFromRichText(richText) {
  if (!richText || typeof richText !== "object") return typeof richText === "string" ? richText.trim() : "";
  const collect = (node) => {
    if (!node) return "";
    if (typeof node.text === "string") return node.text;
    if (Array.isArray(node.content)) return node.content.map(collect).join("");
    return "";
  };
  const blocks = Array.isArray(richText.content) ? richText.content : [richText];
  return blocks.map(collect).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function shapeTextContent(shape) {
  return plainTextFromRichText(shape?.props?.richText) || nonEmptyString(shape?.props?.text) || null;
}

function pageOffsetForShape(store, shape) {
  let x = finiteNumber(shape.x, 0);
  let y = finiteNumber(shape.y, 0);
  let parent = store[shape.parentId];
  const visited = new Set([shape.id]);
  while (parent?.typeName === "shape" && !visited.has(parent.id)) {
    visited.add(parent.id);
    x += finiteNumber(parent.x, 0);
    y += finiteNumber(parent.y, 0);
    parent = store[parent.parentId];
  }
  return { x, y };
}

function isAnnotationArrow(shape) {
  return shape?.typeName === "shape" && shape.type === "arrow" && shape.meta?.cowartAnnotationArrow === true;
}

function assetSummary(store, shape) {
  const asset = shape?.props?.assetId ? store[shape.props.assetId] : null;
  if (!asset) return null;
  return {
    id: asset.id, name: asset.props?.name ?? null, src: asset.props?.src ?? null, w: asset.props?.w ?? null, h: asset.props?.h ?? null,
    mimeType: asset.props?.mimeType ?? null, sourceSha256: nonEmptyString(asset.meta?.cowartSha256) ?? null,
  };
}

export function describeShape(store, shape, segmentMap = new Map()) {
  const bounds = pageBoundsForShape(store, shape);
  const descriptor = {
    id: shape.id, type: shape.type, parentId: shape.parentId, bounds, rotation: finiteNumber(shape.rotation, 0),
    text: shapeTextContent(shape), isAiImageHolder: shape.meta?.cowartAiImageHolder === true, isAnnotation: isAnnotationArrow(shape),
    asset: assetSummary(store, shape), confirmedSegments: confirmedSegmentsForShape(segmentMap, shape, nonEmptyString),
    suggestedGenSize: nearestGenSize(shape.props?.w ?? bounds?.w, shape.props?.h ?? bounds?.h), meta: publicShapeMeta(shape.meta),
  };
  if (shape.type === COWART_AI_IMAGE_SHAPE) {
    descriptor.holder = {
      status: nonEmptyString(shape.props?.status) ?? null,
      prompt: typeof shape.props?.prompt === "string" ? shape.props.prompt : null,
    };
  }
  return descriptor;
}

export function resolveTargetPages(store, args, viewState) {
  const pages = Object.values(store).filter((record) => record?.typeName === "page").sort((a, b) => String(a.index ?? "").localeCompare(String(b.index ?? "")));
  const requestedPageId = nonEmptyString(args.pageId);
  if (requestedPageId) return pages.filter((page) => page.id === requestedPageId);
  if (args.allPages === true) return pages;
  const currentPageId = nonEmptyString(viewState?.currentPageId);
  const current = pages.find((page) => page.id === currentPageId);
  return current ? [current] : pages.slice(0, 1);
}

export async function getCowartCanvas(args = {}, deps) {
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const viewState = await readViewState(args);
  const segmentMap = await confirmedSegmentsBySource(args, store, deps);
  const pages = resolveTargetPages(store, args, viewState).map((page) => ({
    pageId: page.id, name: page.name ?? null, shapes: getPageShapes(store, page.id).map((shape) => describeShape(store, shape, segmentMap)),
  }));
  return {
    cowartUrl,
    currentPageId: nonEmptyString(viewState?.currentPageId) ?? null,
    pages,
    lineageTimeline: buildLineageTimeline(store, pages),
  };
}

export function isCowartAiImageHolder(shape) {
  return shape?.typeName === "shape" && shape.type === COWART_AI_IMAGE_SHAPE;
}

function normalizeRequestStatuses(args) {
  const values = Array.isArray(args.statuses) ? args.statuses : nonEmptyString(args.status) ? [args.status] : ["requested"];
  if (values.length === 0) return new Set(["requested"]);
  for (const status of values) {
    if (typeof status !== "string" || !AI_IMAGE_HOLDER_STATUSES.includes(status)) {
      codedError("invalid_request_status", `Invalid request status "${String(status)}". Use one of: ${AI_IMAGE_HOLDER_STATUSES.join(", ")}.`, 400, { status: String(status), allowed: AI_IMAGE_HOLDER_STATUSES });
    }
  }
  return new Set(values);
}

function requestSortTime(request) {
  const time = Date.parse(request?.requestedAt ?? "");
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

export async function getCowartRequests(args = {}) {
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const viewState = await readViewState(args);
  const statuses = normalizeRequestStatuses(args);
  const requests = [];
  const pages = resolveTargetPages(store, args, viewState);
  pages.forEach((page, pageOrder) => {
    getPageShapes(store, page.id).forEach((shape, shapeOrder) => {
      if (!isCowartAiImageHolder(shape)) return;
      const status = nonEmptyString(shape.props?.status) || "empty";
      if (!statuses.has(status)) return;
      const request = currentHolderRequest(shape);
      requests.push({
        holderId: shape.id, pageId: page.id, status, prompt: typeof shape.props?.prompt === "string" ? shape.props.prompt : null,
        requestId: nonEmptyString(request?.id), request: request ?? null, requestedAt: nonEmptyString(request?.requestedAt),
        kind: nonEmptyString(request?.kind) || (shape.meta?.cowartVariant ? "variant" : shape.meta?.cowartObjectAction ? "object_action" : "image_generation"),
        objectAction: request?.objectAction ?? shape.meta?.cowartObjectAction ?? null,
        variant: request?.variant ?? shape.meta?.cowartVariant ?? null,
        startedAt: nonEmptyString(request?.startedAt), failedAt: nonEmptyString(request?.failedAt), attempt: finiteNumber(request?.attempt, null),
        error: request?.error ?? null, legacy: !request, suggestedGenSize: nearestGenSize(shape.props?.w, shape.props?.h), meta: shape.meta ?? {},
        _sort: { time: requestSortTime(request), pageOrder, shapeOrder, index: String(shape.index ?? "") },
      });
    });
  });
  requests.sort((a, b) => a._sort.time - b._sort.time || a._sort.pageOrder - b._sort.pageOrder || a._sort.index.localeCompare(b._sort.index) || a._sort.shapeOrder - b._sort.shapeOrder);
  for (const request of requests) delete request._sort;
  return { cowartUrl, currentPageId: nonEmptyString(viewState?.currentPageId) ?? null, requests };
}

function findAnnotationTarget(store, pageShapes, endPoint, arrowId) {
  const candidates = pageShapes.filter((shape) => shape.id !== arrowId && shape.type !== "arrow" && !isAnnotationArrow(shape)).map((shape) => ({ shape, bounds: pageBoundsForShape(store, shape) })).filter((entry) => entry.bounds);
  const containing = candidates.filter(({ bounds }) => endPoint.x >= bounds.x && endPoint.x <= bounds.x + bounds.w && endPoint.y >= bounds.y && endPoint.y <= bounds.y + bounds.h);
  if (containing.length > 0) return containing.reduce((best, entry) => entry.bounds.w * entry.bounds.h < best.bounds.w * best.bounds.h ? entry : best).shape;
  let nearest = null;
  for (const entry of candidates) {
    const cx = entry.bounds.x + entry.bounds.w / 2;
    const cy = entry.bounds.y + entry.bounds.h / 2;
    const distance = Math.hypot(cx - endPoint.x, cy - endPoint.y);
    if (!nearest || distance < nearest.distance) nearest = { shape: entry.shape, distance };
  }
  return nearest?.shape ?? null;
}

export async function getCowartAnnotations(args = {}) {
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const viewState = await readViewState(args);
  const { selection } = args.selectedOnly === true ? await readSelectionState(args) : { selection: null };
  const selectedIds = new Set((selection?.selectedShapes ?? []).map((shape) => shape.id).filter(Boolean));
  const targetShapeId = nonEmptyString(args.targetShapeId);
  const annotationIds = Array.isArray(args.annotationIds) ? new Set(args.annotationIds.filter((id) => typeof id === "string")) : null;
  const annotations = [];
  for (const page of resolveTargetPages(store, args, viewState)) {
    const pageShapes = getPageShapes(store, page.id);
    collectPageAnnotations({ store, page, pageShapes, selectedIds, targetShapeId, annotationIds, args, annotations });
  }
  return { cowartUrl, currentPageId: nonEmptyString(viewState?.currentPageId) ?? null, annotations };
}

function collectPageAnnotations({ store, page, pageShapes, selectedIds, targetShapeId, annotationIds, args, annotations }) {
  for (const shape of pageShapes) {
    if (!isAnnotationArrow(shape)) continue;
    if (annotationIds && !annotationIds.has(shape.id)) continue;
    const offset = pageOffsetForShape(store, shape);
    const start = shape.props?.start ?? { x: 0, y: 0 };
    const end = shape.props?.end ?? { x: 0, y: 0 };
    const startPoint = { x: offset.x + finiteNumber(start.x, 0), y: offset.y + finiteNumber(start.y, 0) };
    const endPoint = { x: offset.x + finiteNumber(end.x, 0), y: offset.y + finiteNumber(end.y, 0) };
    const target = findAnnotationTarget(store, pageShapes, endPoint, shape.id);
    if (targetShapeId && target?.id !== targetShapeId) continue;
    if (args.selectedOnly === true && (selectedIds.size === 0 || (!selectedIds.has(shape.id) && !selectedIds.has(target?.id)))) continue;
    annotations.push({ id: shape.id, pageId: page.id, text: shapeTextContent(shape) ?? "", startPoint, endPoint, target: target ? { id: target.id, type: target.type, isAiImageHolder: target.meta?.cowartAiImageHolder === true, asset: assetSummary(store, target) } : null });
  }
}
