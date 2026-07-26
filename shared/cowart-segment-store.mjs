import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { decodeCanonicalMaskPng, encodeCanonicalMaskPng, summarizeSelectionMask } from "./cowart-segment-mask.mjs";

export class CowartSegmentStoreError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    Object.assign(this, { name: "CowartSegmentStoreError", code, status, details });
  }
}

const fail = (code, message, status, details) => {
  throw new CowartSegmentStoreError(code, message, status, details);
};
const idPattern = /^(page|segment|shape|asset):[A-Za-z0-9._:-]{1,160}$/;

function safeId(id, kind) {
  if (typeof id !== "string" || !idPattern.test(id) || id.includes("..") || id.includes("/") || id.includes("\\")) {
    fail("invalid_id", `Invalid ${kind} id.`, 400, { kind });
  }
  return id;
}

function pageDirName(pageId) {
  return encodeURIComponent(safeId(pageId, "page").replace("page:", ""));
}

function segmentDirName(segmentId) {
  return encodeURIComponent(safeId(segmentId, "segment"));
}

function assertChild(parent, child) {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  const pathToChild = relative(resolvedParent, resolvedChild);
  if (!pathToChild || pathToChild.startsWith("..") || pathToChild.includes(`..${sep}`)) {
    fail("path_escape", "Segment path must remain inside the page directory.", 400);
  }
  return resolvedChild;
}

function pageIdFromDirName(name) {
  try {
    const pageId = `page:${decodeURIComponent(name)}`;
    safeId(pageId, "page");
    return pageDirName(pageId) === name ? pageId : null;
  } catch {
    return null;
  }
}

function segmentIdFromDirName(name) {
  try {
    const segmentId = decodeURIComponent(name);
    safeId(segmentId, "segment");
    return segmentDirName(segmentId) === name ? segmentId : null;
  } catch {
    return null;
  }
}

async function rejectSymlinkPath(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  assertChild(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  try {
    if ((await lstat(current)).isSymbolicLink()) fail("path_symlink", "Segment paths may not traverse symlinks.", 400);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const part of relative(resolvedRoot, resolvedTarget).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) fail("path_symlink", "Segment paths may not traverse symlinks.", 400);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
  const [rootReal, targetReal] = await Promise.all([
    realpath(resolvedRoot).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error))),
    realpath(resolvedTarget).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error))),
  ]);
  if (rootReal && targetReal) assertChild(rootReal, targetReal);
}

function manifestFromInput(input, maskPng, previewPng, now) {
  const mask = decodeCanonicalMaskPng(maskPng);
  const preview = decodeCanonicalMaskPng(previewPng);
  if (mask.width !== input.source.width || mask.height !== input.source.height) {
    fail("mask_dimensions_mismatch", "Mask dimensions must match the source asset natural dimensions.", 409, { mask: { width: mask.width, height: mask.height }, source: input.source });
  }
  if (preview.width !== mask.width || preview.height !== mask.height) {
    fail("preview_dimensions_mismatch", "Preview dimensions must match the mask dimensions.", 400);
  }
  const canonicalMask = encodeCanonicalMaskPng(mask);
  const canonicalPreview = encodeCanonicalMaskPng(preview);
  const summary = summarizeSelectionMask(mask);
  return {
    manifest: {
      schemaVersion: 1,
      segmentId: input.segmentId,
      parentSegmentId: input.parentSegmentId ?? null,
      source: input.source,
      mask: { file: "mask.png", sha256: summary.sha256, bbox: summary.bbox, area: summary.area },
      preview: { file: "preview.png" },
      selection: input.selection ?? null,
      provider: input.provider ?? null,
      createdAt: now(),
    },
    canonicalMask,
    canonicalPreview,
  };
}

