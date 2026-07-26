import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PNG_1X1,
  call,
  confirmSegment,
  decodeRgbaAlpha,
  getCanvas,
  imageBytes,
  localImageSnapshot,
  pathExists,
  putSnapshot,
  rgbaPng,
  rpc,
  sha256,
  structured,
  tree,
  withViteHarness,
  writeLocalSource,
} from "./object-aware-mcp-harness.mjs";

test("Given a confirmed segment When refined and materialized as an edit mask Then the child is immutable and alpha is inverted", async () => {
  await withViteHarness(async (ctx) => {
    const sourceBytes = rgbaPng(2, 1);
    const selection = Uint8Array.from([0, 255]);
    await writeLocalSource(ctx, sourceBytes);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot(sourceBytes, 2, 1));
    const parent = await confirmSegment(ctx, { bytes: sourceBytes, width: 2, height: 1, pixels: selection });
    const [refinedResponse, maskResponse] = await rpc([
      call(1, "refine_cowart_segment", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        segmentId: parent.segmentId,
        newSegmentId: "segment:child",
        expandPixels: 0,
        contractPixels: 0,
        featherPixels: 0,
        expectedSourceAssetHash: sha256(sourceBytes),
      }),
      call(2, "make_cowart_mask", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, segmentId: parent.segmentId }),
    ], ctx);
    const refined = structured(refinedResponse);
    assert.equal(refined.segment.segmentId, "segment:child");
    assert.equal(refined.segment.parentSegmentId, parent.segmentId);
    assert.equal(refined.segment.source.assetSha256, sha256(sourceBytes));
    const mask = structured(maskResponse);
    assert.equal(mask.segmentId, parent.segmentId);
    assert.equal(mask.source.assetSha256, sha256(sourceBytes));
    assert.equal(mask.selectionMaskSha256, parent.mask.sha256);
    assert.equal(mask.editMaskSha256.length, 64);
    assert.equal(JSON.stringify(mask).includes(ctx.canvasDir), false);
    assert.deepEqual(decodeRgbaAlpha(await readFile(join(ctx.canvasDir, mask.maskFile))), { width: 2, height: 1, alpha: [255, 0] });
    assert.ok((await tree(ctx.canvasDir)).some((file) => file.endsWith("segments/segment%3Achild/manifest.json")));
  });
});

test("Given stale missing malformed segment inputs When MCP segment tools run Then structured errors are redacted and no partial artifacts remain", async () => {
  await withViteHarness(async (ctx) => {
    await writeLocalSource(ctx);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot());
    await confirmSegment(ctx);
    const beforeTree = await tree(ctx.canvasDir);
    const [malformed] = await rpc([
      call(1, "refine_cowart_segment", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, segmentId: "segment:confirmed", expandPixels: 65, newSegmentId: "segment:bad-child" }),
    ], ctx);
    assert.equal(malformed.error.data.code, "invalid_morphology_parameter");
    await writeLocalSource(ctx, rgbaPng(1, 1, [0, 0, 255, 255]));
    const responses = await rpc([
      call(1, "make_cowart_mask", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, segmentId: "segment:missing" }),
      call(2, "make_cowart_mask", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, segmentId: "segment:confirmed" }),
      call(3, "make_cowart_mask", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, region: { x: 0, y: 0, w: 1, h: 1 }, regionShapeId: "shape:image" }),
    ], ctx);
    assert.equal(responses[0].error.data.code, "segment_not_found");
    assert.equal(responses[1].error.data.code, "segment_stale");
    assert.equal(responses[2].error.data.code, "invalid_selector");
    for (const response of responses) assert.equal(JSON.stringify(response).includes(ctx.canvasDir), false);
    assert.deepEqual((await tree(ctx.canvasDir)).filter((file) => file.includes("segment%3Abad-child")), []);
    assert.deepEqual((await tree(ctx.canvasDir)).filter((file) => file.includes(".cowart-segment-staging")), []);
    assert.deepEqual(beforeTree.filter((file) => file.includes("segments")), (await tree(ctx.canvasDir)).filter((file) => file.includes("segments")));
  });
});

