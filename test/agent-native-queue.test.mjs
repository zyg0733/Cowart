import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import net from "node:net";
import test from "node:test";

const ROOT = resolve(".");
const MCP = join(ROOT, "mcp", "server.mjs");
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitFor(url, timeoutMs = 15_000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function withViteHarness(fn) {
  const canvasDir = await mkdtemp(join(tmpdir(), "cowart-agent-native-"));
  const port = await freePort();
  const cowartUrl = `http://127.0.0.1:${port}`;
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, COWART_CANVAS_DIR: canvasDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  try {
    await waitFor(`${cowartUrl}/api/canvas`);
    await fn({ canvasDir, cowartUrl });
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
    await rm(canvasDir, { recursive: true, force: true });
    if (child.exitCode && child.exitCode !== 0 && child.exitCode !== 143) {
      throw new Error(`Vite exited ${child.exitCode}:\n${output}`);
    }
  }
}

async function putSnapshot(cowartUrl, snapshot) {
  const response = await fetch(`${cowartUrl}/api/canvas`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return text ? JSON.parse(text) : {};
}

async function getCanvas(cowartUrl) {
  const response = await fetch(`${cowartUrl}/api/canvas`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return text ? JSON.parse(text) : {};
}

async function writeSelection(canvasDir, selectedShapes) {
  await writeFile(
    join(canvasDir, "cowart-selection.json"),
    `${JSON.stringify({ selectedShapes, updatedAt: "2026-07-11T00:00:00.000Z" }, null, 2)}\n`
  );
}

async function writeViewState(canvasDir, currentPageId = "page:one") {
  await writeFile(
    join(canvasDir, "cowart-view-state.json"),
    `${JSON.stringify({ version: 1, currentPageId, camera: { x: 0, y: 0, z: 1 }, updatedAt: "2026-07-11T00:00:00.000Z" }, null, 2)}\n`
  );
}

function page(id, index = "a1") {
  return { id, typeName: "page", name: id, meta: {}, index };
}

function holder(id, status, index, meta = {}, props = {}) {
  return {
    id,
    typeName: "shape",
    type: "cowart-ai-image",
    x: 0,
    y: 0,
    rotation: 0,
    index,
    parentId: "page:one",
    isLocked: false,
    opacity: 1,
    meta: { cowartAiImageHolder: true, cowartAiImageHolderVersion: 1, ...meta },
    props: { w: 100, h: 80, name: "AI", prompt: id, status, assetId: null, ...props },
  };
}

function baseSnapshot(records) {
  const store = Object.fromEntries([page("page:one"), page("page:two", "a2"), ...records].map((record) => [record.id, record]));
  return { schema: { schemaVersion: 2 }, store };
}

function rpcLine(id, name, args = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function rpc(messages, { canvasDir, cowartUrl }) {
  const child = spawn(process.execPath, [MCP], {
    cwd: ROOT,
    env: { ...process.env, COWART_CANVAS_DIR: canvasDir, COWART_URL: cowartUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => {
    stdout.push(chunk.toString());
  });
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk.toString());
  });
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  await once(child, "exit");
  assert.equal(child.exitCode, 0, stderr.join(""));
  return stdout
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function toolResult(response) {
  assert.ifError(response.error);
  return response.result.structuredContent;
}

function snapshotHash(payload) {
  return createHash("sha256").update(JSON.stringify(payload.snapshot.store)).digest("hex");
}

async function assetInventory(canvasDir) {
  const root = join(canvasDir, "pages");
  const files = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (path.includes(`${join("assets")}`)) files.push(path.replace(`${canvasDir}/`, ""));
    }
  }
  await walk(root);
  return files.sort();
}

async function assertRejectedWithoutCanvasChange(ctx, message, errorPattern) {
  const before = await getCanvas(ctx.cowartUrl);
  const beforeHash = snapshotHash(before);
  const beforeRevision = before.revision;
  const beforeAssets = await assetInventory(ctx.canvasDir);

  const [response] = await rpc([message], ctx);
  assert.ok(response.error, "expected JSON-RPC error");
  assert.match(response.error.message, errorPattern);

  const after = await getCanvas(ctx.cowartUrl);
  assert.equal(after.revision, beforeRevision);
  assert.equal(snapshotHash(after), beforeHash);
  assert.deepEqual(await assetInventory(ctx.canvasDir), beforeAssets);
}

test("request queue projection lists current-page requests in FIFO order and tools/list exposes the tool", async () => {
  await withViteHarness(async (ctx) => {
    await writeViewState(ctx.canvasDir);
    await putSnapshot(
      ctx.cowartUrl,
      baseSnapshot([
        holder("shape:later", "requested", "a2", {
          cowartRequest: { id: "req-later", requestedAt: "2026-07-11T02:00:00.000Z", attempt: 1 },
        }),
        holder("shape:legacy", "requested", "a3"),
        holder("shape:first", "requested", "a1", {
          cowartRequest: { id: "req-first", requestedAt: "2026-07-11T01:00:00.000Z", attempt: 1 },
        }),
        { ...holder("shape:other-page", "requested", "a1"), parentId: "page:two" },
      ])
    );

    const responses = await rpc(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        rpcLine(2, "get_cowart_requests", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir }),
      ],
      ctx
    );

    assert.ok(responses[0].result.tools.some((tool) => tool.name === "get_cowart_requests"));
    const result = toolResult(responses[1]);
    assert.equal(result.currentPageId, "page:one");
    assert.deepEqual(
      result.requests.map((request) => request.holderId),
      ["shape:first", "shape:later", "shape:legacy"]
    );
    assert.deepEqual(
      result.requests.map((request) => request.requestId),
      ["req-first", "req-later", null]
    );
  });
});

