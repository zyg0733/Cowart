import assert from "node:assert/strict";
import test from "node:test";

import {
  PNG_1X1,
  call,
  confirmSegment,
  getCanvas,
  imageBytes,
  localImageSnapshot,
  putSnapshot,
  rgbaPng,
  rpc,
  sha256,
  structured,
  withViteHarness,
  writeLocalSource,
} from "./object-aware-mcp-harness.mjs";

test("Given caller-forged object edit source fields When writeback succeeds Then protected provenance comes from the validated source", async () => {
  await withViteHarness(async (ctx) => {
    await writeLocalSource(ctx);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot());
    const segment = await confirmSegment(ctx);
    const [maskResponse] = await rpc([call(99, "make_cowart_mask", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, segmentId: segment.segmentId })], ctx);
    const segmentMask = structured(maskResponse);
    const [inserted] = await rpc([
      call(1, "insert_cowart_image", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        imageBase64: PNG_1X1,
        fileName: "forged-provenance.png",
        anchorShapeId: "shape:image",
        expectedSourceAssetHash: sha256(imageBytes()),
        objectEdit: {
          segmentId: segment.segmentId,
          parentSegmentId: "segment:caller-parent",
          sourceShapeId: "shape:wrong",
          sourceAssetId: "asset:wrong",
          sourceSha256: "0".repeat(64),
          sourceAssetSha256: "f".repeat(64),
          selectionMaskSha256: "2".repeat(64),
          editMaskSha256: segmentMask.editMaskSha256,
          operation: "modify",
          prompt: "caller descriptive prompt",
          provider: "caller-provider",
          model: "caller-model",
        },
      }),
    ], ctx);
    const insertedResult = structured(inserted);
    const shape = (await getCanvas(ctx.cowartUrl)).snapshot.store[insertedResult.shapeId];
    assert.equal(shape.meta.cowartObjectEdit.sourceShapeId, "shape:image");
    assert.equal(shape.meta.cowartObjectEdit.sourceAssetId, "asset:image");
    assert.equal(shape.meta.cowartObjectEdit.sourceSha256, sha256(imageBytes()));
    assert.equal(shape.meta.cowartObjectEdit.selectionMaskSha256, segment.mask.sha256);
    assert.equal(shape.meta.cowartObjectEdit.editMaskSha256, segmentMask.editMaskSha256);
    assert.equal(JSON.stringify(shape.meta.cowartObjectEdit).includes("asset:wrong"), false);
    assert.equal(JSON.stringify(shape.meta.cowartObjectEdit).includes("shape:wrong"), false);
    assert.equal(shape.meta.cowartObjectEdit.prompt, "caller descriptive prompt");
    assert.equal(shape.meta.cowartObjectEdit.provider, "caller-provider");
    assert.equal(shape.meta.cowartObjectEdit.model, "caller-model");
  });
});

test("Given caller-forged object edit mask hashes When writeback runs Then editMaskSha256 is protected by the segment mask", async () => {
  await withViteHarness(async (ctx) => {
    const sourceBytes = rgbaPng(2, 1);
    await writeLocalSource(ctx, sourceBytes);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot(sourceBytes, 2, 1));
    const segment = await confirmSegment(ctx, { bytes: sourceBytes, width: 2, height: 1, pixels: Uint8Array.from([0, 255]) });
    const [maskResponse] = await rpc([call(1, "make_cowart_mask", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, segmentId: segment.segmentId })], ctx);
    const realMask = structured(maskResponse);
    assert.equal(realMask.editMaskSha256.length, 64);
    assert.equal(JSON.stringify(realMask).includes(ctx.canvasDir), false);
    const forgedHash = "3".repeat(64);
    assert.notEqual(forgedHash, realMask.editMaskSha256);
    const responses = await rpc([
      call(1, "insert_cowart_image", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, imageBase64: PNG_1X1, fileName: "forged-mask.png", anchorShapeId: "shape:image", expectedSourceAssetHash: sha256(sourceBytes), objectEdit: { segmentId: segment.segmentId, editMaskSha256: forgedHash, operation: "modify" } }),
      call(2, "insert_cowart_image", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, imageBase64: PNG_1X1, fileName: "matching-mask.png", anchorShapeId: "shape:image", expectedSourceAssetHash: sha256(sourceBytes), objectEdit: { segmentId: segment.segmentId, editMaskSha256: realMask.editMaskSha256, operation: "modify" } }),
      call(3, "insert_cowart_image", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, imageBase64: PNG_1X1, fileName: "no-segment-mask.png", anchorShapeId: "shape:image", objectEdit: { editMaskSha256: forgedHash, operation: "modify" } }),
    ], ctx);
    assert.equal(responses[0].error.data.code, "object_edit_mask_mismatch");
    assert.equal(JSON.stringify(responses[0]).includes(forgedHash), false);
    const matchingResult = structured(responses[1]);
    const noSegmentResult = structured(responses[2]);
    const snapshot = (await getCanvas(ctx.cowartUrl)).snapshot;
    const matchingShape = snapshot.store[matchingResult.shapeId];
    const noSegmentShape = snapshot.store[noSegmentResult.shapeId];
    assert.equal(matchingShape.meta.cowartObjectEdit.editMaskSha256, realMask.editMaskSha256);
    assert.equal("editMaskSha256" in noSegmentShape.meta.cowartObjectEdit, false);
    assert.equal(JSON.stringify(noSegmentShape.meta.cowartObjectEdit).includes(forgedHash), false);
  });
});
