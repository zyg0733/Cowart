import { codedError } from "./object-aware-errors.mjs";
import { trustedObjectAction } from "./object-action-meta.mjs";
import { assertSourcePrecondition, sourceCondition } from "./object-aware-deps.mjs";
import { COWART_AI_IMAGE_SHAPE } from "./constants.mjs";
import { getRecord, loadCanvasSnapshot, persistRecords } from "./canvas-client.mjs";
import { chooseIndex, choosePlacement } from "./geometry.mjs";
import { makeCowartRequest } from "./request-lifecycle.mjs";
import { finiteNumber, nonEmptyString, sanitizeIdPart, uniqueRecordId } from "./paths.mjs";

function newGridId() {
  return `variant-grid:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sourceFromAction(action) {
  return {
    pageId: action.sourcePageId,
    shapeId: action.sourceShapeId,
    assetId: action.sourceAssetId,
    assetSha256: action.sourceSha256,
    width: action.sourceWidth,
    height: action.sourceHeight,
  };
}

export async function createCowartVariantGrid(args = {}, deps) {
  const count = finiteNumber(args.count, 4);
  if (!Number.isInteger(count) || count < 1 || count > 6) {
    codedError("invalid_variant_count", "Variant Grid count must be between 1 and 6.", 400, { count });
  }
  const providedRequestIds = Array.isArray(args.requestIds) ? args.requestIds.map(nonEmptyString).filter(Boolean) : [];
  if (new Set(providedRequestIds).size !== providedRequestIds.length) {
    codedError("duplicate_variant_request_id", "Variant Grid requestIds must be unique.", 400);
  }
  const action = await trustedObjectAction(args, {
    operation: nonEmptyString(args.operation) || "modify",
    segmentId: args.segmentId,
    prompt: args.prompt,
  }, deps);
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const sourceShape = getRecord(store, action.sourceShapeId, "variant source shape");
  const pageId = action.sourcePageId;
  const gridId = nonEmptyString(args.gridId) || newGridId();
  const existing = Object.values(store).filter((record) => record?.meta?.cowartVariantGroup?.id === gridId);
  if (existing.length > 0) {
    codedError("variant_grid_conflict", "Variant Grid id already exists.", 409, { gridId, holderIds: existing.map((shape) => shape.id) });
  }

  const width = Math.max(1, finiteNumber(args.width, 320));
  const height = Math.max(1, finiteNumber(args.height, 220));
  const gap = Math.max(0, finiteNumber(args.gap, 24));
  const margin = Math.max(0, finiteNumber(args.margin, 40));
  const columns = count === 1 ? 1 : 2;
  const rows = Math.ceil(count / columns);
  const gridWidth = columns * width + (columns - 1) * gap;
  const gridHeight = rows * height + (rows - 1) * gap;
  const origin = choosePlacement({
    store,
    pageId,
    parentId: pageId,
    anchorShape: sourceShape,
    width: gridWidth,
    height: gridHeight,
    margin,
    placement: ["left", "below", "right"].includes(args.placement) ? args.placement : "right",
  });
  const requestedAt = nonEmptyString(args.requestedAt) || new Date().toISOString();
  const group = {
    id: gridId,
    sourceShapeId: action.sourceShapeId,
    sourceSha256: action.sourceSha256,
    segmentId: action.segmentId,
    operation: action.operation,
    count,
    winnerHolderId: null,
    createdAt: requestedAt,
  };
  const indexStore = { ...store };
  const holders = [];
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const holderId = uniqueRecordId(indexStore, "shape", sanitizeIdPart(`variant-${index + 1}`, "variant"));
    const variant = { gridId, index, count };
    const meta = {
      cowartAiImageHolder: true,
      cowartAiImageHolderVersion: 1,
      cowartObjectAction: action,
      cowartVariant: variant,
      cowartVariantGroup: group,
    };
    meta.cowartRequest = makeCowartRequest(meta, {
      requestId: args.requestIds?.[index],
      requestedAt,
      requestKind: "variant",
      objectAction: action,
      variant,
    });
    const holder = {
      id: holderId,
      typeName: "shape",
      type: COWART_AI_IMAGE_SHAPE,
      parentId: pageId,
      index: chooseIndex(indexStore, pageId),
      x: origin.x + column * (width + gap),
      y: origin.y + row * (height + gap),
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta,
      props: {
        w: width,
        h: height,
        name: `Variant ${index + 1}`,
        prompt: action.prompt,
        status: "requested",
        assetId: null,
      },
    };
    indexStore[holderId] = holder;
    holders.push(holder);
  }
  if (!args.dryRun) {
    await persistRecords(cowartUrl, store, snapshot, {
      put: holders,
      conditions: [sourceCondition(sourceFromAction(action))],
    });
  }
  return {
    cowartUrl,
    pageId,
    gridId,
    sourceShapeId: action.sourceShapeId,
    segmentId: action.segmentId,
    count,
    holderIds: holders.map((holder) => holder.id),
    bounds: { x: origin.x, y: origin.y, w: gridWidth, h: gridHeight },
    requests: holders.map((holder) => holder.meta.cowartRequest),
    dryRun: Boolean(args.dryRun),
  };
}

export async function selectCowartVariant(args = {}, deps) {
  const winnerHolderId = nonEmptyString(args.winnerHolderId) || nonEmptyString(args.holderId);
  if (!winnerHolderId) codedError("missing_winner_holder", "winnerHolderId is required.", 400);
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const winner = getRecord(store, winnerHolderId, "variant winner holder");
  const gridId = nonEmptyString(args.gridId) || nonEmptyString(winner.meta?.cowartVariantGroup?.id);
  if (!gridId || winner.meta?.cowartVariantGroup?.id !== gridId) {
    codedError("variant_grid_mismatch", "Winner holder does not belong to the requested Variant Grid.", 409, { winnerHolderId, gridId });
  }
  if (winner.type !== COWART_AI_IMAGE_SHAPE || winner.props?.status !== "filled" || !winner.props?.assetId) {
    codedError("variant_not_filled", "Winner must be a filled Variant Grid holder.", 409, { winnerHolderId });
  }
  const members = Object.values(store).filter((record) => record?.typeName === "shape" && record.meta?.cowartVariantGroup?.id === gridId);
  if (members.length === 0) codedError("variant_grid_not_found", "Variant Grid not found.", 404, { gridId });
  const group = members[0].meta.cowartVariantGroup;
  if (
    members.length !== group.count ||
    members.some((member) => (
      member.type !== COWART_AI_IMAGE_SHAPE ||
      member.meta?.cowartVariantGroup?.sourceShapeId !== group.sourceShapeId ||
      member.meta?.cowartVariantGroup?.sourceSha256 !== group.sourceSha256 ||
      member.meta?.cowartVariantGroup?.segmentId !== group.segmentId ||
      member.meta?.cowartVariantGroup?.count !== group.count
    ))
  ) {
    codedError("variant_grid_corrupt", "Variant Grid members do not share one consistent group manifest.", 409, { gridId });
  }
  const sourceShape = getRecord(store, group.sourceShapeId, "variant source shape");
  const source = await assertSourcePrecondition(store, args, sourceShape, group.sourceSha256, deps);
  const previousWinnerHolderId = group.winnerHolderId ?? null;
  const selectedAt = previousWinnerHolderId === winnerHolderId && group.selectedAt
    ? group.selectedAt
    : nonEmptyString(args.selectedAt) || new Date().toISOString();
  const sharedGroup = { ...group, winnerHolderId, selectedAt };
  const updatedMembers = members.map((member) => ({
    ...member,
    meta: {
      ...member.meta,
      cowartVariantGroup: sharedGroup,
      cowartVariant: { ...member.meta.cowartVariant, isWinner: member.id === winnerHolderId },
    },
  }));
  const sourceMeta = { ...(sourceShape.meta ?? {}) };
  sourceMeta.cowartVariantWinners = {
    ...(sourceMeta.cowartVariantWinners && typeof sourceMeta.cowartVariantWinners === "object" ? sourceMeta.cowartVariantWinners : {}),
    [gridId]: { holderId: winnerHolderId, selectedAt },
  };
  const updatedSource = { ...sourceShape, meta: sourceMeta };
  if (!args.dryRun) {
    await persistRecords(cowartUrl, store, snapshot, {
      put: [...updatedMembers, updatedSource],
      conditions: [sourceCondition(source)],
    });
  }
  return {
    cowartUrl,
    gridId,
    winnerHolderId,
    previousWinnerHolderId,
    memberHolderIds: members.map((member) => member.id),
    selectedAt,
    dryRun: Boolean(args.dryRun),
  };
}
