import { relative, resolve, sep } from "node:path";

export class CowartMcpError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    Object.assign(this, { name: "CowartMcpError", code, status, details });
  }
}

export function codedError(code, message, status = 400, details = {}) {
  throw new CowartMcpError(code, message, status, details);
}

const SAFE_ERROR_NAMES = new Set([
  "CowartMcpError",
  "CowartSegmentStoreError",
  "CowartSegmentMaskError",
  "CowartPageAssetPathError",
]);
const PRIVATE_KEYS = new Set(["stack", "cause"]);
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]+/g,
  /\b(secret|token|api[_ -]?key|password)\b[^\s'",)]*/gi,
];
const FILE_URL_PATTERN = /\bfile:\/\/[^\s'",)]+/gi;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\(?:[^\\\s'",)]+\\?)+/g;
const POSIX_PATH_PATTERN = /(?:^|[\s'"(])((?:\/Users|\/home|\/root|\/tmp|\/var|\/private|\/Volumes|\/mnt|\/opt|\/workspace)\/[^\s'",)]+)/g;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function logicalCanvasPath(value, canvasDir) {
  if (!canvasDir || typeof value !== "string") return null;
  const base = resolve(canvasDir);
  const absolute = resolve(value);
  const rel = relative(base, absolute);
  if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) return null;
  return rel.split(sep).join("/");
}

function replaceCanvasPathPrefixes(value, canvasDir) {
  const base = canvasDir ? resolve(canvasDir) : null;
  if (!base || typeof value !== "string") return value;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value
    .replace(new RegExp(`${escaped.replace(/\\\\/g, "\\\\")}[\\\\/]`, "g"), "")
    .replace(new RegExp(escaped.replace(/\\\\/g, "\\\\"), "g"), ".");
}

function scrubString(value, options = {}) {
  let result = replaceCanvasPathPrefixes(value, nonEmptyString(options.canvasDir));
  result = result.replace(FILE_URL_PATTERN, "[redacted-file-url]");
  result = result.replace(WINDOWS_PATH_PATTERN, "[redacted-path]");
  result = result.replace(POSIX_PATH_PATTERN, (match, path) => match.replace(path, "[redacted-path]"));
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[redacted-secret]");
  return result;
}

export function sanitizePublicValue(value, options = {}, key = null) {
  if (key && PRIVATE_KEYS.has(key)) return undefined;
  if (typeof value === "string") {
    const logical = logicalCanvasPath(value, nonEmptyString(options.canvasDir));
    if (logical && options.preserveCanvasPaths === true) return value;
    return logical ?? scrubString(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePublicValue(item, options)).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "[binary]";
  const clean = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const sanitized = sanitizePublicValue(entryValue, options, entryKey);
    if (sanitized !== undefined) clean[entryKey] = sanitized;
  }
  return clean;
}

export function publicToolResult(result, args = {}) {
  const preserveCanvasPaths = Boolean(nonEmptyString(args?.outputPath) || nonEmptyString(args?.outputDir));
  return sanitizePublicValue(result, { canvasDir: args?.canvasDir, preserveCanvasPaths });
}

export function publicError(error, args = {}) {
  if (SAFE_ERROR_NAMES.has(error?.name)) {
    const details = error.details && typeof error.details === "object" ? error.details : {};
    return {
      message: scrubString(error instanceof Error ? error.message : String(error?.code), args),
      data: {
        code: typeof error.code === "string" ? error.code : "cowart_error",
        status: Number.isInteger(error.status) ? error.status : 400,
        details: sanitizePublicValue(details, args),
      },
    };
  }
  return {
    message: "Cowart MCP tool failed.",
    data: {
      code: "mcp_tool_error",
      status: 400,
      details: {},
    },
  };
}
