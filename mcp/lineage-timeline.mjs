import { nonEmptyString } from "./paths.mjs";

function timeValue(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function buildLineageTimeline(store, pages) {
  const pageIds = new Set(pages.map((page) => page.pageId));
  const shapes = Object.values(store).filter((record) => record?.typeName === "shape" && pageIds.has(pageForShape(store, record)));
  const events = [];
  const sourceIds = new Set();
  const seenGrids = new Set();
  const seenWinners = new Set();

  for (const shape of shapes) {
    const objectAction = shape.meta?.cowartObjectAction;
    const objectEdit = shape.meta?.cowartObjectEdit;
    const group = shape.meta?.cowartVariantGroup;
    if (nonEmptyString(objectAction?.sourceShapeId)) sourceIds.add(objectAction.sourceShapeId);
    if (nonEmptyString(objectEdit?.sourceShapeId)) sourceIds.add(objectEdit.sourceShapeId);
    if (nonEmptyString(group?.sourceShapeId)) sourceIds.add(group.sourceShapeId);

    if (objectAction) {
      events.push({
        kind: "object_action",
        shapeId: shape.id,
        sourceShapeId: objectAction.sourceShapeId ?? null,
        segmentId: objectAction.segmentId ?? null,
        operation: objectAction.operation ?? null,
        status: shape.props?.status ?? null,
        synthetic: true,
        at: shape.meta?.cowartRequest?.requestedAt ?? objectAction.requestedAt ?? null,
      });
    } else if (objectEdit) {
      events.push({
        kind: "object_result",
        shapeId: shape.id,
        sourceShapeId: objectEdit.sourceShapeId ?? null,
        segmentId: objectEdit.segmentId ?? null,
        operation: objectEdit.operation ?? null,
        synthetic: objectEdit.operation !== "extract",
        at: objectEdit.timestamp ?? null,
      });
    }

    if (group?.id && !seenGrids.has(group.id)) {
      seenGrids.add(group.id);
      events.push({
        kind: "variant_grid",
        gridId: group.id,
        sourceShapeId: group.sourceShapeId ?? null,
        segmentId: group.segmentId ?? null,
        operation: group.operation ?? null,
        count: group.count ?? null,
        holderIds: shapes.filter((candidate) => candidate.meta?.cowartVariantGroup?.id === group.id).map((candidate) => candidate.id),
        at: group.createdAt ?? null,
      });
    }
    if (group?.winnerHolderId && !seenWinners.has(group.id)) {
      seenWinners.add(group.id);
      events.push({
        kind: "variant_winner",
        gridId: group.id,
        sourceShapeId: group.sourceShapeId ?? null,
        winnerHolderId: group.winnerHolderId,
        at: group.selectedAt ?? null,
      });
    }
  }

  for (const shapeId of sourceIds) {
    const shape = store[shapeId];
    if (!shape) continue;
    const asset = shape.props?.assetId ? store[shape.props.assetId] : null;
    events.push({
      kind: "source",
      shapeId,
      sourceSha256: asset?.meta?.cowartSha256 ?? null,
      at: null,
    });
  }
  events.sort((left, right) => {
    if (left.kind === "source") return -1;
    if (right.kind === "source") return 1;
    return timeValue(left.at) - timeValue(right.at) || String(left.kind).localeCompare(String(right.kind));
  });
  return events;
}

function pageForShape(store, shape) {
  let current = shape;
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.typeName === "page") return current.id;
    current = store[current.parentId];
  }
  return null;
}
