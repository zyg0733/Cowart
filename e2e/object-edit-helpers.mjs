import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createImageCoordinateMapper } from "../shared/cowart-image-coordinates.mjs";

export const ROOT = resolve(".");
export const EVIDENCE = join(ROOT, ".omo/evidence/object-aware-editing/task-6/e2e");
export const MAPPING_FIX_EVIDENCE = join(ROOT, ".omo/evidence/object-aware-editing/task-7/mapping-fix");
export const FIXTURE = join(ROOT, "test/fixtures/object-editing/primary-object.png");
export const SOURCE = join(ROOT, "test/fixtures/object-editing/SOURCE.json");

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

export async function loadFixture() {
  const bytes = await readFile(FIXTURE);
  const manifest = JSON.parse(await readFile(SOURCE, "utf8"));
  if (sha256(bytes) !== manifest.file.sha256) throw new Error("Fixture SHA mismatch");
  return { bytes, manifest };
}

export async function startCowartServer(options = {}) {
  const canvasDir = await mkdtemp(join(tmpdir(), "cowart-e2e-"));
  const port = await freePort();
  const cowartUrl = `http://127.0.0.1:${port}`;
  const command = options.command ?? "npm";
  const args = options.args ?? ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(port)];
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, COWART_CANVAS_DIR: canvasDir, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  child.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
  child.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));
  const server = { canvasDir, cowartUrl, child, serverLog };
  try {
    await waitForServer(server, options.readinessTimeoutMs ?? 20_000);
    return server;
  } catch (error) {
    await cleanupCowartServer(server, { writeEvidence: false });
    throw error;
  }
}

export async function stopCowartServer(server) {
  await cleanupCowartServer(server, { writeEvidence: true });
}

async function cleanupCowartServer(server, { writeEvidence }) {
  await terminateChild(server.child);
  if (writeEvidence) {
    await mkdir(EVIDENCE, { recursive: true });
    await writeFile(join(EVIDENCE, "vite-preview-server.log"), server.serverLog.join(""));
  }
  await rm(server.canvasDir, { recursive: true, force: true });
  if (!writeEvidence) return;
  await writeFile(join(EVIDENCE, "cleanup.json"), JSON.stringify({
    canvasDirRemoved: server.canvasDir,
    serverExitCode: server.child.exitCode,
    serverSignal: server.child.signalCode,
  }, null, 2));
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    once(child, "exit").then(() => true).catch(() => true),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ]);
  if (exited) return;
  child.kill("SIGKILL");
  await Promise.race([
    once(child, "exit").catch(() => {}),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
  ]);
}

async function waitForServer(server, timeoutMs) {
  const started = Date.now();
  let lastError = null;
  let childError = null;
  let childExit = null;
  const onError = (error) => {
    childError = error;
  };
  const onExit = (code, signal) => {
    childExit = { code, signal };
  };
  server.child.once("error", onError);
  server.child.once("exit", onExit);
  while (Date.now() - started < timeoutMs) {
    if (childError) {
      server.child.off("error", onError);
      server.child.off("exit", onExit);
      throw childError;
    }
    if (childExit) {
      server.child.off("error", onError);
      server.child.off("exit", onExit);
      throw new Error(`Cowart preview server exited before readiness: code=${childExit.code} signal=${childExit.signal}`);
    }
    try {
      const response = await fetch(`${server.cowartUrl}/api/canvas`);
      if (response.ok) {
        server.child.off("error", onError);
        server.child.off("exit", onExit);
        return;
      }
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  }
  server.child.off("error", onError);
  server.child.off("exit", onExit);
  throw lastError ?? new Error(`Timed out waiting for ${server.cowartUrl}`);
}

export async function seedFixtureThroughEditor(page, cowartUrl, bytes, manifest) {
  const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
  await page.evaluate(({ dataUrl: src, manifest: source }) => {
    const editor = window.__cowartEditor;
    editor.createAssets([{
      id: "asset:fixture",
      typeName: "asset",
      type: "image",
      meta: {},
      props: { name: "primary-object.png", src, w: source.file.dimensions.width, h: source.file.dimensions.height, mimeType: "image/png", isAnimated: false },
    }]);
    editor.createShape({ id: "shape:fixture", type: "image", x: 120, y: 100, props: { assetId: "asset:fixture", w: 384, h: 288 } });
    editor.select("shape:fixture");
  }, { dataUrl, manifest });
  const snapshot = await page.evaluate(() => window.__cowartEditor.store.getStoreSnapshot());
  const response = await fetch(`${cowartUrl}/api/canvas`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshot }),
  });
  if (!response.ok) throw new Error(`PUT canvas failed: ${response.status} ${await response.text()}`);
}

