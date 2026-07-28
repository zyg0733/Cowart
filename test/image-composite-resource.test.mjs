import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import test from "node:test";

test("Given a 4K protected composite When run in isolation Then peak RSS stays below 400 MB", async () => {
  const child = spawn(process.execPath, [
    "--expose-gc",
    resolve("test/helpers/image-composite-resource-child.mjs"),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "exit");
  assert.equal(code, 0, Buffer.concat(stderr).toString());
  const result = JSON.parse(Buffer.concat(stdout).toString());
  assert.deepEqual({ width: result.width, height: result.height }, { width: 3840, height: 2160 });
  assert.ok(result.outputBytes > 0);
  assert.ok(result.peakRss < 400 * 1024 * 1024, `peak RSS ${(result.peakRss / 1024 / 1024).toFixed(1)} MB`);
});
