import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { decodeRgbaForTest } from "../mcp/image-composite.mjs";
import {
  call,
  confirmSegment,
  getCanvas,
  localImageSnapshot,
  putSnapshot,
  rgbaPng,
  rpc,
  sha256,
  structured,
  withViteHarness,
  writeLocalSource,
} from "./object-aware-mcp-harness.mjs";

async function assetBytesForShape(ctx, shapeId) {
  const canvas = await getCanvas(ctx.cowartUrl);
  const shape = canvas.snapshot.store[shapeId];
  const asset = canvas.snapshot.store[shape.props.assetId];
  return readFile(join(ctx.canvasDir, "pages", "one", "assets", asset.props.name));
}

test("Given a confirmed object When protected replacement and extraction run Then outside pixels and source provenance remain deterministic", async () => {
  await withViteHarness(async (ctx) => {
    const sourceBytes = rgbaPng(2, 1, [255, 0, 0, 255]);
    const candidateBytes = rgbaPng(2, 1, [0, 0, 255, 255]);
    await writeLocalSource(ctx, sourceBytes);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot(sourceBytes, 2, 1));
    const segment = await confirmSegment(ctx, {
      bytes: sourceBytes,
      width: 2,
      height: 1,
      pixels: Uint8Array.from([0, 255]),
    });

    const [extractedResponse] = await rpc([
      call(1, "extract_cowart_object", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        segmentId: segment.segmentId,
      }),
    ], ctx);
    const extracted = structured(extractedResponse);
    assert.equal(extracted.synthetic, false);
    assert.deepEqual(extracted.extraction.naturalSize, { width: 1, height: 1 });
    const extractedPixels = await decodeRgbaForTest(await assetBytesForShape(ctx, extracted.shapeId));
    assert.deepEqual([...extractedPixels.data], [255, 0, 0, 255]);

    const [replacedResponse] = await rpc([
      call(2, "replace_cowart_image", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        targetShapeId: "shape:image",
        imageBase64: candidateBytes.toString("base64"),
        fileName: "protected.png",
        preserveOutside: true,
        objectEdit: { segmentId: segment.segmentId, operation: "modify" },
      }),
    ], ctx);
    const replaced = structured(replacedResponse);
    assert.equal(replaced.preserveOutside.segmentId, segment.segmentId);
    const decoded = await decodeRgbaForTest(await assetBytesForShape(ctx, "shape:image"));
    assert.deepEqual([...decoded.data], [255, 0, 0, 255, 0, 0, 255, 255]);
    const shape = (await getCanvas(ctx.cowartUrl)).snapshot.store["shape:image"];
    assert.equal(shape.meta.cowartObjectEdit.sourceSha256, sha256(sourceBytes));
    assert.equal(shape.meta.cowartObjectEdit.segmentId, segment.segmentId);
  });
});

test("Given a confirmed object When an object-action holder is created Then the queued request uses trusted source metadata", async () => {
  await withViteHarness(async (ctx) => {
    const sourceBytes = rgbaPng(2, 1, [255, 0, 0, 255]);
    await writeLocalSource(ctx, sourceBytes);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot(sourceBytes, 2, 1));
    const segment = await confirmSegment(ctx, {
      bytes: sourceBytes,
      width: 2,
      height: 1,
      pixels: Uint8Array.from([255, 0]),
    });
    const [createdResponse] = await rpc([
      call(1, "create_cowart_image_holder", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        prompt: "replace the cup",
        objectAction: {
          operation: "replace",
          segmentId: segment.segmentId,
          prompt: "replace the cup",
          sourceSha256: "0".repeat(64),
        },
      }),
    ], ctx);
    const [requestsResponse] = await rpc([
      call(2, "get_cowart_requests", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
      }),
    ], ctx);
    const created = structured(createdResponse);
    assert.equal(created.status, "requested");
    assert.equal(created.request.kind, "object_action");
    assert.equal(created.objectAction.sourceSha256, sha256(sourceBytes));
    const requests = structured(requestsResponse).requests;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].kind, "object_action");
    assert.equal(requests[0].objectAction.segmentId, segment.segmentId);
    assert.equal(requests[0].objectAction.sourceSha256, sha256(sourceBytes));
  });
});