export async function selectFixture(page) {
  await page.waitForFunction(() => window.__cowartEditor);
  await page.evaluate(() => {
    const editor = window.__cowartEditor;
    editor.select("shape:fixture");
    editor.zoomToSelection({ animation: { duration: 0 } });
  });
}

export async function screenPoint(page, normalized) {
  return page.evaluate((point) => {
    const editor = window.__cowartEditor;
    const shape = editor.getShape("shape:fixture");
    return editor.pageToScreen({ x: shape.x + point.x * shape.props.w, y: shape.y + point.y * shape.props.h });
  }, normalized);
}

const fixtureSource = (records, dimensions) => ({ pageId: "page:page", shapeId: records.shape.id, assetId: records.asset.id, assetSha256: records.asset.meta.cowartSha256, width: dimensions.width, height: dimensions.height });

export async function applyTransformedFixtureStack(page) {
  return page.evaluate(() => {
    const editor = window.__cowartEditor;
    editor.createShape({ id: "shape:fixture-parent", type: "frame", x: 80, y: 70, props: { w: 520, h: 400, name: "QA parent" } });
    editor.reparentShapes(["shape:fixture"], "shape:fixture-parent");
    const parent = editor.getShape("shape:fixture-parent");
    editor.updateShape({ id: parent.id, type: parent.type, x: parent.x + 37, y: parent.y + 29, rotation: Math.PI / 14 });
    const shape = editor.getShape("shape:fixture");
    const crop = { topLeft: { x: 0.05, y: 0.05 }, bottomRight: { x: 0.95, y: 0.95 } };
    editor.updateShape({ id: shape.id, type: shape.type, rotation: Math.PI / 9, props: { ...shape.props, crop, flipX: true } });
    editor.select("shape:fixture");
    editor.zoomToSelection({ animation: { duration: 0 } });
    const transformedShape = editor.getShape("shape:fixture");
    const transformedParent = editor.getShape("shape:fixture-parent");
    return { crop: transformedShape.props.crop, flipX: transformedShape.props.flipX, rotationRadians: transformedShape.rotation, parent: { id: transformedParent.id, type: transformedParent.type, x: transformedParent.x, y: transformedParent.y, rotationRadians: transformedParent.rotation }, parentId: transformedShape.parentId };
  });
}

export async function currentImageMappingSnapshot(page, manifest, normalized) {
  const records = await page.evaluate(() => {
    const editor = window.__cowartEditor;
    const shape = editor.getShape("shape:fixture");
    const asset = editor.getAsset("asset:fixture");
    const ancestors = [];
    let parentId = shape.parentId;
    for (let guard = 0; guard < 64; guard += 1) {
      const parent = parentId ? editor.getShape(parentId) : null;
      if (!parent) break;
      ancestors.push(parent);
      parentId = parent.parentId;
    }
    return { shape, asset, ancestors };
  });
  const source = fixtureSource(records, manifest.file.dimensions);
  const mapper = createImageCoordinateMapper({ source, shape: records.shape, ancestors: records.ancestors });
  const targetNatural = { x: normalized.x * source.width, y: normalized.y * source.height };
  const targetPage = mapper.naturalPointToPagePoint(targetNatural);
  const targetScreen = await page.evaluate((point) => window.__cowartEditor.pageToScreen(point), targetPage);
  const targetPageRoundTrip = await page.evaluate((point) => window.__cowartEditor.screenToPage(point), targetScreen);
  const roundTripNatural = mapper.pagePointToNaturalPoint(targetPageRoundTrip);
  return { records, targetNatural, targetPage, targetScreen, roundTripNatural, naturalRoundTripDriftPx: { x: Math.abs(roundTripNatural.x - targetNatural.x), y: Math.abs(roundTripNatural.y - targetNatural.y) }, expectedPreview: { width: mapper.localSize.w, height: mapper.localSize.h, matrix: await expectedPreviewMatrix(page, mapper) } };
}