test("Given object-edit writeback preconditions When inserting or replacing Then stale writes clean up and provenance persists on valid writes", async () => {
  await withViteHarness(async (ctx) => {
    await writeLocalSource(ctx);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot());
    const segment = await confirmSegment(ctx);
    const [maskResponse] = await rpc([call(99, "make_cowart_mask", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, segmentId: segment.segmentId })], ctx);
    const segmentMask = structured(maskResponse);
    const before = await getCanvas(ctx.cowartUrl);
    const stale = await rpc([
      call(1, "insert_cowart_image", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, imageBase64: PNG_1X1, fileName: "stale-insert.png", anchorShapeId: "shape:image", expectedSourceAssetHash: "0".repeat(64) }),
      call(2, "replace_cowart_image", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, targetShapeId: "shape:image", imageBase64: PNG_1X1, fileName: "stale-replace.png", expectedSourceAssetHash: "0".repeat(64) }),
    ], ctx);
    assert.equal(stale[0].error.data.code, "source_asset_changed");
    assert.equal(stale[1].error.data.code, "source_asset_changed");
    assert.equal((await getCanvas(ctx.cowartUrl)).revision, before.revision);
    assert.equal((await tree(ctx.canvasDir)).some((file) => file.endsWith("stale-insert.png") || file.endsWith("stale-replace.png")), false);
    const [inserted] = await rpc([
      call(3, "insert_cowart_image", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        imageBase64: PNG_1X1,
        fileName: "object-edit-result.png",
        anchorShapeId: "shape:image",
        lineageOf: "shape:image",
        prompt: "change selected object",
        provider: "test-edit-provider",
        model: "test-edit-model",
        expectedSourceAssetHash: sha256(imageBytes()),
        objectEdit: { segmentId: segment.segmentId, parentSegmentId: segment.parentSegmentId, sourceShapeId: "shape:image", sourceAssetId: "asset:image", sourceSha256: sha256(imageBytes()), selectionMaskSha256: segment.mask.sha256, editMaskSha256: segmentMask.editMaskSha256, operation: "modify", prompt: "change selected object", provider: "test-edit-provider", model: "test-edit-model", timestamp: "2026-07-18T00:00:00.000Z" },
      }),
    ], ctx);
    const insertedResult = structured(inserted);
    const shape = (await getCanvas(ctx.cowartUrl)).snapshot.store[insertedResult.shapeId];
    assert.equal(shape.meta.cowartObjectEdit.segmentId, segment.segmentId);
    assert.equal(shape.meta.cowartObjectEdit.sourceAssetId, "asset:image");
    assert.equal(shape.meta.cowartObjectEdit.sourceSha256, sha256(imageBytes()));
    assert.equal(shape.meta.cowartObjectEdit.selectionMaskSha256, segment.mask.sha256);
    assert.equal(shape.meta.cowartObjectEdit.editMaskSha256, segmentMask.editMaskSha256);
    assert.equal(shape.meta.cowartObjectEdit.operation, "modify");
    assert.equal(shape.meta.cowartLineage.parentShapeId, "shape:image");
  });
});