test("active request mutations reject omitted expectedRequestId without changing canvas or assets", async () => {
  await withViteHarness(async (ctx) => {
    await writeViewState(ctx.canvasDir);
    const cases = [
      {
        name: "claim",
        record: holder("shape:slot", "requested", "a1", {
          cowartRequest: { id: "req-guard", requestedAt: "2026-07-11T01:00:00.000Z", attempt: 1 },
        }),
        message: rpcLine(1, "update_cowart_holder", {
          cowartUrl: ctx.cowartUrl,
          canvasDir: ctx.canvasDir,
          holderId: "shape:slot",
          status: "generating",
        }),
      },
      {
        name: "fail",
        record: holder("shape:slot", "generating", "a1", {
          cowartRequest: { id: "req-guard", requestedAt: "2026-07-11T01:00:00.000Z", attempt: 1 },
        }),
        message: rpcLine(2, "update_cowart_holder", {
          cowartUrl: ctx.cowartUrl,
          canvasDir: ctx.canvasDir,
          holderId: "shape:slot",
          status: "failed",
          error: "generation failed",
        }),
      },
      {
        name: "cancel",
        record: holder("shape:slot", "generating", "a1", {
          cowartRequest: { id: "req-guard", requestedAt: "2026-07-11T01:00:00.000Z", attempt: 1 },
        }),
        message: rpcLine(3, "update_cowart_holder", {
          cowartUrl: ctx.cowartUrl,
          canvasDir: ctx.canvasDir,
          holderId: "shape:slot",
          status: "empty",
        }),
      },
      {
        name: "replace",
        record: holder("shape:slot", "generating", "a1", {
          cowartRequest: { id: "req-guard", requestedAt: "2026-07-11T01:00:00.000Z", attempt: 1 },
        }),
        message: rpcLine(4, "replace_cowart_image", {
          cowartUrl: ctx.cowartUrl,
          canvasDir: ctx.canvasDir,
          targetShapeId: "shape:slot",
          imageBase64: PNG_1X1,
          fileName: "unguarded-fill.png",
        }),
      },
    ];

    for (const testCase of cases) {
      await putSnapshot(ctx.cowartUrl, baseSnapshot([testCase.record]));
      await assertRejectedWithoutCanvasChange(ctx, testCase.message, /expectedRequestId/i);
      const canvas = await getCanvas(ctx.cowartUrl);
      assert.equal(canvas.snapshot.store["shape:slot"].meta.cowartRequest.id, "req-guard", testCase.name);
    }
  });
});

