import readline from "node:readline";

import { SERVER_NAME, SERVER_VERSION } from "./constants.mjs";
import { SERVER_INSTRUCTIONS } from "./instructions.mjs";
import { publicError } from "./object-aware-errors.mjs";
import { handleToolCall } from "./server-dispatch.mjs";
import { toolDefinitions } from "./tool-registry.mjs";
import { JsonRpcError, sendError, sendResult } from "./transport.mjs";

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: SERVER_INSTRUCTIONS,
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: toolDefinitions() });
    return;
  }

  if (method === "tools/call") {
    try {
      await handleToolCall(id, params);
    } catch (error) {
      const publicErr = publicError(error, params?.arguments ?? {});
      sendError(id, JsonRpcError.INVALID_PARAMS, publicErr.message, publicErr.data);
    }
    return;
  }

  if (id !== undefined) {
    sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const pendingRequests = new Set();

lines.on("line", (line) => {
  if (line.trim().length === 0) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const request = handleRequest(message).catch((error) => {
    if (message.id !== undefined) {
      const publicErr = publicError(error);
      sendError(message.id, JsonRpcError.INVALID_PARAMS, publicErr.message, publicErr.data);
    }
  });
  pendingRequests.add(request);
  request.finally(() => pendingRequests.delete(request));
});

lines.on("close", async () => {
  await Promise.allSettled([...pendingRequests]);
  process.exit(0);
});