export function createSegmentStore({ pagesDir, now = () => new Date().toISOString(), publishHooks = {} }) {
  const root = resolve(pagesDir);
  const beforePublish = typeof publishHooks.beforePublish === "function" ? publishHooks.beforePublish : null;
  const pageDir = (pageId) => assertChild(root, join(root, pageDirName(pageId)));
  const segmentsDir = (pageId) => assertChild(pageDir(pageId), join(pageDir(pageId), "segments"));
  const segmentDir = (pageId, segmentId) => assertChild(segmentsDir(pageId), join(segmentsDir(pageId), segmentDirName(segmentId)));
  const manifestFile = (pageId, segmentId) => join(segmentDir(pageId, segmentId), "manifest.json");
  const stagingRoot = () => assertChild(root, join(root, ".cowart-segment-staging"));

  async function findSegment(segmentId) {
    safeId(segmentId, "segment");
    for (const page of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!page.isDirectory()) continue;
      const pageId = pageIdFromDirName(page.name);
      if (!pageId) continue;
      const file = manifestFile(pageId, segmentId);
      try {
        return { pageId, manifest: JSON.parse(await readFile(file, "utf8")) };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    fail("segment_not_found", "Segment not found.", 404, { segmentId });
  }

  async function publish(input) {
    safeId(input.segmentId, "segment");
    const page = pageDir(input.pageId);
    const parent = segmentsDir(input.pageId);
    const target = segmentDir(input.pageId, input.segmentId);
    const stagingParent = stagingRoot();
    await mkdir(root, { recursive: true });
    await rejectSymlinkPath(root, page);
    await mkdir(page, { recursive: true });
    await rejectSymlinkPath(root, page);
    await rejectSymlinkPath(root, parent);
    await mkdir(parent, { recursive: true });
    await rejectSymlinkPath(root, parent);
    try {
      await lstat(target);
      fail("segment_id_conflict", "Segment id already exists.", 409, { segmentId: input.segmentId });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await mkdir(stagingParent, { recursive: true });
    await rejectSymlinkPath(root, stagingParent);
    const staged = assertChild(stagingParent, join(stagingParent, `${process.pid}-${Date.now()}-${randomUUID()}`));
    try {
      const { manifest, canonicalMask, canonicalPreview } = manifestFromInput(input, input.maskPng, input.previewPng, now);
      await mkdir(staged, { recursive: false });
      await writeFile(join(staged, "mask.png"), canonicalMask);
      await writeFile(join(staged, "preview.png"), canonicalPreview);
      await writeFile(join(staged, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      if (beforePublish) await beforePublish({ staged, target, manifest });
      await rename(staged, target);
      return manifest;
    } catch (error) {
      await rm(staged, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  return {
    async confirm(input) {
      return publish({ ...input, parentSegmentId: input.parentSegmentId ?? null });
    },
    async refine(parentSegmentId, input) {
      const parent = await findSegment(parentSegmentId);
      return publish({ ...input, pageId: parent.pageId, parentSegmentId, source: parent.manifest.source });
    },
    async list(filter = {}) {
      const segments = [];
      for (const page of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!page.isDirectory()) continue;
        const pageId = pageIdFromDirName(page.name);
        if (!pageId) continue;
        for (const entry of await readdir(join(root, page.name, "segments"), { withFileTypes: true }).catch(() => [])) {
          if (!entry.isDirectory()) continue;
          const segmentId = segmentIdFromDirName(entry.name);
          if (!segmentId) continue;
          const manifest = JSON.parse(await readFile(manifestFile(pageId, segmentId), "utf8"));
          if (filter.shapeId && manifest.source.shapeId !== filter.shapeId) continue;
          if (filter.assetId && manifest.source.assetId !== filter.assetId) continue;
          segments.push(manifest);
        }
      }
      return segments.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async get(segmentId) {
      return (await findSegment(segmentId)).manifest;
    },
    async binary(segmentId, name) {
      const found = await findSegment(segmentId);
      return readFile(join(segmentDir(found.pageId, segmentId), name));
    },
    async delete(segmentId, referencedSegmentIds = []) {
      const found = await findSegment(segmentId);
      if (referencedSegmentIds.includes(segmentId)) fail("segment_referenced", "Segment is referenced by canvas provenance.", 409, { segmentId });
      const children = (await this.list()).filter((segment) => segment.parentSegmentId === segmentId);
      if (children.length > 0) fail("segment_has_children", "Segment has child refinements.", 409, { segmentId, childSegmentIds: children.map((segment) => segment.segmentId) });
      await rejectSymlinkPath(root, segmentDir(found.pageId, segmentId));
      await rm(segmentDir(found.pageId, segmentId), { recursive: true, force: false });
      return { ok: true, segmentId };
    },
  };
}
