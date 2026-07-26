import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve, join } from "node:path";
import test from "node:test";

const ROOT = resolve(".");
const MCP = join(ROOT, "mcp", "server.mjs");

async function rpc(messages, env = {}) {
  const child = spawn(process.execPath, [MCP], {
    cwd: ROOT,
    env: { ...process.env, ...env },
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
  return stdout.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const call = (id, name, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

const forbiddenFragments = [
  "/Users/agent/secret-token-sk-test.png",
  "/home/agent/Bearer test.jwt.token.png",
  "file:///tmp/github_pat_11AABBCCDDEEFF0011223344556677889900.png",
  "C:\\Users\\agent\\ghp_1234567890abcdefghijklmnop.png",
  "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzZWN5IjoiL3RtcCJ9.signature",
  "eyJhbGciOiJIUzI1NiJ9.eyJzZWN5IjoiL3RtcCJ9.signature",
  "github_pat_11AABBCCDDEEFF0011223344556677889900",
  "ghp_1234567890abcdefghijklmnop",
  "sk-proj-1234567890abcdef",
  "secret-token-sk-test",
  "ENOENT:",
  "stat '/Users/agent",
  "stat /Users/agent",
];

test("Given adversarial imagePath values When MCP returns generic fs errors Then JSON-RPC output is structured and redacted", async () => {
  const inputs = [
    "/Users/agent/secret-token-sk-test.png",
    "/home/agent/Bearer test.jwt.token.png",
    "file:///tmp/github_pat_11AABBCCDDEEFF0011223344556677889900.png",
    "C:\\Users\\agent\\ghp_1234567890abcdefghijklmnop.png",
    "/tmp/Bearer eyJhbGciOiJIUzI1NiJ9.eyJzZWN5IjoiL3RtcCJ9.signature/sk-proj-1234567890abcdef.png",
  ];
  const responses = await rpc(inputs.map((imagePath, index) => call(index + 1, "insert_cowart_image", { imagePath })));

  assert.equal(responses.length, inputs.length);
  for (const response of responses) {
    assert.equal(response.error.code, -32602);
    assert.equal(response.error.message, "Cowart MCP tool failed.");
    assert.equal(response.error.data.code, "mcp_tool_error");
    assert.equal(response.error.data.status, 400);
    assert.equal("stack" in response.error.data.details, false);
    assert.equal("cause" in response.error.data.details, false);
    const payload = JSON.stringify(response);
    for (const fragment of forbiddenFragments) assert.equal(payload.includes(fragment), false, fragment);
  }
});
