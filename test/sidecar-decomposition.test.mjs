import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

import {
  call,
  confirmSegment,
  getCanvas,
  localImageSnapshot,
  maskPng,
  putSnapshot,
  rgbaPng,
  rpc,
  sha256,
  structured,
  tree,
  withViteHarness,
  writeLocalSource,
} from "./object-aware-mcp-harness.mjs";
import { callSegmentationSidecar } from "../mcp/sidecar-client.mjs";

async function withFakeSidecar(ctx, { width = 2, height = 1, onRequest } = {}, fn) {
  const token = "sidecar-test-token-abcdefghijklmnopqrstuvwxyz-123456";
  const tokenFile = `${ctx.canvasDir}/sidecar-token`;
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ authorization: request.headers.authorization, body });
    await onRequest?.({ request, body });
    const mask = maskPng(width, height, Uint8Array.from(width === 2 && height === 1 ? [255, 0] : new Array(width * height).fill(255)));
    response.statusCode = request.headers.authorization === `Bearer ${token}` ? 200 : 401;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      naturalSize: { width, height },
      provider: { id: "forged-provider", model: "sam2.1-hiera-tiny", version: "0.7.0", device: "cpu" },
      candidates: [
        { candidateId: "candidate:1", score: 0.91, label: body.prompt ?? null, bbox: { x: 0, y: 0, w: 1, h: 1 }, area: 1, maskBase64: mask.toString("base64") },
      ],
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const sidecarUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ sidecarUrl, tokenFile, requests });
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("Given a loopback Sidecar When MCP requests candidates Then only explicit publish writes immutable Segment Store", async () => {
  await withViteHarness(async (ctx) => {
    const sourceBytes = rgbaPng(2, 1, [255, 0, 0, 255]);
    await writeLocalSource(ctx, sourceBytes);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot(sourceBytes, 2, 1));
    await withFakeSidecar(ctx, {}, async ({ sidecarUrl, tokenFile, requests }) => {
      const [candidateResponse] = await rpc([
        call(1, "segment_cowart_image", {
          cowartUrl: ctx.cowartUrl,
          canvasDir: ctx.canvasDir,
          targetShapeId: "shape:image",
          mode: "text",
          prompt: "red object",
          sidecarUrl,
          sidecarTokenFile: tokenFile,
          returnBase64: true,
        }),
      ], ctx);
      const candidates = structured(candidateResponse);
      assert.equal(candidates.status, "candidates_ready");
      assert.equal(candidates.published, false);
      assert.equal(candidates.candidates.length, 1);
      assert.equal(candidates.candidates[0].maskBase64.length > 0, true);
      assert.equal(candidates.provider.id, "cowart-sidecar");
      assert.equal((await tree(ctx.canvasDir)).some((path) => path.includes("/segments/")), false);

      const [publishResponse] = await rpc([
        call(2, "segment_cowart_image", {
          cowartUrl: ctx.cowartUrl,
          canvasDir: ctx.canvasDir,
          targetShapeId: "shape:image",
          mode: "automatic",
          sidecarUrl,
          sidecarTokenFile: tokenFile,
          publish: true,
          segmentId: "segment:sidecar-published",
          expectedSourceAssetHash: sha256(sourceBytes),
        }),
      ], ctx);
      const published = structured(publishResponse);
      assert.equal(published.status, "published");
      assert.equal(published.segment.segmentId, "segment:sidecar-published");
      assert.equal(published.segment.provider.id, "cowart-sidecar");
      assert.equal(published.segment.provider.runtime, "python");
      assert.equal(requests.length, 2);
      assert.match(requests[0].authorization, /^Bearer sidecar-test-token-/);

      const canvas = await getCanvas(ctx.cowartUrl);
      assert.deepEqual(canvas.snapshot.store["shape:image"].meta?.cowartCandidateSegments, [{ segmentId: "segment:candidate-meta" }]);
      const manifest = JSON.parse(await readFile(`${ctx.canvasDir}/pages/one/segments/segment%3Asidecar-published/manifest.json`, "utf8"));
      assert.equal(manifest.provider.id, "cowart-sidecar");
      assert.equal(manifest.selection.mode, "automatic");
    });
  });
});

