import { expect, test } from "@playwright/test";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCanonicalMaskPng } from "../shared/cowart-segment-mask.mjs";
import {
  EVIDENCE,
  MAPPING_FIX_EVIDENCE,
  applyTransformedFixtureStack,
  assertSegmentRange,
  currentImageMappingSnapshot,
  freePort,
  loadFixture,
  previewAlignmentSnapshot,
  screenPoint,
  seedFixtureThroughEditor,
  sha256,
  selectFixture,
  startCowartServer,
  stopCowartServer,
} from "./object-edit-helpers.mjs";

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite";

async function startFixtureSidecar(width, height) {
  const home = await mkdtemp(join(tmpdir(), "cowart-sidecar-e2e-"));
  const token = "cowart-sidecar-e2e-token-abcdefghijklmnopqrstuvwxyz";
  const tokenFile = join(home, "token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const calls = [];
  const sidecar = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({ authorization: request.headers.authorization, mode: body.mode, prompt: body.prompt ?? null });
    const firstPixels = new Uint8Array(width * height);
    const secondPixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        firstPixels[y * width + x] = x < width / 2 ? 255 : 0;
        secondPixels[y * width + x] = y < height / 2 ? 255 : 0;
      }
    }
    const masks = body.mode === "automatic"
      ? [encodeCanonicalMaskPng({ width, height, pixels: firstPixels }), encodeCanonicalMaskPng({ width, height, pixels: secondPixels })]
      : [encodeCanonicalMaskPng({ width, height, pixels: firstPixels })];
    response.statusCode = request.headers.authorization === `Bearer ${token}` ? 200 : 401;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      naturalSize: { width, height },
      provider: { model: "sam2.1-hiera-tiny", version: "0.7.0", device: "cpu" },
      candidates: masks.map((mask, index) => ({
        candidateId: `candidate:${index + 1}`,
        score: 0.9 - index * 0.1,
        label: body.prompt ?? null,
        bbox: { x: 0, y: 0, w: width, h: height },
        area: firstPixels.filter((value) => value > 0).length,
        maskBase64: mask.toString("base64"),
      })),
    }));
  });
  const port = await freePort();
  sidecar.listen(port, "127.0.0.1");
  await once(sidecar, "listening");
  return {
    calls,
    tokenFile,
    url: `http://127.0.0.1:${port}`,
    async close() {
      sidecar.close();
      await once(sidecar, "close");
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function activateTool(page) {
  await page.getByTestId("object-edit.tool").click();
  await expect(page.getByTestId("object-edit.status")).toBeVisible();
}

async function acceptPreviewWithKeyboard(page) {
  await expect(page.locator(".cowart-object-edit-panel--preview")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("object-edit.accept").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("object-edit.status")).toContainText(/Segment confirmed/i);
}

function summarizeNetwork(browserLogs) {
  const httpRequests = browserLogs.requests.filter((request) => request.url.startsWith("http"));
  const externalRequests = httpRequests.filter((request) => new URL(request.url).hostname !== "127.0.0.1");
  return {
    externalHosts: [...new Set(externalRequests.map((request) => new URL(request.url).hostname))].sort(),
    externalMutations: externalRequests.filter((request) => !["GET", "HEAD"].includes(request.method)),
    modelRequested: externalRequests.some((request) => request.url === "https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite"),
    wasmRequested: externalRequests.some((request) => request.url.startsWith("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm")),
    sourceAssetEgress: externalRequests.filter((request) => request.url.includes("primary-object") || request.url.includes("page-assets")),
  };
}

test("object edit uses real local MediaPipe segmentation and persists confirmed segments", async ({ page }) => {
  await mkdir(EVIDENCE, { recursive: true });
  const server = await startCowartServer();
  const browserLogs = { console: [], requests: [], responses: [] };
  page.on("console", (message) => browserLogs.console.push({ type: message.type(), text: message.text() }));
  page.on("request", (request) => browserLogs.requests.push({ method: request.method(), url: request.url() }));
  page.on("response", (response) => browserLogs.responses.push({ status: response.status(), url: response.url() }));
  try {
    const { bytes, manifest } = await loadFixture();
    await page.goto(server.cowartUrl);
    await page.evaluate(() => localStorage.setItem("cowart-onboarding-dismissed", "1"));
    await seedFixtureThroughEditor(page, server.cowartUrl, bytes, manifest);

    for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 900 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.goto(server.cowartUrl);
      await selectFixture(page);
      await activateTool(page);
      await page.screenshot({ path: join(EVIDENCE, `ready-${viewport.width}.png`), fullPage: true });
    }

    const unsupportedPage = await page.context().newPage();
    await unsupportedPage.addInitScript(() => {
      if (typeof window.OffscreenCanvas !== "function") return;
      const NativeOffscreenCanvas = window.OffscreenCanvas;
      window.OffscreenCanvas = class CowartNoWebGL2OffscreenCanvas extends NativeOffscreenCanvas {
        getContext(contextId, ...args) {
          if (contextId === "webgl2") return null;
          return super.getContext(contextId, ...args);
        }
      };
    });
    try {
      await unsupportedPage.goto(server.cowartUrl);
      await unsupportedPage.evaluate(() => localStorage.setItem("cowart-onboarding-dismissed", "1"));
      await selectFixture(unsupportedPage);
      await activateTool(unsupportedPage);
      await expect(unsupportedPage.getByTestId("object-edit.error")).toBeVisible();
      await unsupportedPage.screenshot({ path: join(EVIDENCE, "unsupported.png"), fullPage: true });
      await writeFile(join(EVIDENCE, "unsupported-capability.json"), JSON.stringify({ removedCapability: "OffscreenCanvas.webgl2", persistentOverride: false }, null, 2));
    } finally {
      await unsupportedPage.close();
    }

    await page.reload();
    await selectFixture(page);
    await activateTool(page);
    const point = await screenPoint(page, manifest.inputs.points[0]);
    const checksumCorruption = { url: MODEL_URL, originalSha256: null, corruptedSha256: null, originalLength: 0 };
    const corruptModelRoute = async (route) => {
      const response = await route.fetch();
      const original = Buffer.from(await response.body());
      const corrupted = Buffer.from(original);
      corrupted[0] = corrupted[0] ^ 0xff;
      checksumCorruption.originalSha256 = sha256(original);
      checksumCorruption.corruptedSha256 = sha256(corrupted);
      checksumCorruption.originalLength = original.length;
      await route.fulfill({ response, body: corrupted });
    };
    await page.context().route(MODEL_URL, corruptModelRoute, { times: 1 });
    await page.mouse.click(point.x, point.y);
    await expect(page.getByTestId("object-edit.error")).toBeVisible({ timeout: 90_000 });
    await page.screenshot({ path: join(EVIDENCE, "checksum-error.png"), fullPage: true });
    await writeFile(join(EVIDENCE, "checksum-corruption.json"), JSON.stringify(checksumCorruption, null, 2));
    await page.context().unroute(MODEL_URL, corruptModelRoute);

    await page.reload();
    await selectFixture(page);
    await activateTool(page);
    await page.mouse.click(point.x, point.y);
    await expect(page.getByTestId("object-edit.loading")).toBeVisible();
    await page.screenshot({ path: join(EVIDENCE, "point-loading.png"), fullPage: true });
    await expect(page.locator(".cowart-object-edit-panel--preview")).toBeVisible({ timeout: 90_000 });
    const alternativePoint = await screenPoint(page, manifest.inputs.points[1]);
    await page.mouse.click(alternativePoint.x, alternativePoint.y);
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible({ timeout: 90_000 });
    await page.getByTestId("object-edit.previous-candidate").click();
    await expect(page.getByText("1 / 2", { exact: true })).toBeVisible();
    await page.getByTestId("object-edit.brush-remove").click();
    await page.mouse.move(point.x - 10, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 10, point.y, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId("object-edit.undo")).toBeEnabled();
    await page.getByTestId("object-edit.undo").click();
    await expect(page.getByTestId("object-edit.redo")).toBeEnabled();
    await page.getByTestId("object-edit.redo").click();
    await page.getByTestId("object-edit.reset").click();
    await page.screenshot({ path: join(EVIDENCE, "candidate-brush-history.png"), fullPage: true });
    await acceptPreviewWithKeyboard(page);
    await page.screenshot({ path: join(EVIDENCE, "point-confirmed.png"), fullPage: true });

    await page.reload();
    await selectFixture(page);
    await activateTool(page);
    await expect(page.getByText(/confirmed/i)).toBeVisible();
    await page.screenshot({ path: join(EVIDENCE, "reload-rehydrated.png"), fullPage: true });

    const scribble = [];
    for (const item of manifest.inputs.scribbles[0].points) scribble.push(await screenPoint(page, item));
    await page.mouse.move(scribble[0].x, scribble[0].y);
    await page.mouse.down();
    for (const item of scribble.slice(1)) await page.mouse.move(item.x, item.y, { steps: 6 });
    await page.mouse.up();
    await acceptPreviewWithKeyboard(page);
    await page.screenshot({ path: join(EVIDENCE, "scribble-confirmed.png"), fullPage: true });

    await page.mouse.click(point.x, point.y);
    await expect(page.locator(".cowart-object-edit-panel--preview")).toBeVisible({ timeout: 90_000 });
    await page.keyboard.press("Escape");
    await page.screenshot({ path: join(EVIDENCE, "keyboard-cancel.png"), fullPage: true });

    await page.mouse.click(point.x, point.y);
    await expect(page.locator(".cowart-object-edit-panel--preview")).toBeVisible({ timeout: 90_000 });
    await page.evaluate(() => {
      const editor = window.__cowartEditor;
      const asset = editor.getAsset("asset:fixture");
      editor.store.put([{ ...asset, meta: { ...asset.meta, cowartSha256: "0".repeat(64) } }]);
    });
    await page.getByTestId("object-edit.accept").click();
    await expect(page.getByTestId("object-edit.error")).toBeVisible();
    await page.screenshot({ path: join(EVIDENCE, "stale-source.png"), fullPage: true });

    await page.evaluate(() => {
      const editor = window.__cowartEditor;
      const shape = editor.getShape("shape:fixture");
      editor.updateShape({ id: shape.id, type: shape.type, props: { ...shape.props, crop: { topLeft: { x: 0.1, y: 0.1 }, bottomRight: { x: 0.9, y: 0.9 } }, flipX: true } });
    });
    await page.screenshot({ path: join(EVIDENCE, "crop-flip-alignment.png"), fullPage: true });

    const list = await (await fetch(`${server.cowartUrl}/api/canvas/segments?shapeId=shape:fixture&assetId=asset:fixture`)).json();
    const pointSegment = list.segments.find((segment) => segment.selection?.mode === "point");
    const scribbleSegment = list.segments.find((segment) => segment.selection?.mode === "scribble");
    assertSegmentRange(expect, pointSegment, manifest, "point");
    assertSegmentRange(expect, scribbleSegment, manifest, "scribble");
    const network = summarizeNetwork(browserLogs);
    expect(network.externalHosts).toEqual(["cdn.jsdelivr.net", "cdn.tldraw.com", "storage.googleapis.com"]);
    expect(network.externalMutations).toEqual([]);
    expect(network.modelRequested).toBeTruthy();
    expect(network.wasmRequested).toBeTruthy();
    expect(network.sourceAssetEgress).toEqual([]);
    await writeFile(join(EVIDENCE, "real-model-mask-metrics.json"), JSON.stringify({ pointSegment, scribbleSegment }, null, 2));
    await writeFile(join(EVIDENCE, "browser-console-network.json"), JSON.stringify({ ...browserLogs, network }, null, 2));
  await writeFile(join(EVIDENCE, "browser-qa-result.json"), JSON.stringify({ pass: true, cowartUrl: server.cowartUrl }, null, 2));
  } finally {
    await writeFile(join(EVIDENCE, "browser-console-network.json"), JSON.stringify({ ...browserLogs, network: summarizeNetwork(browserLogs) }, null, 2)).catch(() => {});
    await stopCowartServer(server);
  }
});

test("object edit maps transformed image clicks with live shape and ancestor records", async ({ page }) => {
  await mkdir(MAPPING_FIX_EVIDENCE, { recursive: true });
  const server = await startCowartServer();
  try {
    const { bytes, manifest } = await loadFixture();
    const target = manifest.inputs.points[0];
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(server.cowartUrl);
    await page.evaluate(() => localStorage.setItem("cowart-onboarding-dismissed", "1"));
    await seedFixtureThroughEditor(page, server.cowartUrl, bytes, manifest);
    await page.reload();
    await selectFixture(page);
    await activateTool(page);

    const transform = await applyTransformedFixtureStack(page);
    const before = await currentImageMappingSnapshot(page, manifest, target);
    await page.mouse.click(before.targetScreen.x, before.targetScreen.y);
    await expect(page.locator(".cowart-object-edit-panel--preview")).toBeVisible({ timeout: 90_000 });
    const overlay = await previewAlignmentSnapshot(page, before.expectedPreview);
    await page.screenshot({ path: join(MAPPING_FIX_EVIDENCE, "transformed-preview-overlay.png"), fullPage: true });
    await page.getByTestId("object-edit.accept").click();
    await expect(page.getByTestId("object-edit.status")).toContainText(/Segment confirmed/i);
    await page.screenshot({ path: join(MAPPING_FIX_EVIDENCE, "transformed-confirmed.png"), fullPage: true });

    const response = await fetch(`${server.cowartUrl}/api/canvas/segments?shapeId=shape:fixture&assetId=asset:fixture`);
    expect(response.ok).toBeTruthy();
    const list = await response.json();
    const pointSegment = list.segments.find((segment) => segment.selection?.mode === "point");
    assertSegmentRange(expect, pointSegment, manifest, "transformed point");
    expect(Math.abs(pointSegment.selection.point.x - target.x), "persisted normalized x").toBeLessThanOrEqual(0.02);
    expect(Math.abs(pointSegment.selection.point.y - target.y), "persisted normalized y").toBeLessThanOrEqual(0.02);
    expect(before.naturalRoundTripDriftPx.x, "pure mapper x round trip").toBeLessThanOrEqual(1);
    expect(before.naturalRoundTripDriftPx.y, "pure mapper y round trip").toBeLessThanOrEqual(1);
    expect(overlay.aligned, `overlay matrix deltas ${JSON.stringify(overlay.matrixDeltas)}`).toBeTruthy();

    await writeFile(join(MAPPING_FIX_EVIDENCE, "transform-regression-result.json"), JSON.stringify({
      pass: true,
      server: { cowartUrl: server.cowartUrl },
      transform,
      targetNormalized: target,
      before,
      overlay,
      pointSegment,
      screenshots: ["transformed-preview-overlay.png", "transformed-confirmed.png"],
    }, null, 2));
  } finally {
    await stopCowartServer(server);
  }
});

test("confirmed objects queue object actions and a four-up Variant Grid from the canvas", async ({ page }) => {
  const server = await startCowartServer();
  try {
    const { bytes, manifest } = await loadFixture();
    await page.goto(server.cowartUrl);
    await page.evaluate(() => localStorage.setItem("cowart-onboarding-dismissed", "1"));
    await seedFixtureThroughEditor(page, server.cowartUrl, bytes, manifest);
    const width = manifest.file.dimensions.width;
    const height = manifest.file.dimensions.height;
    const pageId = await page.evaluate(() => window.__cowartEditor.getCurrentPageId());
    const mask = encodeCanonicalMaskPng({ width, height, pixels: new Uint8Array(width * height).fill(255) });
    const confirmed = await fetch(`${server.cowartUrl}/api/canvas/segments/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        segmentId: "segment:e2e-object",
        source: {
          pageId,
          shapeId: "shape:fixture",
          assetId: "asset:fixture",
          assetSha256: sha256(bytes),
          width,
          height,
        },
        maskBase64: mask.toString("base64"),
        previewBase64: mask.toString("base64"),
        selection: { mode: "point", point: { x: 0.5, y: 0.5 } },
        provider: { id: "e2e-fixture", runtime: "test", processing: "local", model: "fixture", version: "1" },
      }),
    });
    expect(confirmed.status).toBe(201);

    await page.reload();
    await selectFixture(page);
    await activateTool(page);
    await expect(page.getByTestId("object-edit.object-list")).toBeVisible();
    await page.getByTestId("object-edit.variants").click();
    const grid = await page.evaluate(() => {
      const editor = window.__cowartEditor;
      const shapes = Array.from(editor.getCurrentPageShapeIds(), (id) => editor.getShape(id)).filter(Boolean);
      const holders = shapes.filter((shape) => shape.meta?.cowartVariantGroup?.id);
      return {
        count: holders.length,
        gridIds: [...new Set(holders.map((shape) => shape.meta.cowartVariantGroup.id))],
        requestKinds: holders.map((shape) => shape.meta.cowartRequest?.kind),
        indexes: holders.map((shape) => shape.meta.cowartVariant?.index).sort(),
      };
    });
    expect(grid.count).toBe(4);
    expect(grid.gridIds).toHaveLength(1);
    expect(grid.requestKinds).toEqual(["variant", "variant", "variant", "variant"]);
    expect(grid.indexes).toEqual([0, 1, 2, 3]);

    await page.getByTestId("object-edit.modify").click();
    const actions = await page.evaluate(() => {
      const editor = window.__cowartEditor;
      return Array.from(editor.getCurrentPageShapeIds(), (id) => editor.getShape(id))
        .filter((shape) => shape?.meta?.cowartRequest?.kind === "object_action")
        .map((shape) => shape.meta.cowartObjectAction.operation);
    });
    expect(actions).toEqual(["modify"]);

    await page.waitForTimeout(300);
    for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 900 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => {
        const editor = window.__cowartEditor;
        const bounds = editor.getCurrentPageBounds();
        if (bounds) editor.zoomToBounds(bounds, { inset: 72, immediate: true });
      });
      await page.screenshot({ path: join(EVIDENCE, `variant-grid-${viewport.width}.png`), fullPage: true });
    }
  } finally {
    await stopCowartServer(server);
  }
});

test("Sidecar text and automatic modes require confirmation and expose a decomposition stack", async ({ page }) => {
  const { bytes, manifest } = await loadFixture();
  const fixtureSidecar = await startFixtureSidecar(manifest.file.dimensions.width, manifest.file.dimensions.height);
  const server = await startCowartServer({
    env: {
      COWART_SIDECAR_URL: fixtureSidecar.url,
      COWART_SIDECAR_TOKEN_FILE: fixtureSidecar.tokenFile,
    },
  });
  try {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(server.cowartUrl);
    await page.evaluate(() => localStorage.setItem("cowart-onboarding-dismissed", "1"));
    await page.waitForFunction(() => Boolean(window.__cowartEditor));
    await seedFixtureThroughEditor(page, server.cowartUrl, bytes, manifest);
    await page.reload();
    await selectFixture(page);
    await activateTool(page);

    await page.getByRole("button", { name: "Auto", exact: true }).click();
    await page.getByTestId("object-edit.sidecar-run").click();
    await expect(page.getByText("1 / 2", { exact: true })).toBeVisible();
    await page.getByTestId("object-edit.next-candidate").click();
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await page.getByTestId("object-edit.accept").click();
    await expect(page.getByTestId("object-edit.status")).toContainText(/Segment confirmed/i);

    await page.getByRole("button", { name: "Text", exact: true }).click();
    await page.getByTestId("object-edit.sidecar-prompt").fill("foreground product");
    await page.getByTestId("object-edit.sidecar-run").click();
    await expect(page.locator(".cowart-object-edit-panel--preview")).toBeVisible();
    await page.getByTestId("object-edit.accept").click();
    await expect(page.getByTestId("object-edit.status")).toContainText(/Segment confirmed/i);
    expect(fixtureSidecar.calls.map((call) => call.mode)).toEqual(["automatic", "text"]);
    expect(fixtureSidecar.calls[1].prompt).toBe("foreground product");
    expect(fixtureSidecar.calls.every((call) => call.authorization.startsWith("Bearer cowart-sidecar-e2e-token-"))).toBeTruthy();

    await page.getByTestId("object-edit.decompose").click();
    await expect(page.getByRole("alertdialog", { name: "Confirm image upload" })).toBeVisible();
    await page.getByTestId("object-edit.cancel-decompose").click();
    const countAfterCancel = await page.evaluate(() => (
      Array.from(window.__cowartEditor.getCurrentPageShapeIds(), (id) => window.__cowartEditor.getShape(id))
        .filter((shape) => shape?.meta?.cowartRequest?.kind === "scene_decomposition")
        .length
    ));
    expect(countAfterCancel).toBe(0);

    await page.getByTestId("object-edit.decompose").click();
    await page.getByTestId("object-edit.confirm-decompose").click();
    const decomposition = await page.evaluate(() => {
      const editor = window.__cowartEditor;
      const shapes = Array.from(editor.getCurrentPageShapeIds(), (id) => editor.getShape(id)).filter(Boolean);
      const holder = shapes.find((shape) => shape.meta?.cowartRequest?.kind === "scene_decomposition");
      const artifactId = "shape:e2e-depth";
      editor.createShape({
        id: artifactId,
        type: "image",
        x: 560,
        y: 100,
        props: { assetId: "asset:fixture", w: 384, h: 288 },
      });
      editor.updateShape({
        id: holder.id,
        type: holder.type,
        meta: {
          ...holder.meta,
          cowartDecomposition: {
            ...holder.meta.cowartDecomposition,
            status: "generating",
            revision: 2,
            artifacts: [{
              kind: "depth_hint",
              imageShapeId: artifactId,
              sourceSegmentIds: [],
              synthetic: true,
              provider: "codex-image_gen",
              artifactSha256: "1".repeat(64),
            }],
          },
        },
      });
      return {
        holderId: holder.id,
        requestKind: holder.meta.cowartRequest.kind,
        uploadConfirmedAt: holder.meta.cowartRequest.decomposition.uploadConfirmedAt,
        segmentIds: holder.meta.cowartRequest.decomposition.segmentIds,
      };
    });
    expect(decomposition.requestKind).toBe("scene_decomposition");
    expect(Number.isNaN(Date.parse(decomposition.uploadConfirmedAt))).toBeFalsy();
    expect(decomposition.segmentIds).toHaveLength(2);
    await expect(page.getByTestId("object-edit.decomposition-stack")).toBeVisible();
    const layerToggle = page.getByTestId("object-edit.decomposition-stack").getByRole("checkbox");
    await layerToggle.uncheck();
    const opacity = await page.evaluate(() => window.__cowartEditor.getShape("shape:e2e-depth").opacity);
    expect(opacity).toBe(0);

    await page.screenshot({ path: join(EVIDENCE, "sidecar-decomposition-375.png"), fullPage: true });
  } finally {
    await stopCowartServer(server);
    await fixtureSidecar.close();
  }
});
