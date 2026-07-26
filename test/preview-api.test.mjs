import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import test from "node:test";

const ROOT = resolve(".");

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function runCommand(command, args) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, `${command} ${args.join(" ")} failed signal=${signal}\n${output}`);
  return output;
}

async function startPreview(canvasDir) {
  const port = await freePort();
  const cowartUrl = `http://127.0.0.1:${port}`;
  const child = spawn("npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, COWART_CANVAS_DIR: canvasDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
    await waitForJson(`${cowartUrl}/api/canvas`);
    return { child, cowartUrl, output: () => output };
  } catch (error) {
    await stopPreview(child);
    throw new Error(`${error.message}\n${output}`);
  }
}

async function stopPreview(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit").catch(() => {}),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit").catch(() => {});
}

async function waitForJson(url) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 20_000) {
    try {
      const response = await fetch(url);
      if (response.ok && contentType(response).includes("application/json")) return;
      lastError = new Error(`${response.status} ${response.statusText} ${contentType(response)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function contentType(response) {
  return response.headers.get("content-type") ?? "";
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  assert.ok(contentType(response).includes("application/json"), `${url} returned ${contentType(response)}: ${text.slice(0, 80)}`);
  return { response, body: JSON.parse(text) };
}

async function assertBuiltAssetsLoad(cowartUrl) {
  const root = await fetch(cowartUrl);
  assert.equal(root.status, 200);
  const html = await root.text();
  const assetPaths = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(assetPaths.length >= 2, html);
  for (const assetPath of assetPaths) {
    const asset = await fetch(new URL(assetPath, cowartUrl));
    assert.equal(asset.status, 200, assetPath);
    assert.ok(contentType(asset).includes("javascript") || contentType(asset).includes("css"), `${assetPath} ${contentType(asset)}`);
  }
}

test("Given a production preview When Cowart API routes are called Then middleware handles API JSON and SPA assets still load", async () => {
  await runCommand("npm", ["run", "build"]);
  const canvasDir = await mkdtemp(join(tmpdir(), "cowart-preview-api-"));
  const preview = await startPreview(canvasDir);
  try {
    await assertBuiltAssetsLoad(preview.cowartUrl);

    const canvas = await fetchJson(`${preview.cowartUrl}/api/canvas`);
    assert.equal(canvas.response.status, 200);
    assert.equal(canvas.body.storage, "empty");

    const snapshot = { schema: { schemaVersion: 2 }, store: {} };
    const put = await fetchJson(`${preview.cowartUrl}/api/canvas`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    assert.equal(put.response.status, 200);
    assert.equal(put.body.ok, true);

    const segments = await fetchJson(`${preview.cowartUrl}/api/canvas/segments`);
    assert.equal(segments.response.status, 200);
    assert.deepEqual(segments.body.segments, []);
  } finally {
    await stopPreview(preview.child);
    await rm(canvasDir, { recursive: true, force: true });
  }
});
