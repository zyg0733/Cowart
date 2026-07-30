import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { decodeCanonicalMaskPng } from "../shared/cowart-segment-mask.mjs";
import { codedError } from "./object-aware-errors.mjs";

const DEFAULT_SIDECAR_URL = "http://127.0.0.1:43219";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function configuredSidecarUrl(args = {}) {
  const explicit = typeof args.sidecarUrl === "string" ? args.sidecarUrl.trim() : "";
  const environment = typeof process.env.COWART_SIDECAR_URL === "string" ? process.env.COWART_SIDECAR_URL.trim() : "";
  if (!explicit && !environment && args.provider !== "sidecar") return null;
  const value = explicit || environment || DEFAULT_SIDECAR_URL;
  let url;
  try {
    url = new URL(value);
  } catch {
    codedError("invalid_sidecar_url", "sidecarUrl must be a valid loopback HTTP URL.", 400);
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash) {
    codedError("invalid_sidecar_url", "Cowart Sidecar only accepts loopback HTTP URLs.", 400, { hostname: url.hostname });
  }
  return url.href.replace(/\/+$/, "");
}

function configuredTokenFile(args = {}) {
  const explicit = typeof args.sidecarTokenFile === "string" ? args.sidecarTokenFile.trim() : "";
  const environment = typeof process.env.COWART_SIDECAR_TOKEN_FILE === "string" ? process.env.COWART_SIDECAR_TOKEN_FILE.trim() : "";
  return resolve(explicit || environment || join(homedir(), ".cowart", "sidecar", "token"));
}

async function readSidecarToken(args) {
  const tokenFile = configuredTokenFile(args);
  let info;
  try {
    info = await lstat(tokenFile);
  } catch (error) {
    if (error?.code === "ENOENT") {
      codedError("sidecar_not_setup", "Cowart Sidecar token is missing. Run npm run sidecar:setup.", 503);
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
    codedError("insecure_sidecar_token", "Cowart Sidecar token must be a regular 0600 file.", 503);
  }
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (token.length < 32) codedError("invalid_sidecar_token", "Cowart Sidecar token is invalid.", 503);
  return token;
}

function normalizedPoints(points) {
  if (!Array.isArray(points)) return [];
  return points.slice(0, 64).map((point) => ({
    x: Number(point?.x),
    y: Number(point?.y),
    label: point?.label === 0 || point?.label === "negative" ? 0 : 1,
  }));
}

function normalizedBox(box) {
  if (!box || typeof box !== "object") return null;
  if (Number.isFinite(box.x) && Number.isFinite(box.y) && Number.isFinite(box.w) && Number.isFinite(box.h)) {
    return { x: box.x, y: box.y, w: box.w, h: box.h };
  }
  if (Number.isFinite(box.x1) && Number.isFinite(box.y1) && Number.isFinite(box.x2) && Number.isFinite(box.y2)) {
    return { x: box.x1, y: box.y1, w: box.x2 - box.x1, h: box.y2 - box.y1 };
  }
  return null;
}

function requestPayload(args, imageBase64) {
  const mode = ["point", "box", "text", "automatic"].includes(args.mode) ? args.mode : "point";
  const payload = {
    mode,
    imageBase64,
    maxCandidates: Math.max(1, Math.min(8, Math.round(Number(args.maxCandidates) || 8))),
  };
  if (mode === "point") payload.points = normalizedPoints(args.points);
  if (mode === "box") payload.box = normalizedBox(args.box);
  if (mode === "text") payload.prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  return payload;
}

function publicCandidate(candidate, returnBase64) {
  const result = {
    candidateId: typeof candidate?.candidateId === "string" ? candidate.candidateId : null,
    score: Number.isFinite(candidate?.score) ? candidate.score : null,
    label: typeof candidate?.label === "string" ? candidate.label : null,
    bbox: candidate?.bbox ?? null,
    area: Number.isFinite(candidate?.area) ? candidate.area : null,
  };
  if (returnBase64) result.maskBase64 = candidate.maskBase64;
  return result;
}

export function sidecarIsConfigured(args = {}) {
  return configuredSidecarUrl(args) !== null;
}

export async function callSegmentationSidecar(args, sourceBytes, source, { timeoutMs = 120_000 } = {}) {
  const baseUrl = configuredSidecarUrl(args);
  if (!baseUrl) return null;
  const token = await readSidecarToken(args);
  const controller = new AbortController();
  const cancelFromCaller = () => controller.abort(args.signal?.reason);
  if (args.signal) {
    if (args.signal.aborted) cancelFromCaller();
    else args.signal.addEventListener("abort", cancelFromCaller, { once: true });
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Cowart Sidecar timed out."));
  }, timeoutMs);
  let response;
  let text;
  try {
    response = await fetch(`${baseUrl}/v1/segment`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestPayload(args, sourceBytes.toString("base64"))),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (args.signal?.aborted) codedError("sidecar_cancelled", "Cowart Sidecar request was cancelled.", 499);
    if (timedOut || error?.name === "AbortError") codedError("sidecar_timeout", "Cowart Sidecar timed out.", 504);
    codedError("sidecar_unavailable", "Cowart Sidecar is unavailable.", 503, { cause: error?.message ?? String(error) });
  } finally {
    clearTimeout(timeout);
    args.signal?.removeEventListener("abort", cancelFromCaller);
  }
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    codedError("invalid_sidecar_response", "Cowart Sidecar returned invalid JSON.", 502);
  }
  if (!response.ok) {
    const code = payload?.detail?.code || payload?.code || "sidecar_request_failed";
    const message = payload?.detail?.message || payload?.message || `Cowart Sidecar returned HTTP ${response.status}.`;
    codedError(code, message, response.status >= 500 ? 502 : response.status, { sidecarStatus: response.status });
  }
  if (payload?.naturalSize?.width !== source.width || payload?.naturalSize?.height !== source.height) {
    codedError("sidecar_size_mismatch", "Cowart Sidecar response dimensions do not match the source image.", 502);
  }
  if (!Array.isArray(payload?.candidates) || payload.candidates.length === 0 || payload.candidates.length > 8) {
    codedError("invalid_sidecar_response", "Cowart Sidecar returned no usable candidates.", 502);
  }
  const candidates = payload.candidates.map((candidate, index) => {
    if (typeof candidate?.maskBase64 !== "string" || candidate.maskBase64.length === 0) {
      codedError("invalid_sidecar_response", "Cowart Sidecar candidate is missing maskBase64.", 502, { index });
    }
    let maskPng;
    try {
      maskPng = Buffer.from(candidate.maskBase64.replace(/^data:image\/png;base64,/i, ""), "base64");
      const decoded = decodeCanonicalMaskPng(maskPng);
      if (decoded.width !== source.width || decoded.height !== source.height) {
        codedError("sidecar_size_mismatch", "Cowart Sidecar mask dimensions do not match the source image.", 502, { index });
      }
    } catch (error) {
      if (error?.code) throw error;
      codedError("invalid_sidecar_mask", "Cowart Sidecar returned an invalid mask PNG.", 502, { index });
    }
    return { ...candidate, maskPng };
  });
  return {
    provider: {
      id: "cowart-sidecar",
      runtime: "python",
      processing: "local",
      model: typeof payload?.provider?.model === "string" ? payload.provider.model : "sam2.1-hiera-tiny",
      version: typeof payload?.provider?.version === "string" ? payload.provider.version : null,
      device: typeof payload?.provider?.device === "string" ? payload.provider.device : null,
    },
    candidates,
    publicCandidates: candidates.map((candidate) => publicCandidate(candidate, args.returnBase64 === true)),
  };
}
