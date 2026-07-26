import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EVIDENCE,
  MAPPING_FIX_EVIDENCE,
  applyTransformedFixtureStack,
  assertSegmentRange,
  currentImageMappingSnapshot,
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
