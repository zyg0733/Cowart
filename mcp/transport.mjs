import { publicToolResult } from "./object-aware-errors.mjs";

export const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
};

export function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export function sendResult(id, result, args = {}) {
  send({ jsonrpc: "2.0", id, result: publicToolResult(result, args) });
}

export function sendError(id, code, message, data = undefined) {
  send({ jsonrpc: "2.0", id, error: data ? { code, message, data } : { code, message } });
}