test("request creation, retry, and legacy no-id claim preserve correlation behavior", async () => {
  await withViteHarness(async (ctx) => {
    await writeViewState(ctx.canvasDir);

    await putSnapshot(ctx.cowartUrl, baseSnapshot([holder("shape:slot", "empty", "a1")]));
    const requested = toolResult(
      (
        await rpc(
          [
            rpcLine(1, "update_cowart_holder", {
              cowartUrl: ctx.cowartUrl,
              canvasDir: ctx.canvasDir,
              holderId: "shape:slot",
              status: "requested",
              requestId: "req-created",
              requestedAt: "2026-07-11T03:00:00.000Z",
            }),
          ],
          ctx
        )
      )[0]
    );
    assert.equal(requested.status, "requested");
    assert.equal(requested.request.id, "req-created");
    assert.equal(requested.request.attempt, 1);

    const retried = toolResult(
      (
        await rpc(
          [
            rpcLine(2, "update_cowart_holder", {
              cowartUrl: ctx.cowartUrl,
              canvasDir: ctx.canvasDir,
              holderId: "shape:slot",
              status: "requested",
              expectedRequestId: "req-created",
              requestId: "req-retry",
              requestedAt: "2026-07-11T03:01:00.000Z",
            }),
          ],
          ctx
        )
      )[0]
    );
    assert.equal(retried.request.id, "req-retry");
    assert.equal(retried.request.attempt, 2);
    assert.equal(retried.lastRequest.id, "req-created");
    assert.ok(retried.lastRequest.supersededAt);

    await putSnapshot(ctx.cowartUrl, baseSnapshot([holder("shape:legacy", "requested", "a1")]));
    const legacyClaim = toolResult(
      (
        await rpc(
          [
            rpcLine(3, "update_cowart_holder", {
              cowartUrl: ctx.cowartUrl,
              canvasDir: ctx.canvasDir,
              holderId: "shape:legacy",
              status: "generating",
            }),
          ],
          ctx
        )
      )[0]
    );
    assert.equal(legacyClaim.status, "generating");
    assert.equal(legacyClaim.request, null);
  });
});

test("request claim/fill preconditions are atomic and stale replacements clean up staged assets", async () => {
  await withViteHarness(async (ctx) => {
    await writeViewState(ctx.canvasDir);
    await putSnapshot(
      ctx.cowartUrl,
      baseSnapshot([
        holder("shape:slot", "requested", "a1", {
          cowartRequest: { id: "req-claim", requestedAt: "2026-07-11T01:00:00.000Z", attempt: 1 },
        }),
      ])
    );
    const claim = rpcLine(1, "update_cowart_holder", {
      cowartUrl: ctx.cowartUrl,
      canvasDir: ctx.canvasDir,
      holderId: "shape:slot",
      status: "generating",
      expectedRequestId: "req-claim",
    });
    const [a, b] = await Promise.all([rpc([claim], ctx), rpc([claim], ctx)]);
    const outcomes = [a[0], b[0]];
    assert.equal(outcomes.filter((response) => !response.error).length, 1);
    assert.equal(outcomes.filter((response) => response.error?.message.includes("request")).length, 1);

    const before = await getCanvas(ctx.cowartUrl);
    const beforeHash = snapshotHash(before);
    const beforeRevision = before.revision;
    const beforeAssets = await assetInventory(ctx.canvasDir);
    const staleFill = await rpc(
      [
        rpcLine(2, "replace_cowart_image", {
          cowartUrl: ctx.cowartUrl,
          canvasDir: ctx.canvasDir,
          targetShapeId: "shape:slot",
          imageBase64: PNG_1X1,
          fileName: "stale-fill.png",
          expectedRequestId: "wrong-request",
        }),
      ],
      ctx
    );
    assert.match(staleFill[0].error?.message, /request/i);
    const after = await getCanvas(ctx.cowartUrl);
    assert.equal(after.revision, beforeRevision);
    assert.equal(snapshotHash(after), beforeHash);
    assert.deepEqual(await assetInventory(ctx.canvasDir), beforeAssets);
  });
});

