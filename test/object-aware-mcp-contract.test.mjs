import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  PNG_1X1,
  call,
  confirmSegment,
  imageBytes,
  imageSnapshot,
  localImageSnapshot,
  putSnapshot,
  rgbaPng,
  rpc,
  sha256,
  structured,
  withViteHarness,
  writeLocalSource,
  writeSelection,
} from "./object-aware-mcp-harness.mjs";

test("Given the current MCP server When tools are listed Then legacy tools and object-action tools remain compatible", async () => {
  await withViteHarness(async (ctx) => {
    const [response] = await rpc([{ jsonrpc: "2.0", id: 1, method: "tools/list" }], ctx);
    const names = response.result.tools.map((tool) => tool.name);
    const legacyNames = [
      "get_cowart_selection",
      "insert_cowart_image",
      "get_cowart_canvas",
      "get_cowart_annotations",
      "get_cowart_requests",
      "create_cowart_image_holder",
      "replace_cowart_image",
      "export_cowart_view",
      "add_cowart_shapes",
      "make_cowart_mask",
      "update_cowart_holder",
      "get_cowart_references",
    ];
    assert.deepEqual(names.filter((name) => legacyNames.includes(name)), legacyNames);
    assert.deepEqual(names.filter((name) => name.includes("segment_cowart") || name.includes("cowart_segment")), [
      "segment_cowart_image",
      "refine_cowart_segment",
    ]);
    assert.deepEqual(names.filter((name) => [
      "extract_cowart_object",
      "create_cowart_variant_grid",
      "select_cowart_variant",
      "create_cowart_decomposition",
      "publish_cowart_decomposition_artifact",
    ].includes(name)), [
      "extract_cowart_object",
      "create_cowart_variant_grid",
      "select_cowart_variant",
      "create_cowart_decomposition",
      "publish_cowart_decomposition_artifact",
    ]);
    assert.equal(names.length, 19);
    for (const tool of response.result.tools) {
      assert.equal(tool.inputSchema.type, "object", tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    }
  });
});

test("Given confirmed segments When canvas and selection are read Then summaries expose source hashes and store-backed segment summaries only", async () => {
  await withViteHarness(async (ctx) => {
    await writeLocalSource(ctx);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot());
    await writeSelection(ctx);
    await confirmSegment(ctx);
    const responses = await rpc([
      call(1, "get_cowart_canvas", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir }),
      call(2, "get_cowart_selection", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir }),
    ], ctx);
    const canvasShape = structured(responses[0]).pages[0].shapes.find((shape) => shape.id === "shape:image");
    const selectionShape = structured(responses[1]).selection.selectedShapes[0];
    for (const shape of [canvasShape, selectionShape]) {
      assert.equal(shape.asset.sourceSha256, sha256(imageBytes()));
      assert.deepEqual(shape.confirmedSegments.map((segment) => segment.segmentId), ["segment:confirmed"]);
      assert.equal(shape.confirmedSegments[0].mask.sha256.length, 64);
      assert.equal(shape.confirmedSegments[0].parentSegmentId, null);
    }
    const payload = JSON.stringify({ canvasShape, selectionShape, selectionFile: structured(responses[1]).selectionFile });
    assert.equal(payload.includes(ctx.canvasDir), false);
    assert.equal(payload.includes("candidate-meta"), false);
    assert.equal(payload.includes("candidate-shape"), false);
  });
});

test("Given no configured server segmentation provider When segment_cowart_image is called Then it honestly requires browser interaction", async () => {
  await withViteHarness(async (ctx) => {
    await writeLocalSource(ctx);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot());
    const [response] = await rpc([
      call(1, "segment_cowart_image", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        targetShapeId: "shape:image",
        mode: "point",
        points: [{ x: 10, y: 10, label: "positive" }],
      }),
    ], ctx);
    const result = structured(response);
    assert.equal(result.status, "browser_interaction_required");
    assert.equal(result.code, "browser_interaction_required");
    assert.match(result.instructions, /canvas object/i);
    assert.equal("segmentId" in result, false);
  });
});

