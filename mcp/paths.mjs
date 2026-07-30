import { lstat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

import { assertCowartAssetWritableDestination, cowartPageDirName } from "../shared/cowart-page-assets.mjs";
import { PAGE_ASSETS_ROUTE, PAGE_ID_PREFIX } from "./constants.mjs";

export function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function pathResolve(value) {
  return resolve(String(value));
}

export function resolveCanvasDir(args = {}) {
  const explicitCanvasDir = nonEmptyString(args.canvasDir);
  if (explicitCanvasDir) return pathResolve(explicitCanvasDir);

  const explicitProjectDir = nonEmptyString(args.projectDir);
  if (explicitProjectDir) return join(pathResolve(explicitProjectDir), "canvas");

  const envCanvasDir = nonEmptyString(process.env.COWART_CANVAS_DIR);
  if (envCanvasDir) return pathResolve(envCanvasDir);

  const envProjectDir = nonEmptyString(process.env.COWART_PROJECT_DIR);
  if (envProjectDir) return join(pathResolve(envProjectDir), "canvas");

  return join(process.cwd(), "canvas");
}

export function resolveSelectionFile(args = {}) {
  return join(resolveCanvasDir(args), "cowart-selection.json");
}

export function resolveViewStateFile(args = {}) {
  return join(resolveCanvasDir(args), "cowart-view-state.json");
}

export function pageDirName(pageId) {
  return cowartPageDirName(pageId, PAGE_ID_PREFIX);
}

export function pageAssetUrl(pageId, fileName) {
  return `${PAGE_ASSETS_ROUTE}${pageDirName(pageId)}/${encodeURIComponent(fileName)}`;
}

export function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

export function sanitizeFileName(name, fallbackName = "image.png") {
  const rawName = basename(String(name || fallbackName));
  const extension = extname(rawName) || extname(fallbackName) || ".png";
  const baseName = rawName
    .slice(0, rawName.length - extname(rawName).length)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${baseName || "image"}${extension}`;
}

export function sanitizeIdPart(value, fallback = "image") {
  return String(value || fallback)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

export function mimeTypeForFile(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".apng":
      return "image/apng";
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

export async function uniqueFilePath(dir, requestedName) {
  const safeName = sanitizeFileName(requestedName);
  const ext = extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);
  let candidate = safeName;
  let counter = 2;
  while (true) {
    const candidatePath = join(dir, candidate);
    await assertCowartAssetWritableDestination(dir, candidatePath);
    try {
      await lstat(candidatePath);
      candidate = `${base}-v${counter}${ext}`;
      counter += 1;
    } catch (error) {
      if (error?.code === "ENOENT") return { fileName: candidate, filePath: candidatePath };
      throw error;
    }
  }
}

export function uniqueRecordId(store, prefix, seed) {
  const cleanSeed = sanitizeIdPart(seed);
  let candidate = `${prefix}:${cleanSeed}`;
  let counter = 2;
  while (store[candidate]) {
    candidate = `${prefix}:${cleanSeed}-${counter}`;
    counter += 1;
  }
  return candidate;
}
