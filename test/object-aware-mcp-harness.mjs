import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import zlib from "node:zlib";

import { encodeCanonicalMaskPng } from "../shared/cowart-segment-mask.mjs";

export const ROOT = resolve(".");
export const MCP = join(ROOT, "mcp", "server.mjs");
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");
export const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

export const imageBytes = () => Buffer.from(PNG_1X1, "base64");
export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
export const maskPng = (width, height, pixels) => encodeCanonicalMaskPng({ width, height, pixels });
export const pathExists = async (path) => access(path).then(() => true, () => false);

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  typeBuffer.copy(header, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuffer, data])) >>> 0, 0);
  return Buffer.concat([header, data, crc]);
}

export function rgbaPng(width, height, rgba = [255, 0, 0, 255]) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      raw[offset] = rgba[0];
      raw[offset + 1] = rgba[1];
      raw[offset + 2] = rgba[2];
      raw[offset + 3] = rgba[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function decodeRgbaAlpha(png) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8);
      assert.equal(data[9], 6);
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const alpha = [];
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    assert.equal(raw[row], 0);
    for (let x = 0; x < width; x += 1) alpha.push(raw[row + 1 + x * 4 + 3]);
  }
  return { width, height, alpha };
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitFor(url) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 15_000) {
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

export async function withViteHarness(fn, options = {}) {
  const canvasDir = await mkdtemp(join(tmpdir(), options.prefix ?? "cowart-object-mcp-"));
  let child = null;
  let childDone = null;
  let output = "";
  let completed = false;
  try {
    const allocatePort = options.allocatePort ?? (async () => freePort());
    const port = await allocatePort({ canvasDir });
    const cowartUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [VITE, "--host", "127.0.0.1", "--port", String(port)], {
      cwd: ROOT,
      env: { ...process.env, COWART_CANVAS_DIR: canvasDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    childDone = new Promise((resolveDone) => {
      child.once("exit", (code, signal) => resolveDone({ code, signal }));
      child.once("error", (error) => resolveDone({ error }));
    });
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    await waitFor(`${cowartUrl}/api/canvas`);
    await fn({ canvasDir, cowartUrl });
    completed = true;
  } finally {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await childDone;
    }
    await rm(canvasDir, { recursive: true, force: true });
    if (completed && child?.exitCode && child.exitCode !== 0 && child.exitCode !== 143) {
      throw new Error(`Vite exited ${child.exitCode}:\n${output}`);
    }
  }
}

function page(id, index = "a1") {
  return { id, typeName: "page", name: id, meta: {}, index };
}

export function imageSnapshot() {
  return {
    schema: { schemaVersion: 2 },
    store: {
      "page:one": page("page:one"),
      "asset:image": {
        id: "asset:image",
        typeName: "asset",
        type: "image",
        props: { name: "pixel.png", src: `data:image/png;base64,${PNG_1X1}`, w: 1, h: 1, mimeType: "image/png" },
        meta: {},
      },
      "shape:image": {
        id: "shape:image", typeName: "shape", type: "image", parentId: "page:one",
        x: 10, y: 20, rotation: 0, index: "a1",
        meta: {},
        props: { assetId: "asset:image", w: 10, h: 10 },
      },
    },
  };
}

export function localImageSnapshot(bytes = imageBytes(), width = 1, height = 1) {
  const snapshot = imageSnapshot();
  snapshot.store["page:two"] = page("page:two", "a2");
  snapshot.store["asset:image"].props = { name: "source.png", src: "/page-assets/one/source.png", w: width, h: height, fileSize: bytes.length, mimeType: "image/png" };
  snapshot.store["asset:image"].meta = { cowartSha256: sha256(bytes) };
  snapshot.store["shape:image"].props = { assetId: "asset:image", w: 20, h: 10 };
  snapshot.store["shape:image"].meta = { cowartCandidateSegments: [{ segmentId: "segment:candidate-meta" }] };
  snapshot.store["shape:candidate"] = {
    id: "shape:candidate", typeName: "shape", type: "geo", parentId: "page:one",
    x: 0, y: 0, rotation: 0, index: "a2",
    meta: { cowartSegmentCandidate: true, segmentId: "segment:candidate-shape" },
    props: { w: 5, h: 5 },
  };
  return snapshot;
}

export async function putSnapshot(cowartUrl, snapshot) {
  const response = await fetch(`${cowartUrl}/api/canvas`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return text ? JSON.parse(text) : {};
}

export async function getCanvas(cowartUrl) {
  const response = await fetch(`${cowartUrl}/api/canvas`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return text ? JSON.parse(text) : {};
}

export async function writeLocalSource(ctx, bytes = imageBytes()) {
  await mkdir(join(ctx.canvasDir, "pages", "one", "assets"), { recursive: true });
  await writeFile(join(ctx.canvasDir, "pages", "one", "assets", "source.png"), bytes);
}

export async function writeSelection(ctx) {
  await writeFile(
    join(ctx.canvasDir, "cowart-selection.json"),
    `${JSON.stringify({ selectedShapes: [{ id: "shape:image" }], updatedAt: "2026-07-18T00:00:00.000Z" }, null, 2)}\n`
  );
}

async function requestJson(url, method, body) {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

export async function confirmSegment(ctx, { segmentId = "segment:confirmed", bytes = imageBytes(), width = 1, height = 1, pixels = Uint8Array.from([255]) } = {}) {
  const result = await requestJson(`${ctx.cowartUrl}/api/canvas/segments/confirm`, "POST", {
    segmentId,
    source: { pageId: "page:one", shapeId: "shape:image", assetId: "asset:image", assetSha256: sha256(bytes), width, height },
    maskBase64: maskPng(width, height, pixels).toString("base64"),
    previewBase64: maskPng(width, height, pixels).toString("base64"),
    selection: { mode: "point", points: [{ x: 0, y: 0, label: "positive" }] },
    provider: { id: "test-provider", runtime: "browser", processing: "local", model: "fixture", version: "1" },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.segment;
}

export async function tree(root) {
  const files = [];
  async function walk(dir) {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(path.slice(root.length + 1));
    }
  }
  await walk(root);
  return files.sort();
}

export async function rpc(messages, { canvasDir, cowartUrl }) {
  const child = spawn(process.execPath, [MCP], {
    cwd: ROOT,
    env: { ...process.env, COWART_CANVAS_DIR: canvasDir, COWART_URL: cowartUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => { stdout.push(chunk.toString()); });
  child.stderr.on("data", (chunk) => { stderr.push(chunk.toString()); });
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  await once(child, "exit");
  assert.equal(child.exitCode, 0, stderr.join(""));
  return stdout.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).sort((left, right) => left.id - right.id);
}

export const call = (id, name, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

export function structured(response) {
  assert.ifError(response.error);
  return response.result.structuredContent;
}