test("Given confirmed segments When source ancestry or bytes no longer match Then MCP summaries do not advertise them as confirmed", async () => {
  await withViteHarness(async (ctx) => {
    const sourceBytes = imageBytes();
    await writeLocalSource(ctx, sourceBytes);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot(sourceBytes));
    await writeSelection(ctx);
    await confirmSegment(ctx, { bytes: sourceBytes });
    const canvasResponse = async () => {
      const [response] = await rpc([call(1, "get_cowart_canvas", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, allPages: true })], ctx);
      return structured(response).pages.flatMap((pageResult) => pageResult.shapes).find((shape) => shape.id === "shape:image");
    };
    const selectionResponse = async () => {
      const [response] = await rpc([call(1, "get_cowart_selection", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir })], ctx);
      return structured(response).selection.selectedShapes[0];
    };
    assert.deepEqual((await canvasResponse()).confirmedSegments.map((segment) => segment.segmentId), ["segment:confirmed"]);
    const moved = localImageSnapshot(sourceBytes);
    moved.store["shape:image"].parentId = "page:two";
    await putSnapshot(ctx.cowartUrl, moved);
    assert.deepEqual((await canvasResponse()).confirmedSegments, []);
    const missingAncestor = localImageSnapshot(sourceBytes);
    missingAncestor.store["shape:image"].parentId = "shape:missing-parent";
    await putSnapshot(ctx.cowartUrl, missingAncestor);
    assert.deepEqual((await selectionResponse()).confirmedSegments ?? [], []);
    const cycled = localImageSnapshot(sourceBytes);
    cycled.store["shape:cycle"] = { ...cycled.store["shape:image"], id: "shape:cycle", parentId: "shape:image", props: { w: 1, h: 1 } };
    cycled.store["shape:image"].parentId = "shape:cycle";
    await putSnapshot(ctx.cowartUrl, cycled);
    assert.deepEqual((await selectionResponse()).confirmedSegments ?? [], []);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot(sourceBytes));
    await writeLocalSource(ctx, rgbaPng(1, 1, [0, 0, 255, 255]));
    assert.deepEqual((await canvasResponse()).confirmedSegments, []);
    const replacedAsset = localImageSnapshot(sourceBytes);
    replacedAsset.store["asset:other"] = {
      ...replacedAsset.store["asset:image"],
      id: "asset:other",
      props: { ...replacedAsset.store["asset:image"].props, name: "other.png", src: "/page-assets/one/other.png" },
      meta: { cowartSha256: sha256(sourceBytes) },
    };
    replacedAsset.store["shape:image"].props.assetId = "asset:other";
    await writeFile(join(ctx.canvasDir, "pages", "one", "assets", "other.png"), sourceBytes);
    await putSnapshot(ctx.cowartUrl, replacedAsset);
    assert.deepEqual((await canvasResponse()).confirmedSegments, []);
  });
});

test("Given the existing rectangle mask path When make_cowart_mask runs Then page coordinates still map to the expected pixel region", async () => {
  await withViteHarness(async (ctx) => {
    await putSnapshot(ctx.cowartUrl, imageSnapshot());
    const [response] = await rpc([
      call(1, "make_cowart_mask", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        targetShapeId: "shape:image",
        region: { x: 10, y: 20, w: 10, h: 10 },
        returnBase64: true,
      }),
    ], ctx);
    const result = structured(response);
    assert.equal(result.targetShapeId, "shape:image");
    assert.deepEqual(result.naturalSize, { width: 1, height: 1 });
    assert.deepEqual(result.pixelRegion, { x: 0, y: 0, w: 1, h: 1 });
    assert.equal(result.maskBase64.length > 0, true);
    assert.equal(result.sourceImageBase64, imageBytes().toString("base64"));
    assert.equal(JSON.stringify(result).includes(ctx.canvasDir), false);
    assert.equal(sha256(await readFile(join(ctx.canvasDir, result.maskFile))).length, 64);
    assert.equal(result.sourceImageFile, "pages/one/assets/asset-image.png");
  });
});

test("Given a transformed cropped and flipped image When rectangle selectors are materialized Then MCP maps page geometry through source pixels", async () => {
  await withViteHarness(async (ctx) => {
    const sourceBytes = rgbaPng(8, 6);
    const transformed = localImageSnapshot(sourceBytes, 8, 6);
    const diagonal = Math.SQRT1_2;
    const imageOrigin = { x: 100 - 10 * diagonal, y: 50 + 30 * diagonal };
    transformed.store["shape:frame"] = {
      id: "shape:frame",
      typeName: "shape",
      type: "frame",
      parentId: "page:one",
      x: 100,
      y: 50,
      rotation: Math.PI / 4,
      index: "a1",
      meta: {},
      props: { w: 100, h: 100 },
    };
    transformed.store["shape:image"] = {
      ...transformed.store["shape:image"],
      parentId: "shape:frame",
      x: 10,
      y: 20,
      rotation: Math.PI / 4,
      props: {
        ...transformed.store["shape:image"].props,
        w: 4,
        h: 2,
        crop: {
          topLeft: { x: 0.25, y: 1 / 6 },
          bottomRight: { x: 0.75, y: 5 / 6 },
        },
        flipX: true,
        flipY: true,
      },
    };
    transformed.store["shape:region"] = {
      id: "shape:region",
      typeName: "shape",
      type: "geo",
      parentId: "shape:frame",
      x: 10 + 0.5 * diagonal,
      y: 20 + 1.5 * diagonal,
      rotation: Math.PI / 4,
      index: "a2",
      meta: {},
      props: { w: 2, h: 1, geo: "rectangle" },
    };

    await writeLocalSource(ctx, sourceBytes);
    await putSnapshot(ctx.cowartUrl, transformed);
    const responses = await rpc([
      call(1, "make_cowart_mask", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        targetShapeId: "shape:image",
        region: { x: imageOrigin.x - 1.5, y: imageOrigin.y + 1, w: 1, h: 2 },
        maskFileName: "transformed-region.png",
      }),
      call(2, "make_cowart_mask", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        targetShapeId: "shape:image",
        regionShapeId: "shape:region",
        maskFileName: "transformed-region-shape.png",
      }),
    ], ctx);

    for (const response of responses) {
      assert.equal(response.error, undefined, JSON.stringify(response));
      const result = structured(response);
      const expectedBounds = { x: imageOrigin.x - 2, y: imageOrigin.y, w: 2, h: 4 };
      for (const key of ["x", "y", "w", "h"]) {
        assert.ok(Math.abs(result.imageBounds[key] - expectedBounds[key]) < 1e-9, `${key}: ${result.imageBounds[key]}`);
      }
      assert.deepEqual(result.pixelRegion, { x: 3, y: 2, w: 2, h: 2 });
    }
  });
});
