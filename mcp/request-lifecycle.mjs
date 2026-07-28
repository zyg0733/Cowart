import { codedError } from "./object-aware-errors.mjs";
import { finiteNumber, nonEmptyString } from "./paths.mjs";

export function requestPrecondition(holderId, expectedRequestId) {
  const requestId = nonEmptyString(expectedRequestId);
  if (!requestId) return null;
  return { id: holderId, field: "meta.cowartRequest.id", equals: requestId };
}

export function currentHolderRequest(holder) {
  const request = holder?.meta?.cowartRequest;
  return request && typeof request === "object" ? request : null;
}

export function currentHolderRequestId(holder) {
  return nonEmptyString(currentHolderRequest(holder)?.id);
}

export function assertExpectedRequest(holder, expectedRequestId, action) {
  const expected = nonEmptyString(expectedRequestId);
  const actual = currentHolderRequestId(holder);
  if (actual && !expected) {
    codedError(
      "expected_request_id_required",
      `Cannot ${action}: holder ${holder.id} has active request ${actual}; expectedRequestId is required.`,
      409,
      { holderId: holder.id, currentRequestId: actual }
    );
  }
  if (!expected) return;
  if (actual !== expected) {
    codedError(
      "request_mismatch",
      `Cannot ${action}: holder ${holder.id} request mismatch (expected ${expected}, current ${actual ?? "none"}).`,
      409,
      { holderId: holder.id, expectedRequestId: expected, currentRequestId: actual ?? null }
    );
  }
}

export function newRequestId() {
  return `cowart-request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function redactRequestError(value) {
  const raw = String(value || "Generation failed.");
  const redacted = raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b(secret|token|api[_ -]?key|password)\b[\w:="' -]*/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return (redacted || "Generation failed.").slice(0, 240);
}

export function requestAttempt(meta) {
  const active = finiteNumber(meta?.cowartRequest?.attempt, null);
  const last = finiteNumber(meta?.cowartLastRequest?.attempt, null);
  return Math.max(active ?? 0, last ?? 0);
}

export function makeCowartRequest(meta, args = {}) {
  const request = {
    id: nonEmptyString(args.requestId) || newRequestId(),
    requestedAt: nonEmptyString(args.requestedAt) || new Date().toISOString(),
    attempt: requestAttempt(meta) + 1,
    kind: nonEmptyString(args.requestKind) || (args.objectAction ? "object_action" : args.variant ? "variant" : "image_generation"),
  };
  if (args.objectAction && typeof args.objectAction === "object") request.objectAction = args.objectAction;
  if (args.variant && typeof args.variant === "object") request.variant = args.variant;
  if (args.decomposition && typeof args.decomposition === "object") request.decomposition = args.decomposition;
  return request;
}

export function archiveRequest(request, fields = {}) {
  if (!request) return null;
  return { ...request, ...fields };
}

export function requestConditionList(holderId, expectedRequestId, extra = []) {
  const condition = requestPrecondition(holderId, expectedRequestId);
  return condition ? [condition, ...extra] : [];
}