test("Given symlinked page-asset destinations When insert and replace use matching fileName Then MCP rejects them without touching outside files", async () => {
  await withViteHarness(async (ctx) => {
    await writeLocalSource(ctx);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot());
    const assetsDir = join(ctx.canvasDir, "pages", "one", "assets");
    const outsideDir = await mkdtemp(join(tmpdir(), "cowart-mcp-outside-"));
    const outsideInsert = join(outsideDir, "insert-target.png");
    const outsideReplace = join(outsideDir, "replace-target.png");
    const sentinel = join(outsideDir, "sentinel.txt");
    await writeFile(sentinel, "outside bytes must not change");
    const sentinelHash = sha256(await readFile(sentinel));
    await symlink(outsideInsert, join(assetsDir, "escape-insert.png"));
    await symlink(outsideReplace, join(assetsDir, "escape-replace.png"));
    try {
      const responses = await rpc([
        call(1, "insert_cowart_image", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, imageBase64: PNG_1X1, fileName: "escape-insert.png", anchorShapeId: "shape:image" }),
        call(2, "replace_cowart_image", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, targetShapeId: "shape:image", imageBase64: PNG_1X1, fileName: "escape-replace.png" }),
      ], ctx);
      for (const response of responses) {
        assert.equal(response.error.data.code, "asset_path_symlink");
        assert.equal(JSON.stringify(response).includes(outsideDir), false);
      }
      assert.equal(await pathExists(outsideInsert), false);
      assert.equal(await pathExists(outsideReplace), false);
      assert.equal(sha256(await readFile(sentinel)), sentinelHash);
      assert.deepEqual((await tree(assetsDir)).filter((file) => file.includes(".cowart-tmp")), []);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("Given a malicious page id When MCP inserts or replaces an image Then it rejects before writing outside per-page storage", async () => {
  await withViteHarness(async (ctx) => {
    const malicious = localImageSnapshot();
    malicious.store["page:.."] = { ...malicious.store["page:one"], id: "page:.." };
    delete malicious.store["page:one"];
    malicious.store["shape:image"].parentId = "page:..";
    await writeFile(join(ctx.canvasDir, "cowart-canvas.json"), `${JSON.stringify(malicious, null, 2)}\n`);

    const responses = await rpc([
      call(1, "insert_cowart_image", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        imageBase64: PNG_1X1,
        fileName: "malicious-insert.png",
        anchorShapeId: "shape:image",
      }),
      call(2, "replace_cowart_image", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        targetShapeId: "shape:image",
        imageBase64: PNG_1X1,
        fileName: "malicious-replace.png",
      }),
    ], ctx);

    for (const response of responses) {
      assert.ok(response.error, `Expected invalid_page_id, received ${JSON.stringify(response)}`);
      assert.equal(response.error.data.code, "invalid_page_id");
      assert.equal(JSON.stringify(response).includes(ctx.canvasDir), false);
    }
    assert.equal(await pathExists(join(ctx.canvasDir, "assets")), false);
  });
});

test("Given a confirmed segment whose source asset file is a symlink When segment MCP tools read source bytes Then they reject without returning unsafe base64", async () => {
  await withViteHarness(async (ctx) => {
    const sourceBytes = rgbaPng(2, 1);
    const outsideDir = await mkdtemp(join(tmpdir(), "cowart-mcp-source-"));
    const outsideSource = join(outsideDir, "source.png");
    try {
      await writeLocalSource(ctx, sourceBytes);
      await putSnapshot(ctx.cowartUrl, localImageSnapshot(sourceBytes, 2, 1));
      const segment = await confirmSegment(ctx, { bytes: sourceBytes, width: 2, height: 1, pixels: Uint8Array.from([255, 0]) });
      await writeFile(outsideSource, sourceBytes);
      await rm(join(ctx.canvasDir, "pages", "one", "assets", "source.png"));
      await symlink(outsideSource, join(ctx.canvasDir, "pages", "one", "assets", "source.png"));
      const responses = await rpc([
        call(1, "make_cowart_mask", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, segmentId: segment.segmentId, returnBase64: true }),
        call(2, "refine_cowart_segment", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, segmentId: segment.segmentId, newSegmentId: "segment:unsafe-child" }),
      ], ctx);
      for (const response of responses) {
        assert.equal(response.error.data.code, "asset_path_symlink");
        assert.equal(JSON.stringify(response).includes(outsideDir), false);
        assert.equal(JSON.stringify(response).includes(sourceBytes.toString("base64")), false);
      }
      assert.deepEqual((await tree(ctx.canvasDir)).filter((file) => file.includes("segment%3Aunsafe-child")), []);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