test("request failed, cancel, and late-fill lifecycle archives active request safely", async () => {
  await withViteHarness(async (ctx) => {
    await writeViewState(ctx.canvasDir);
    await putSnapshot(
      ctx.cowartUrl,
      baseSnapshot([
        holder("shape:slot", "generating", "a1", {
          cowartRequest: {
            id: "req-life",
            requestedAt: "2026-07-11T01:00:00.000Z",
            attempt: 2,
            startedAt: "2026-07-11T01:01:00.000Z",
          },
        }),
      ])
    );
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dGVzdHNpZ25hdHVyZQ"].join(".");
    const githubToken = "ghp_" + "0123456789abcdef0123456789abcdef0123";
    const longError = `secret-token ${"x".repeat(500)} Bearer bearer-token-123 ${jwt} ${githubToken}`;
    const failed = toolResult(
      (
        await rpc(
          [
            rpcLine(1, "update_cowart_holder", {
              cowartUrl: ctx.cowartUrl,
              canvasDir: ctx.canvasDir,
              holderId: "shape:slot",
              status: "failed",
              expectedRequestId: "req-life",
              error: longError,
            }),
          ],
          ctx
        )
      )[0]
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.request.id, "req-life");
    assert.ok(failed.request.failedAt);
    assert.ok(failed.request.error.message.length <= 240);
    assert.doesNotMatch(failed.request.error.message, /secret-token/);
    assert.doesNotMatch(failed.request.error.message, /Bearer\s+\S+/i);
    assert.doesNotMatch(failed.request.error.message, /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
    assert.doesNotMatch(failed.request.error.message, /ghp_[A-Za-z0-9_]+/);

    const cancelled = toolResult(
      (
        await rpc(
          [
            rpcLine(2, "update_cowart_holder", {
              cowartUrl: ctx.cowartUrl,
              canvasDir: ctx.canvasDir,
              holderId: "shape:slot",
              status: "empty",
              expectedRequestId: "req-life",
            }),
          ],
          ctx
        )
      )[0]
    );
    assert.equal(cancelled.request, null);
    assert.equal(cancelled.lastRequest.id, "req-life");
    assert.equal(cancelled.status, "empty");

    const lateFill = await rpc(
      [
        rpcLine(3, "replace_cowart_image", {
          cowartUrl: ctx.cowartUrl,
          canvasDir: ctx.canvasDir,
          targetShapeId: "shape:slot",
          imageBase64: PNG_1X1,
          expectedRequestId: "req-life",
        }),
      ],
      ctx
    );
    assert.match(lateFill[0].error?.message, /request/i);
  });
});

test("request status filters reject invalid values and dryRun never persists or copies", async () => {
  await withViteHarness(async (ctx) => {
    await writeViewState(ctx.canvasDir);
    await putSnapshot(
      ctx.cowartUrl,
      baseSnapshot([
        holder("shape:slot", "requested", "a1", {
          cowartRequest: { id: "req-dry", requestedAt: "2026-07-11T01:00:00.000Z", attempt: 1 },
        }),
      ])
    );

    const badSingleStatus = await rpc(
      [rpcLine(1, "get_cowart_requests", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, status: "bogus" })],
      ctx
    );
    assert.match(badSingleStatus[0].error?.message, /Invalid request status "bogus"/);

    const badStatusList = await rpc(
      [rpcLine(2, "get_cowart_requests", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, statuses: ["requested", "bogus"] })],
      ctx
    );
    assert.match(badStatusList[0].error?.message, /Invalid request status "bogus"/);

    const before = await getCanvas(ctx.cowartUrl);
    const beforeHash = snapshotHash(before);
    const beforeRevision = before.revision;
    const beforeAssets = await assetInventory(ctx.canvasDir);

    const dryClaim = toolResult(
      (
        await rpc(
          [
            rpcLine(3, "update_cowart_holder", {
              cowartUrl: ctx.cowartUrl,
              canvasDir: ctx.canvasDir,
              holderId: "shape:slot",
              status: "generating",
              expectedRequestId: "req-dry",
              dryRun: true,
            }),
          ],
          ctx
        )
      )[0]
    );
    assert.equal(dryClaim.dryRun, true);
    assert.equal(dryClaim.status, "generating");

    const dryReplace = toolResult(
      (
        await rpc(
          [
            rpcLine(4, "replace_cowart_image", {
              cowartUrl: ctx.cowartUrl,
              canvasDir: ctx.canvasDir,
              targetShapeId: "shape:slot",
              imageBase64: PNG_1X1,
              fileName: "dry-run-fill.png",
              expectedRequestId: "req-dry",
              dryRun: true,
            }),
          ],
          ctx
        )
      )[0]
    );
    assert.equal(dryReplace.dryRun, true);
    await assert.rejects(stat(dryReplace.assetFile), { code: "ENOENT" });

    const after = await getCanvas(ctx.cowartUrl);
    assert.equal(after.revision, beforeRevision);
    assert.equal(snapshotHash(after), beforeHash);
    assert.deepEqual(await assetInventory(ctx.canvasDir), beforeAssets);
  });
});