test("Given a Sidecar that stalls after response headers When the deadline expires Then the body read is cancelled as a timeout", async () => {
  const token = "sidecar-timeout-token-abcdefghijklmnopqrstuvwxyz";
  const tokenFile = `/private/tmp/cowart-sidecar-timeout-${process.pid}`;
  await writeFile(tokenFile, token, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    setTimeout(() => response.end("{}"), 200);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await assert.rejects(
      callSegmentationSidecar({
        provider: "sidecar",
        sidecarUrl: `http://127.0.0.1:${server.address().port}`,
        sidecarTokenFile: tokenFile,
        mode: "automatic",
      }, Buffer.from("fixture"), {
        width: 1,
        height: 1,
      }, { timeoutMs: 30 }),
      (error) => error?.code === "sidecar_timeout",
    );
  } finally {
    server.close();
    await once(server, "close");
    await rm(tokenFile, { force: true });
  }
});

test("Given confirmed segments When decomposition artifacts are published Then provenance and manifest state are deterministic", async () => {
  await withViteHarness(async (ctx) => {
    const sourceBytes = rgbaPng(2, 1, [255, 0, 0, 255]);
    await writeLocalSource(ctx, sourceBytes);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot(sourceBytes, 2, 1));
    const segment = await confirmSegment(ctx, {
      segmentId: "segment:decompose",
      bytes: sourceBytes,
      width: 2,
      height: 1,
      pixels: Uint8Array.from([255, 0]),
    });

    const [denied] = await rpc([
      call(1, "create_cowart_decomposition", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        segmentIds: [segment.segmentId],
        confirmUpload: false,
      }),
    ], ctx);
    assert.equal(denied.error.data.code, "image_upload_confirmation_required");

    const [createdResponse] = await rpc([
      call(2, "create_cowart_decomposition", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        segmentIds: [segment.segmentId],
        confirmUpload: true,
        decompositionId: "decomposition:test",
        requestId: "cowart-request-decomposition-test",
      }),
    ], ctx);
    const created = structured(createdResponse);
    assert.equal(created.decomposition.status, "requested");
    assert.equal(created.request.kind, "scene_decomposition");
    assert.equal(created.request.decomposition.uploadConfirmedAt, created.request.requestedAt);

    const [requestResponse, initialRefsResponse] = await rpc([
      call(3, "get_cowart_requests", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
      }),
      call(4, "get_cowart_references", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        decompositionId: "decomposition:test",
        returnBase64: true,
      }),
    ], ctx);
    const request = structured(requestResponse).requests[0];
    assert.equal(request.kind, "scene_decomposition");
    assert.equal(request.decomposition.id, "decomposition:test");
    const initialRefs = structured(initialRefsResponse);
    assert.deepEqual(initialRefs.references.map((item) => item.role), ["decomposition_source", "decomposition_segment"]);
    assert.ok(initialRefs.references.every((item) => item.base64.length > 0));

    const generatedBytes = rgbaPng(2, 1, [100, 100, 100, 255]);
    const wrongSizeBytes = rgbaPng(1, 1, [100, 100, 100, 255]);
    const [wrongSizeInsertResponse] = await rpc([
      call(41, "insert_cowart_image", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        imageBase64: wrongSizeBytes.toString("base64"),
        fileName: "wrong-size-depth.png",
        anchorShapeId: "shape:image",
        matchAnchor: false,
      }),
    ], ctx);
    const [wrongSizePublishResponse] = await rpc([
      call(42, "publish_cowart_decomposition_artifact", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        decompositionId: "decomposition:test",
        kind: "depth_hint",
        imageShapeId: structured(wrongSizeInsertResponse).shapeId,
      }),
    ], ctx);
    assert.equal(wrongSizePublishResponse.error.data.code, "artifact_size_mismatch");

    const [depthInsertResponse, cleanInsertResponse] = await rpc([
      call(5, "insert_cowart_image", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        imageBase64: generatedBytes.toString("base64"),
        fileName: "depth-hint.png",
        anchorShapeId: "shape:image",
      }),
      call(6, "insert_cowart_image", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        imageBase64: generatedBytes.toString("base64"),
        fileName: "clean-plate.png",
        anchorShapeId: "shape:image",
      }),
    ], ctx);
    const depthShapeId = structured(depthInsertResponse).shapeId;
    const cleanShapeId = structured(cleanInsertResponse).shapeId;
    const sceneGraph = {
      objects: [{
        name: "foreground object",
        segmentId: segment.segmentId,
        depthOrder: 1,
        visibleFraction: 0.8,
      }],
      relations: [],
    };

    const [depthPublishResponse] = await rpc([
      call(7, "publish_cowart_decomposition_artifact", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        decompositionId: "decomposition:test",
        kind: "depth_hint",
        imageShapeId: depthShapeId,
        prompt: "Infer relative depth order.",
        model: "codex-managed",
        sceneGraph,
      }),
    ], ctx);
    const depth = structured(depthPublishResponse);
    assert.equal(depth.artifact.synthetic, true);
    assert.equal(depth.artifact.provider, "codex-image_gen");
    assert.equal(depth.decomposition.status, "generating");

    const [cleanPublishResponse] = await rpc([
      call(8, "publish_cowart_decomposition_artifact", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        decompositionId: "decomposition:test",
        kind: "clean_plate",
        imageShapeId: cleanShapeId,
        sourceSegmentIds: [segment.segmentId],
        prompt: "Remove the visible foreground object.",
      }),
    ], ctx);
    const clean = structured(cleanPublishResponse);
    assert.equal(clean.decomposition.status, "ready");
    assert.equal(clean.decomposition.artifactCount, 2);
    assert.ok(clean.decomposition.completedAt);

    const [idempotentResponse, canvasResponse, refsResponse] = await rpc([
      call(9, "publish_cowart_decomposition_artifact", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        decompositionId: "decomposition:test",
        kind: "clean_plate",
        imageShapeId: cleanShapeId,
        sourceSegmentIds: [segment.segmentId],
      }),
      call(10, "get_cowart_canvas", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
      }),
      call(11, "get_cowart_references", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        decompositionId: "decomposition:test",
      }),
    ], ctx);
    assert.equal(structured(idempotentResponse).idempotent, true);
    const canvas = structured(canvasResponse);
    assert.equal(canvas.decompositions[0].status, "ready");
    assert.deepEqual(canvas.decompositions[0].artifactKinds, ["depth_hint", "clean_plate"]);
    const refs = structured(refsResponse);
    assert.deepEqual(refs.references.map((item) => item.role), [
      "decomposition_source",
      "decomposition_segment",
      "decomposition_depth_hint",
      "decomposition_clean_plate",
    ]);
    assert.equal(refs.decomposition.sceneGraph.objects[0].segmentId, segment.segmentId);

    const changedDepthBytes = rgbaPng(2, 1, [20, 20, 20, 255]);
    const [replacedDepthResponse] = await rpc([
      call(12, "replace_cowart_image", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        targetShapeId: depthShapeId,
        imageBase64: changedDepthBytes.toString("base64"),
        fileName: "changed-depth.png",
      }),
    ], ctx);
    assert.equal(structured(replacedDepthResponse).shapeId, depthShapeId);
    const [staleRefsResponse] = await rpc([
      call(13, "get_cowart_references", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        decompositionId: "decomposition:test",
      }),
    ], ctx);
    assert.equal(staleRefsResponse.error.data.code, "artifact_asset_changed");
  });
});