test("Given a confirmed object When a Variant Grid is created filled and selected Then queue and winner updates are atomic", async () => {
  await withViteHarness(async (ctx) => {
    const sourceBytes = rgbaPng(2, 1, [255, 0, 0, 255]);
    const candidateBytes = rgbaPng(2, 1, [0, 255, 0, 255]);
    await writeLocalSource(ctx, sourceBytes);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot(sourceBytes, 2, 1));
    const segment = await confirmSegment(ctx, {
      bytes: sourceBytes,
      width: 2,
      height: 1,
      pixels: Uint8Array.from([255, 0]),
    });
    const [gridResponse] = await rpc([
      call(1, "create_cowart_variant_grid", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        gridId: "variant-grid:test",
        segmentId: segment.segmentId,
        operation: "replace",
        prompt: "four distinct green treatments",
      }),
    ], ctx);
    const grid = structured(gridResponse);
    assert.equal(grid.count, 4);
    assert.equal(grid.holderIds.length, 4);
    assert.equal(new Set(grid.requests.map((request) => request.id)).size, 4);

    const [requestsResponse] = await rpc([
      call(2, "get_cowart_requests", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
      }),
    ], ctx);
    const queued = structured(requestsResponse).requests;
    assert.deepEqual(queued.map((request) => request.holderId), grid.holderIds);
    assert.ok(queued.every((request) => request.kind === "variant"));
    const retryTarget = queued[0];
    const [retriedResponse] = await rpc([
      call(21, "update_cowart_holder", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        holderId: retryTarget.holderId,
        status: "requested",
        expectedRequestId: retryTarget.requestId,
      }),
    ], ctx);
    const retried = structured(retriedResponse);
    assert.equal(retried.request.kind, "variant");
    assert.equal(retried.request.variant.gridId, grid.gridId);
    assert.equal(retried.request.attempt, 2);

    const winnerHolderId = grid.holderIds[2];
    const winnerRequest = queued.find((request) => request.holderId === winnerHolderId);
    const [fillResponse] = await rpc([
      call(3, "replace_cowart_image", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        targetShapeId: winnerHolderId,
        expectedRequestId: winnerRequest.requestId,
        imageBase64: candidateBytes.toString("base64"),
        fileName: "winner.png",
        preserveOutside: { segmentId: segment.segmentId },
        objectEdit: { segmentId: segment.segmentId, operation: "replace" },
      }),
    ], ctx);
    assert.equal(structured(fillResponse).shapeId, winnerHolderId);

    const [winnerResponse] = await rpc([
      call(4, "select_cowart_variant", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        gridId: grid.gridId,
        winnerHolderId,
      }),
    ], ctx);
    const selected = structured(winnerResponse);
    assert.equal(selected.winnerHolderId, winnerHolderId);
    assert.equal(selected.memberHolderIds.length, 4);

    const canvas = (await getCanvas(ctx.cowartUrl)).snapshot;
    for (const holderId of grid.holderIds) {
      const meta = canvas.store[holderId].meta;
      assert.equal(meta.cowartVariantGroup.winnerHolderId, winnerHolderId);
      assert.equal(meta.cowartVariant.isWinner, holderId === winnerHolderId);
    }
    assert.equal(canvas.store["shape:image"].meta.cowartVariantWinners[grid.gridId].holderId, winnerHolderId);
    assert.equal(grid.holderIds.filter((holderId) => canvas.store[holderId].props.status === "requested").length, 3);

    const beforeRevision = (await getCanvas(ctx.cowartUrl)).revision;
    const [duplicateResponse] = await rpc([
      call(5, "create_cowart_variant_grid", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        gridId: grid.gridId,
        segmentId: segment.segmentId,
        prompt: "duplicate",
      }),
    ], ctx);
    assert.equal(duplicateResponse.error.data.code, "variant_grid_conflict");
    assert.equal((await getCanvas(ctx.cowartUrl)).revision, beforeRevision);
  });
});

test("Given invalid Variant Grid counts or duplicate request ids When creation runs Then it rejects before canvas mutation", async () => {
  await withViteHarness(async (ctx) => {
    const sourceBytes = rgbaPng(2, 1, [255, 0, 0, 255]);
    await writeLocalSource(ctx, sourceBytes);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot(sourceBytes, 2, 1));
    const segment = await confirmSegment(ctx, {
      bytes: sourceBytes,
      width: 2,
      height: 1,
      pixels: Uint8Array.from([255, 0]),
    });
    const beforeRevision = (await getCanvas(ctx.cowartUrl)).revision;
    const responses = await rpc([
      call(1, "create_cowart_variant_grid", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        segmentId: segment.segmentId,
        prompt: "bad count",
        count: 4.5,
      }),
      call(2, "create_cowart_variant_grid", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        segmentId: segment.segmentId,
        prompt: "duplicate ids",
        requestIds: ["request:same", "request:same"],
      }),
    ], ctx);
    assert.equal(responses[0].error.data.code, "invalid_variant_count");
    assert.equal(responses[1].error.data.code, "duplicate_variant_request_id");
    assert.equal((await getCanvas(ctx.cowartUrl)).revision, beforeRevision);
  });
});
