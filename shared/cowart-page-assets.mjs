import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export class CowartPageAssetPathError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    Object.assign(this, { name: "CowartPageAssetPathError", code, status, details });
  }
}

const fail = (code, message, status = 400, details = {}) => {
  throw new CowartPageAssetPathError(code, message, status, details);
};

export function cowartPageDirName(pageId, pageIdPrefix = "page:") {
  if (typeof pageId !== "string" || !pageId.startsWith(pageIdPrefix)) {
    fail("invalid_page_id", "Page id is invalid.");
  }
  const idPart = pageId.slice(pageIdPrefix.length);
  let encoded;
  try {
    encoded = encodeURIComponent(idPart);
  } catch {
    fail("invalid_page_id", "Page id is invalid.");
  }
  if (!idPart || idPart === "." || idPart === ".." || idPart.includes("/") || idPart.includes("\\") || encoded !== idPart) {
    fail("invalid_page_id", "Page id is invalid.");
  }
  return encoded;
}

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

function decodePathSegment(segment, kind) {
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    fail("invalid_asset_route", "Asset route is invalid.", 400, { kind });
  }
  if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
    fail("invalid_asset_route", "Asset route is invalid.", 400, { kind });
  }
  return decoded;
}

function decodePathParts(encodedPath, kind) {
  const parts = encodedPath.split("/").filter(Boolean);
  if (parts.length === 0) fail("invalid_asset_route", "Asset route is invalid.", 400, { kind });
  return parts.map((part) => decodePathSegment(part, kind));
}

async function realpathIfExists(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNoSymlinkComponents(root, filePath) {
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(filePath);
  if (!isSafeChildPath(resolvedRoot, resolvedFile)) {
    fail("asset_path_escape", "Asset path must remain inside its asset root.", 403);
  }

  try {
    const rootEntry = await lstat(resolvedRoot);
    if (rootEntry.isSymbolicLink()) fail("asset_path_symlink", "Asset paths may not traverse symlinks.", 403);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let current = resolvedRoot;
  for (const part of relative(resolvedRoot, resolvedFile).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) fail("asset_path_symlink", "Asset paths may not traverse symlinks.", 403);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertRealPathInside(root, filePath) {
  const rootReal = await realpathIfExists(root);
  const fileReal = await realpathIfExists(filePath);
  if (!rootReal || !fileReal) return;
  if (!isSafeChildPath(rootReal, fileReal)) {
    fail("asset_path_escape", "Asset path must remain inside its asset root.", 403);
  }
}

export async function resolveCowartAssetUrlPath(src, options) {
  const {
    globalAssetsDir,
    canvasPagesDir,
    globalAssetsRoute = "/assets/",
    pageAssetsRoute = "/page-assets/",
  } = options;

  let root;
  let symlinkCheckRoot;
  let parts;
  if (src.startsWith(globalAssetsRoute)) {
    root = resolve(globalAssetsDir);
    symlinkCheckRoot = root;
    parts = decodePathParts(src.slice(globalAssetsRoute.length), "global_asset");
  } else if (src.startsWith(pageAssetsRoute)) {
    const routeParts = decodePathParts(src.slice(pageAssetsRoute.length), "page_asset");
    const [pageDir, ...assetParts] = routeParts;
    if (!pageDir || assetParts.length === 0) fail("invalid_asset_route", "Asset route is invalid.", 400, { kind: "page_asset" });
    symlinkCheckRoot = resolve(canvasPagesDir);
    root = resolve(symlinkCheckRoot, pageDir, "assets");
    parts = assetParts;
  } else {
    return null;
  }

  const filePath = resolve(root, ...parts);
  if (!isSafeChildPath(root, filePath)) {
    fail("asset_path_escape", "Asset path must remain inside its asset root.", 403);
  }
  await assertNoSymlinkComponents(symlinkCheckRoot, filePath);
  await assertRealPathInside(root, filePath);
  return filePath;
}

export async function assertCowartAssetWritableDestination(root, filePath) {
  await assertNoSymlinkComponents(root, filePath);
  const resolvedFile = resolve(filePath);
  try {
    const entry = await lstat(resolvedFile);
    if (!entry.isFile()) {
      fail("asset_destination_not_regular", "Asset destination must be a regular file.", 409);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await assertRealPathInside(root, resolvedFile);
}