test("Given visible and completed object layers When artifacts are published Then source extraction and SAM 2 completion provenance are enforced", async () => {
  await withViteHarness(async (ctx) => {
    const sourceBytes = rgbaPng(2, 1, [255, 0, 0, 255]);
    const generatedBytes = rgbaPng(2, 1, [0, 120, 255, 255]);
    await writeLocalSource(ctx, sourceBytes);
    await putSnapshot(ctx.cowartUrl, localImageSnapshot(sourceBytes, 2, 1));
    const sourceSegment = await confirmSegment(ctx, {
      segmentId: "segment:visible-source",
      bytes: sourceBytes,
      width: 2,
      height: 1,
      pixels: Uint8Array.from([255, 0]),
    });
    const [createdResponse] = await rpc([
      call(1, "create_cowart_decomposition", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        segmentIds: [sourceSegment.segmentId],
        confirmUpload: true,
        decompositionId: "decomposition:layers",
      }),
    ], ctx);
    assert.equal(structured(createdResponse).decomposition.status, "requested");

    const [visibleExtractResponse] = await rpc([
      call(2, "extract_cowart_object", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        segmentId: sourceSegment.segmentId,
      }),
    ], ctx);
    const visibleExtract = structured(visibleExtractResponse);
    const visibleShapeId = visibleExtract.shapeId;
    assert.equal(visibleExtract.synthetic, false);
    const [visiblePublishResponse] = await rpc([
      call(3, "publish_cowart_decomposition_artifact", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        decompositionId: "decomposition:layers",
        kind: "visible_object_layer",
        imageShapeId: visibleShapeId,
        sourceSegmentIds: [sourceSegment.segmentId],
      }),
    ], ctx);
    const visible = structured(visiblePublishResponse);
    assert.equal(visible.artifact.synthetic, false);
    assert.equal(visible.artifact.provider, "sharp");

    const [generatedInsertResponse] = await rpc([
      call(4, "insert_cowart_image", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        imageBase64: generatedBytes.toString("base64"),
        fileName: "completed-object-candidate.png",
        anchorShapeId: "shape:image",
        expectedSourceAssetHash: sha256(sourceBytes),
        objectEdit: {
          operation: "occlusion_completion",
          provider: "codex-image_gen",
          model: "codex-managed",
        },
      }),
    ], ctx);
    const generated = structured(generatedInsertResponse);
    const generatedSegment = await confirmSegment(ctx, {
      segmentId: "segment:generated-sam2",
      bytes: generatedBytes,
      width: 2,
      height: 1,
      pixels: Uint8Array.from([255, 0]),
      source: {
        pageId: "page:one",
        shapeId: generated.shapeId,
        assetId: generated.assetId,
        assetSha256: sha256(generatedBytes),
        width: 2,
        height: 1,
      },
      provider: {
        id: "cowart-sidecar",
        runtime: "python",
        processing: "local",
        model: "sam2.1-hiera-tiny",
        version: "0.7.0",
      },
    });
    const [completedExtractResponse] = await rpc([
      call(5, "extract_cowart_object", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        segmentId: generatedSegment.segmentId,
      }),
    ], ctx);
    const completedExtract = structured(completedExtractResponse);
    const completedShapeId = completedExtract.shapeId;
    assert.equal(completedExtract.synthetic, true);

    const [missingGeneratedSegment] = await rpc([
      call(6, "publish_cowart_decomposition_artifact", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        decompositionId: "decomposition:layers",
        kind: "completed_object",
        imageShapeId: completedShapeId,
        sourceSegmentIds: [sourceSegment.segmentId],
      }),
    ], ctx);
    assert.equal(missingGeneratedSegment.error.data.code, "generated_segment_required");

    const [completedPublishResponse] = await rpc([
      call(7, "publish_cowart_decomposition_artifact", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        decompositionId: "decomposition:layers",
        kind: "completed_object",
        imageShapeId: completedShapeId,
        sourceSegmentIds: [sourceSegment.segmentId],
        generatedSegmentId: generatedSegment.segmentId,
        prompt: "Complete the hidden side of the foreground object.",
      }),
    ], ctx);
    const completed = structured(completedPublishResponse);
    assert.equal(completed.artifact.synthetic, true);
    assert.equal(completed.artifact.provider, "codex-image_gen");
    assert.equal(completed.artifact.generatedSegmentId, generatedSegment.segmentId);

    const canvas = await getCanvas(ctx.cowartUrl);
    assert.equal(canvas.snapshot.store[visibleShapeId].meta.cowartDecompositionArtifact.synthetic, false);
    assert.equal(canvas.snapshot.store[completedShapeId].meta.cowartDecompositionArtifact.synthetic, true);
    assert.equal(
      canvas.snapshot.store[completedShapeId].meta.cowartDecompositionArtifact.generatedSegmentId,
      generatedSegment.segmentId,
    );
  });
});