async function expectedPreviewMatrix(page, mapper) {
  const width = mapper.localSize.w;
  const height = mapper.localSize.h;
  const { origin, xAxis, yAxis } = await page.evaluate((points) => {
    const editor = window.__cowartEditor;
    return { origin: editor.pageToScreen(points.origin), xAxis: editor.pageToScreen(points.xAxis), yAxis: editor.pageToScreen(points.yAxis) };
  }, {
    origin: mapper.localPointToPagePoint({ x: 0, y: 0 }),
    xAxis: mapper.localPointToPagePoint({ x: width, y: 0 }),
    yAxis: mapper.localPointToPagePoint({ x: 0, y: height }),
  });
  return [(xAxis.x - origin.x) / width, (xAxis.y - origin.y) / width, (yAxis.x - origin.x) / height, (yAxis.y - origin.y) / height, origin.x, origin.y];
}

export async function previewAlignmentSnapshot(page, expectedPreview) {
  return page.evaluate((expected) => {
    const preview = document.querySelector(".cowart-object-edit-preview");
    const matrix = preview ? getComputedStyle(preview).transform.match(/matrix\(([^)]+)\)/)?.[1]?.split(",").map((item) => Number(item.trim())) ?? null : null;
    const matrixDeltas = matrix ? matrix.map((value, index) => Math.abs(value - expected.matrix[index])) : null;
    return { cssMatrix: matrix, expectedMatrix: expected.matrix, matrixDeltas, width: preview?.getBoundingClientRect().width ?? null, height: preview?.getBoundingClientRect().height ?? null, aligned: Boolean(matrixDeltas?.every((delta) => delta <= 0.75)) };
  }, expectedPreview);
}

export function assertSegmentRange(expect, segment, manifest, label) {
  expect(segment, `${label} segment`).toBeTruthy();
  const width = manifest.file.dimensions.width;
  const height = manifest.file.dimensions.height;
  const area = segment.mask.area / (width * height);
  const bbox = segment.mask.bbox;
  const range = manifest.expectedMask;
  expect(area, `${label} area`).toBeGreaterThanOrEqual(range.areaFractionRange.min);
  expect(area, `${label} area`).toBeLessThanOrEqual(range.areaFractionRange.max);
  expect(bbox.x / width, `${label} xMin`).toBeGreaterThanOrEqual(range.normalizedBboxRange.xMin.min);
  expect(bbox.x / width, `${label} xMin`).toBeLessThanOrEqual(range.normalizedBboxRange.xMin.max);
  expect(bbox.y / height, `${label} yMin`).toBeGreaterThanOrEqual(range.normalizedBboxRange.yMin.min);
  expect(bbox.y / height, `${label} yMin`).toBeLessThanOrEqual(range.normalizedBboxRange.yMin.max);
  expect((bbox.x + bbox.w) / width, `${label} xMax`).toBeGreaterThanOrEqual(range.normalizedBboxRange.xMax.min);
  expect((bbox.x + bbox.w) / width, `${label} xMax`).toBeLessThanOrEqual(range.normalizedBboxRange.xMax.max);
  expect((bbox.y + bbox.h) / height, `${label} yMax`).toBeGreaterThanOrEqual(range.normalizedBboxRange.yMax.min);
  expect((bbox.y + bbox.h) / height, `${label} yMax`).toBeLessThanOrEqual(range.normalizedBboxRange.yMax.max);
}