test("annotation filters target, explicit ids, and selected shapes without changing unfiltered current-page behavior", async () => {
  await withViteHarness(async (ctx) => {
    await writeViewState(ctx.canvasDir);
    const targetA = {
      id: "shape:target-a",
      typeName: "shape",
      type: "geo",
      x: 0,
      y: 0,
      rotation: 0,
      index: "a1",
      parentId: "page:one",
      isLocked: false,
      opacity: 1,
      meta: {},
      props: { w: 100, h: 100, richText: { type: "doc", content: [] } },
    };
    const targetB = { ...targetA, id: "shape:target-b", x: 200, index: "a2" };
    const arrow = (id, x, endX, text, index) => ({
      id,
      typeName: "shape",
      type: "arrow",
      x,
      y: 10,
      rotation: 0,
      index,
      parentId: "page:one",
      isLocked: false,
      opacity: 1,
      meta: { cowartAnnotationArrow: true },
      props: {
        start: { x: 0, y: 0 },
        end: { x: endX, y: 40 },
        richText: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
      },
    });
    await putSnapshot(
      ctx.cowartUrl,
      baseSnapshot([
        targetA,
        targetB,
        arrow("shape:ann-a1", -30, 80, "edit A", "a3"),
        arrow("shape:ann-b", 170, 80, "edit B", "a4"),
        arrow("shape:ann-a2", -20, 70, "second A", "a5"),
      ])
    );

    const unfiltered = toolResult((await rpc([rpcLine(1, "get_cowart_annotations", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir })], ctx))[0]);
    assert.deepEqual(
      unfiltered.annotations.map((annotation) => annotation.id),
      ["shape:ann-a1", "shape:ann-b", "shape:ann-a2"]
    );

    const byTarget = toolResult(
      (await rpc([rpcLine(2, "get_cowart_annotations", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, targetShapeId: "shape:target-a" })], ctx))[0]
    );
    assert.deepEqual(
      byTarget.annotations.map((annotation) => annotation.id),
      ["shape:ann-a1", "shape:ann-a2"]
    );

    const byIds = toolResult(
      (
        await rpc(
          [rpcLine(3, "get_cowart_annotations", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, annotationIds: ["shape:ann-b", "shape:ann-a2"] })],
          ctx
        )
      )[0]
    );
    assert.deepEqual(
      byIds.annotations.map((annotation) => annotation.id),
      ["shape:ann-b", "shape:ann-a2"]
    );

    await writeSelection(ctx.canvasDir, [{ id: "shape:target-b", type: "geo" }, { id: "shape:ann-a2", type: "arrow" }]);
    const selected = toolResult(
      (await rpc([rpcLine(4, "get_cowart_annotations", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, selectedOnly: true })], ctx))[0]
    );
    assert.deepEqual(
      selected.annotations.map((annotation) => annotation.id),
      ["shape:ann-b", "shape:ann-a2"]
    );

    await writeSelection(ctx.canvasDir, []);
    const empty = toolResult(
      (await rpc([rpcLine(5, "get_cowart_annotations", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, selectedOnly: true })], ctx))[0]
    );
    assert.deepEqual(empty.annotations, []);
  });
});

test("annotation holder compatibility exports and masks filled custom holders and rejects unfilled holders precisely", async () => {
  await withViteHarness(async (ctx) => {
    await writeViewState(ctx.canvasDir);
    const assetPath = join(ctx.canvasDir, "pages", "one", "assets", "pixel.png");
    await mkdir(join(ctx.canvasDir, "pages", "one", "assets"), { recursive: true });
    await writeFile(assetPath, Buffer.from(PNG_1X1, "base64"));
    await putSnapshot(
      ctx.cowartUrl,
      baseSnapshot([
        {
          id: "asset:pixel",
          typeName: "asset",
          type: "image",
          meta: {},
          props: { name: "pixel.png", src: "/page-assets/one/pixel.png", w: 1, h: 1, fileSize: 68, mimeType: "image/png", isAnimated: false },
        },
        holder("shape:filled", "filled", "a1", {}, { assetId: "asset:pixel", w: 10, h: 10 }),
        holder("shape:empty", "empty", "a2"),
      ])
    );

    const exported = toolResult(
      (
        await rpc(
          [rpcLine(1, "export_cowart_view", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, targetShapeId: "shape:filled", outputPath: join(ctx.canvasDir, "exports", "holder.png") })],
          ctx
        )
      )[0]
    );
    assert.equal(exported.strategy, "asset");
    assert.equal((await stat(exported.outputPath)).size, Buffer.from(PNG_1X1, "base64").length);

    const mask = toolResult(
      (
        await rpc(
          [
            rpcLine(2, "make_cowart_mask", {
              cowartUrl: ctx.cowartUrl,
              canvasDir: ctx.canvasDir,
              targetShapeId: "shape:filled",
              region: { x: 0, y: 0, w: 5, h: 5 },
              outputDir: join(ctx.canvasDir, "masks"),
              maskFileName: "holder-mask.png",
            }),
          ],
          ctx
        )
      )[0]
    );
    assert.equal(mask.sourceImageFile, assetPath);
    assert.equal((await stat(mask.maskFile)).size > 0, true);

    const safeMaskDir = join(ctx.canvasDir, "safe-masks");
    const traversalMask = toolResult(
      (
        await rpc(
          [
            rpcLine(3, "make_cowart_mask", {
              cowartUrl: ctx.cowartUrl,
              canvasDir: ctx.canvasDir,
              targetShapeId: "shape:filled",
              region: { x: 0, y: 0, w: 5, h: 5 },
              outputDir: safeMaskDir,
              maskFileName: "../escape.png",
            }),
          ],
          ctx
        )
      )[0]
    );
    assert.equal(traversalMask.maskFile, join(safeMaskDir, "escape.png"));
    assert.equal((await stat(traversalMask.maskFile)).size > 0, true);
    await assert.rejects(stat(join(safeMaskDir, "..", "escape.png")), { code: "ENOENT" });

    const emptyExport = await rpc(
      [rpcLine(4, "export_cowart_view", { cowartUrl: ctx.cowartUrl, canvasDir: ctx.canvasDir, targetShapeId: "shape:empty" })],
      ctx
    );
    assert.match(emptyExport[0].error?.message, /holder .*not filled/i);
  });
});
