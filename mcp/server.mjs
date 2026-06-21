import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import readline from "node:readline";
import { generateKeyBetween } from "fractional-indexing";

const SERVER_NAME = "Cowart MCP";
const SERVER_VERSION = "0.2.0";
const TOOL_GET_SELECTION = "get_cowart_selection";
const TOOL_INSERT_IMAGE = "insert_cowart_image";
const TOOL_GET_CANVAS = "get_cowart_canvas";
const TOOL_GET_ANNOTATIONS = "get_cowart_annotations";
const TOOL_CREATE_HOLDER = "create_cowart_image_holder";
const TOOL_REPLACE_IMAGE = "replace_cowart_image";
const TOOL_EXPORT_VIEW = "export_cowart_view";
const AI_IMAGE_HOLDER_LABEL = "AI 图片";
const AI_IMAGE_HOLDER_DEFAULT_W = 320;
const AI_IMAGE_HOLDER_DEFAULT_H = 220;
const PAGE_ID_PREFIX = "page:";
const PAGE_ASSETS_ROUTE = "/page-assets/";
const CANVAS_FILE_NAME = "cowart-canvas.json";

const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function resolveCanvasDir(args = {}) {
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

function pathResolve(value) {
  return resolve(String(value));
}

function resolveSelectionFile(args = {}) {
  return join(resolveCanvasDir(args), "cowart-selection.json");
}

function resolveViewStateFile(args = {}) {
  return join(resolveCanvasDir(args), "cowart-view-state.json");
}

function pageDirName(pageId) {
  return encodeURIComponent(pageId.replace(PAGE_ID_PREFIX, ""));
}

function pageAssetUrl(pageId, fileName) {
  return `${PAGE_ASSETS_ROUTE}${pageDirName(pageId)}/${encodeURIComponent(fileName)}`;
}

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

function sanitizeFileName(name, fallbackName = "image.png") {
  const rawName = basename(String(name || fallbackName));
  const extension = extname(rawName) || extname(fallbackName) || ".png";
  const baseName = rawName
    .slice(0, rawName.length - extname(rawName).length)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${baseName || "image"}${extension}`;
}

function sanitizeIdPart(value, fallback = "image") {
  return String(value || fallback)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function mimeTypeForFile(filePath) {
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

async function uniqueFilePath(dir, requestedName) {
  const safeName = sanitizeFileName(requestedName);
  const ext = extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);
  let candidate = safeName;
  let counter = 2;
  while (true) {
    const candidatePath = join(dir, candidate);
    try {
      await stat(candidatePath);
      candidate = `${base}-v${counter}${ext}`;
      counter += 1;
    } catch (error) {
      if (error?.code === "ENOENT") return { fileName: candidate, filePath: candidatePath };
      throw error;
    }
  }
}

function uniqueRecordId(store, prefix, seed) {
  const cleanSeed = sanitizeIdPart(seed);
  let candidate = `${prefix}:${cleanSeed}`;
  let counter = 2;
  while (store[candidate]) {
    candidate = `${prefix}:${cleanSeed}-${counter}`;
    counter += 1;
  }
  return candidate;
}

async function readSelectionState(args) {
  const selectionFile = resolveSelectionFile(args);
  try {
    const selection = JSON.parse(await readFile(selectionFile, "utf8"));
    if (!selection || typeof selection !== "object" || !Array.isArray(selection.selectedShapes)) {
      throw new Error(`Invalid selection state in ${selectionFile}`);
    }
    return { selection, selectionFile };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        selection: { selectedShapes: [], updatedAt: null },
        selectionFile,
      };
    }
    throw error;
  }
}

async function readViewState(args) {
  const viewStateFile = resolveViewStateFile(args);
  try {
    const payload = JSON.parse(await readFile(viewStateFile, "utf8"));
    return payload?.viewState ?? payload;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function normalizeCowartUrl(args = {}) {
  const value = nonEmptyString(args.cowartUrl) || nonEmptyString(process.env.COWART_URL) || "http://127.0.0.1:43217";
  return value.replace(/\/+$/, "");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function loadCanvasSnapshot(args) {
  const cowartUrl = normalizeCowartUrl(args);
  const payload = await fetchJson(`${cowartUrl}/api/canvas`);
  const snapshot = payload?.snapshot ?? payload;
  if (!snapshot || typeof snapshot !== "object" || !snapshot.schema || !snapshot.store) {
    throw new Error(`Expected Cowart canvas snapshot from ${cowartUrl}/api/canvas`);
  }
  return { cowartUrl, snapshot, payload };
}

async function saveCanvasSnapshot(cowartUrl, snapshot) {
  return fetchJson(`${cowartUrl}/api/canvas`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot),
  });
}

async function mergeCanvasRecords(cowartUrl, patch) {
  return fetchJson(`${cowartUrl}/api/canvas/records`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

function getRecord(store, id, label) {
  const record = store[id];
  if (!record) throw new Error(`Missing ${label}: ${id}`);
  return record;
}

function findPageIdForShape(store, shapeId) {
  let record = getRecord(store, shapeId, "shape");
  const visited = new Set();
  while (record && !visited.has(record.id)) {
    visited.add(record.id);
    if (record.typeName === "page") return record.id;
    const parentId = record.parentId;
    if (!parentId) break;
    const parent = store[parentId];
    if (parent?.typeName === "page") return parent.id;
    record = parent;
  }
  return null;
}

function getPageShapes(store, pageId) {
  const shapes = [];
  const byParent = new Map();
  for (const record of Object.values(store)) {
    if (record?.typeName !== "shape") continue;
    const siblings = byParent.get(record.parentId) ?? [];
    siblings.push(record);
    byParent.set(record.parentId, siblings);
  }
  const queue = [...(byParent.get(pageId) ?? [])];
  while (queue.length > 0) {
    const shape = queue.shift();
    shapes.push(shape);
    queue.push(...(byParent.get(shape.id) ?? []));
  }
  return shapes;
}

function localBoundsForShape(shape) {
  if (!shape || shape.typeName !== "shape") return null;
  if (shape.type === "arrow") {
    const start = shape.props?.start ?? { x: 0, y: 0 };
    const end = shape.props?.end ?? { x: 0, y: 0 };
    const minX = Math.min(start.x ?? 0, end.x ?? 0);
    const minY = Math.min(start.y ?? 0, end.y ?? 0);
    const maxX = Math.max(start.x ?? 0, end.x ?? 0);
    const maxY = Math.max(start.y ?? 0, end.y ?? 0);
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }
  const w = finiteNumber(shape.props?.w, shape.type === "text" ? 160 : 1);
  const h = finiteNumber(shape.props?.h, shape.type === "text" ? 40 : 1);
  return { x: 0, y: 0, w, h };
}

function pageBoundsForShape(store, shape) {
  const local = localBoundsForShape(shape);
  if (!local) return null;
  let x = finiteNumber(shape.x, 0) + local.x;
  let y = finiteNumber(shape.y, 0) + local.y;
  let parent = store[shape.parentId];
  const visited = new Set([shape.id]);
  while (parent?.typeName === "shape" && !visited.has(parent.id)) {
    visited.add(parent.id);
    x += finiteNumber(parent.x, 0);
    y += finiteNumber(parent.y, 0);
    parent = store[parent.parentId];
  }
  return { x, y, w: local.w, h: local.h };
}

function rectsOverlap(a, b, padding = 0) {
  return !(
    a.x + a.w + padding <= b.x ||
    b.x + b.w + padding <= a.x ||
    a.y + a.h + padding <= b.y ||
    b.y + b.h + padding <= a.y
  );
}

function chooseIndex(store, parentId) {
  const siblingIndexes = Object.values(store)
    .filter((record) => record?.typeName === "shape" && record.parentId === parentId && typeof record.index === "string")
    .map((record) => record.index)
    .sort();
  return generateKeyBetween(siblingIndexes.at(-1) ?? null, null);
}

function firstSelectedShapeId(selection) {
  return selection?.selectedShapes?.length === 1 ? selection.selectedShapes[0]?.id : null;
}

function choosePlacement({ store, pageId, parentId, anchorShape, width, height, margin, placement }) {
  const anchorBounds = anchorShape ? pageBoundsForShape(store, anchorShape) : null;
  let x = anchorBounds ? anchorBounds.x + anchorBounds.w + margin : 0;
  let y = anchorBounds ? anchorBounds.y : 0;

  if (placement === "left" && anchorBounds) x = anchorBounds.x - width - margin;
  if (placement === "below" && anchorBounds) {
    x = anchorBounds.x;
    y = anchorBounds.y + anchorBounds.h + margin;
  }

  const pageShapes = getPageShapes(store, pageId);
  const obstacles = pageShapes
    .filter((shape) => shape.parentId === parentId && shape.id !== anchorShape?.id)
    .map((shape) => pageBoundsForShape(store, shape))
    .filter(Boolean);

  const stepX = Math.max(width + margin, 1);
  const stepY = Math.max(height + margin, 1);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = { x, y, w: width, h: height };
    if (!obstacles.some((bounds) => rectsOverlap(candidate, bounds, margin / 2))) return candidate;
    if (placement === "below") y += stepY;
    else if (placement === "left") x -= stepX;
    else x += stepX;
  }

  return { x, y, w: width, h: height };
}

async function getImageDimensions(filePath) {
  const buffer = await readFile(filePath);
  if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + size;
    }
  }
  if (buffer.length >= 16 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
    // Lossy WebP: VP8 bitstream with start code 0x9d 0x01 0x2a, then 14-bit LE dims.
    if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    // Lossless WebP: VP8L, signature byte 0x2f, then 14-bit (width-1) and (height-1).
    if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
      const b1 = buffer[21];
      const b2 = buffer[22];
      const b3 = buffer[23];
      const b4 = buffer[24];
      return {
        width: 1 + (b1 | ((b2 & 0x3f) << 8)),
        height: 1 + (((b2 & 0xc0) >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
      };
    }
  }
  throw new Error(`Could not read image dimensions for ${filePath}. Pass displayWidth/displayHeight and use a PNG/JPEG/WebP source.`);
}

async function insertCowartImage(args = {}) {
  const imagePath = nonEmptyString(args.imagePath);
  if (!imagePath) throw new Error("imagePath is required.");

  const sourceImagePath = pathResolve(imagePath);
  const sourceStat = await stat(sourceImagePath);
  if (!sourceStat.isFile()) throw new Error(`imagePath is not a file: ${sourceImagePath}`);

  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const { selection } = await readSelectionState(args);
  const viewState = await readViewState(args);

  const anchorShapeId = nonEmptyString(args.anchorShapeId) || nonEmptyString(args.sourceShapeId) || firstSelectedShapeId(selection);
  const anchorShape = anchorShapeId ? getRecord(store, anchorShapeId, "anchor shape") : null;
  const pageId =
    nonEmptyString(args.pageId) ||
    (anchorShape ? findPageIdForShape(store, anchorShape.id) : null) ||
    nonEmptyString(viewState?.currentPageId) ||
    Object.values(store).find((record) => record?.typeName === "page")?.id;
  if (!pageId || !store[pageId]) throw new Error("Could not determine target pageId.");

  const fillAnchor = args.fillAnchor === true && Boolean(anchorShape);
  const anchorIsFrame = anchorShape?.type === "frame";

  // Holder fill: image becomes a child of (frame holder) or an overlay on
  // (legacy geo holder) the anchor. Otherwise it is placed beside the anchor.
  const parentId = fillAnchor
    ? anchorIsFrame
      ? anchorShape.id
      : nonEmptyString(anchorShape.parentId) ?? pageId
    : anchorShape?.parentId && store[anchorShape.parentId]?.typeName === "page"
      ? anchorShape.parentId
      : pageId;
  if (!store[parentId]) throw new Error(`Could not determine target parent: ${parentId}`);

  let imageSize = null;
  try {
    imageSize = await getImageDimensions(sourceImagePath);
  } catch {
    imageSize = null; // fall back to anchor / explicit dimensions below
  }

  const anchorBounds = anchorShape ? pageBoundsForShape(store, anchorShape) : null;
  const matchAnchor = args.matchAnchor !== false && Boolean(anchorBounds);
  const explicitWidth = finiteNumber(args.displayWidth, null);
  const explicitHeight = finiteNumber(args.displayHeight, null);
  // Holder fill uses the holder's own (local) size; beside-placement matches the
  // anchor's page bounds. Explicit display dimensions always win.
  const holderWidth = finiteNumber(anchorShape?.props?.w, null);
  const holderHeight = finiteNumber(anchorShape?.props?.h, null);

  let width;
  let height;
  if (fillAnchor) {
    width = explicitWidth ?? holderWidth ?? anchorBounds?.w ?? (imageSize ? Math.min(imageSize.width, 512) : null);
    height =
      explicitHeight ??
      holderHeight ??
      anchorBounds?.h ??
      (imageSize && width ? Math.round(width * (imageSize.height / imageSize.width)) : null);
  } else if (matchAnchor) {
    width = explicitWidth ?? anchorBounds.w;
    height = explicitHeight ?? anchorBounds.h;
  } else if (imageSize) {
    width = explicitWidth ?? Math.min(imageSize.width, 512);
    height = explicitHeight ?? Math.round(width * (imageSize.height / imageSize.width));
  } else if (explicitWidth && explicitHeight) {
    width = explicitWidth;
    height = explicitHeight;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(
      `Could not determine display size for ${sourceImagePath}. Provide displayWidth and displayHeight, anchor to an existing shape, or use a PNG/JPEG/WebP source.`
    );
  }
  const naturalSize = imageSize ?? { width: Math.round(width), height: Math.round(height) };

  const margin = Math.max(0, finiteNumber(args.margin, 40));
  const placement = ["right", "left", "below"].includes(args.placement) ? args.placement : "right";

  let posX;
  let posY;
  let rotation;
  if (fillAnchor) {
    if (anchorIsFrame) {
      posX = 0;
      posY = 0;
      rotation = 0;
    } else {
      posX = finiteNumber(anchorShape.x, 0);
      posY = finiteNumber(anchorShape.y, 0);
      rotation = finiteNumber(anchorShape.rotation, 0);
    }
  } else {
    const placed = choosePlacement({ store, pageId, parentId, anchorShape, width, height, margin, placement });
    posX = placed.x;
    posY = placed.y;
    rotation = 0;
  }
  const bounds = { x: posX, y: posY, w: width, h: height };

  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "pages", pageDirName(pageId), "assets");
  if (!isSafeChildPath(resolveCanvasDir(args), assetsDir)) {
    throw new Error(`Unsafe page assets directory: ${assetsDir}`);
  }
  const { fileName, filePath } = await uniqueFilePath(assetsDir, args.fileName || basename(sourceImagePath));
  const recordSeed = sanitizeIdPart(fileName);
  const assetId = uniqueRecordId(store, "asset", recordSeed);
  const shapeId = uniqueRecordId(store, "shape", recordSeed);
  const index = chooseIndex(store, parentId);
  const mimeType = mimeTypeForFile(fileName);

  const assetRecord = {
    id: assetId,
    typeName: "asset",
    type: "image",
    props: {
      name: fileName,
      src: pageAssetUrl(pageId, fileName),
      w: naturalSize.width,
      h: naturalSize.height,
      fileSize: sourceStat.size,
      mimeType,
      isAnimated: false,
    },
    meta: args.assetMeta && typeof args.assetMeta === "object" ? args.assetMeta : {},
  };

  const shapeMeta = args.shapeMeta && typeof args.shapeMeta === "object" ? { ...args.shapeMeta } : {};
  if (fillAnchor && anchorShapeId && !shapeMeta.cowartGeneratedForAiImageHolder) {
    shapeMeta.cowartGeneratedForAiImageHolder = anchorShapeId;
  }
  if (!fillAnchor && anchorShapeId && !shapeMeta.cowartAnnotationSourceShapeId) {
    shapeMeta.cowartAnnotationSourceShapeId = anchorShapeId;
  }
  if (nonEmptyString(args.annotationScreenshot) && !shapeMeta.cowartAnnotationScreenshot) {
    shapeMeta.cowartAnnotationScreenshot = nonEmptyString(args.annotationScreenshot);
  }

  const shapeRecord = {
    x: bounds.x,
    y: bounds.y,
    rotation,
    isLocked: false,
    opacity: 1,
    meta: shapeMeta,
    id: shapeId,
    type: "image",
    props: {
      w: width,
      h: height,
      assetId,
      playing: true,
      url: "",
      crop: null,
      flipX: false,
      flipY: false,
      altText: nonEmptyString(args.altText) || "Cowart inserted image",
    },
    parentId,
    index,
    typeName: "shape",
  };

  if (!args.dryRun) {
    await mkdir(assetsDir, { recursive: true });
    await copyFile(sourceImagePath, filePath);
    try {
      // Merge just the new records into the server's current snapshot so a
      // concurrent browser save is not overwritten by our stale read.
      await mergeCanvasRecords(cowartUrl, { put: [assetRecord, shapeRecord] });
    } catch (mergeError) {
      // Older Cowart servers lack the merge endpoint: fall back to a full
      // snapshot save (reintroduces the read-modify-write window).
      try {
        store[assetId] = assetRecord;
        store[shapeId] = shapeRecord;
        await saveCanvasSnapshot(cowartUrl, snapshot);
      } catch {
        throw mergeError;
      }
    }
  }

  return {
    cowartUrl,
    pageId,
    parentId,
    anchorShapeId,
    assetId,
    shapeId,
    index,
    sourceImagePath,
    assetFile: filePath,
    assetUrl: assetRecord.props.src,
    imageSize: naturalSize,
    fillAnchor,
    bounds,
    dryRun: Boolean(args.dryRun),
  };
}

function plainTextFromRichText(richText) {
  if (!richText || typeof richText !== "object") {
    return typeof richText === "string" ? richText.trim() : "";
  }
  const collect = (node) => {
    if (!node) return "";
    if (typeof node.text === "string") return node.text;
    if (Array.isArray(node.content)) return node.content.map(collect).join("");
    return "";
  };
  const blocks = Array.isArray(richText.content) ? richText.content : [richText];
  return blocks
    .map(collect)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function shapeTextContent(shape) {
  return plainTextFromRichText(shape?.props?.richText) || nonEmptyString(shape?.props?.text) || null;
}

// Absolute page-space offset of a shape's local origin (climbs nested parents).
function pageOffsetForShape(store, shape) {
  let x = finiteNumber(shape.x, 0);
  let y = finiteNumber(shape.y, 0);
  let parent = store[shape.parentId];
  const visited = new Set([shape.id]);
  while (parent?.typeName === "shape" && !visited.has(parent.id)) {
    visited.add(parent.id);
    x += finiteNumber(parent.x, 0);
    y += finiteNumber(parent.y, 0);
    parent = store[parent.parentId];
  }
  return { x, y };
}

function isAnnotationArrow(shape) {
  return shape?.typeName === "shape" && shape.type === "arrow" && shape.meta?.cowartAnnotationArrow === true;
}

function assetSummary(store, shape) {
  const asset = shape?.props?.assetId ? store[shape.props.assetId] : null;
  if (!asset) return null;
  return {
    id: asset.id,
    name: asset.props?.name ?? null,
    src: asset.props?.src ?? null,
    w: asset.props?.w ?? null,
    h: asset.props?.h ?? null,
    mimeType: asset.props?.mimeType ?? null,
  };
}

function describeShape(store, shape) {
  return {
    id: shape.id,
    type: shape.type,
    parentId: shape.parentId,
    bounds: pageBoundsForShape(store, shape),
    rotation: finiteNumber(shape.rotation, 0),
    text: shapeTextContent(shape),
    isAiImageHolder: shape.meta?.cowartAiImageHolder === true,
    isAnnotation: isAnnotationArrow(shape),
    asset: assetSummary(store, shape),
    meta: shape.meta ?? {},
  };
}

// The shape an annotation arrow points at: prefer the smallest shape whose
// bounds contain the arrow tip; otherwise the nearest shape by center.
function findAnnotationTarget(store, pageShapes, endPoint, arrowId) {
  const candidates = pageShapes
    .filter((shape) => shape.id !== arrowId && shape.type !== "arrow" && !isAnnotationArrow(shape))
    .map((shape) => ({ shape, bounds: pageBoundsForShape(store, shape) }))
    .filter((entry) => entry.bounds);

  const containing = candidates.filter(
    ({ bounds }) =>
      endPoint.x >= bounds.x &&
      endPoint.x <= bounds.x + bounds.w &&
      endPoint.y >= bounds.y &&
      endPoint.y <= bounds.y + bounds.h
  );

  if (containing.length > 0) {
    return containing.reduce((best, entry) =>
      entry.bounds.w * entry.bounds.h < best.bounds.w * best.bounds.h ? entry : best
    ).shape;
  }

  let nearest = null;
  for (const entry of candidates) {
    const cx = entry.bounds.x + entry.bounds.w / 2;
    const cy = entry.bounds.y + entry.bounds.h / 2;
    const distance = Math.hypot(cx - endPoint.x, cy - endPoint.y);
    if (!nearest || distance < nearest.distance) nearest = { shape: entry.shape, distance };
  }
  return nearest?.shape ?? null;
}

function resolveTargetPages(store, args, viewState) {
  const pages = Object.values(store)
    .filter((record) => record?.typeName === "page")
    .sort((a, b) => String(a.index ?? "").localeCompare(String(b.index ?? "")));
  const requestedPageId = nonEmptyString(args.pageId);
  if (requestedPageId) return pages.filter((page) => page.id === requestedPageId);
  if (args.allPages === true) return pages;
  const currentPageId = nonEmptyString(viewState?.currentPageId);
  const current = pages.find((page) => page.id === currentPageId);
  return current ? [current] : pages.slice(0, 1);
}

async function getCowartCanvas(args = {}) {
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const viewState = await readViewState(args);
  const pages = resolveTargetPages(store, args, viewState).map((page) => ({
    pageId: page.id,
    name: page.name ?? null,
    shapes: getPageShapes(store, page.id).map((shape) => describeShape(store, shape)),
  }));
  return {
    cowartUrl,
    currentPageId: nonEmptyString(viewState?.currentPageId) ?? null,
    pages,
  };
}

async function getCowartAnnotations(args = {}) {
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const viewState = await readViewState(args);
  const annotations = [];
  for (const page of resolveTargetPages(store, args, viewState)) {
    const pageShapes = getPageShapes(store, page.id);
    for (const shape of pageShapes) {
      if (!isAnnotationArrow(shape)) continue;
      const offset = pageOffsetForShape(store, shape);
      const start = shape.props?.start ?? { x: 0, y: 0 };
      const end = shape.props?.end ?? { x: 0, y: 0 };
      const startPoint = { x: offset.x + finiteNumber(start.x, 0), y: offset.y + finiteNumber(start.y, 0) };
      const endPoint = { x: offset.x + finiteNumber(end.x, 0), y: offset.y + finiteNumber(end.y, 0) };
      const target = findAnnotationTarget(store, pageShapes, endPoint, shape.id);
      annotations.push({
        id: shape.id,
        pageId: page.id,
        text: shapeTextContent(shape) ?? "",
        startPoint,
        endPoint,
        target: target
          ? { id: target.id, type: target.type, isAiImageHolder: target.meta?.cowartAiImageHolder === true, asset: assetSummary(store, target) }
          : null,
      });
    }
  }
  return { cowartUrl, currentPageId: nonEmptyString(viewState?.currentPageId) ?? null, annotations };
}

async function persistRecords(cowartUrl, store, snapshot, { put = [], remove = [] }) {
  try {
    await mergeCanvasRecords(cowartUrl, { put, remove });
  } catch (mergeError) {
    // Older servers without the merge endpoint: fall back to a full save.
    try {
      for (const id of remove) delete store[id];
      for (const record of put) store[record.id] = record;
      await saveCanvasSnapshot(cowartUrl, snapshot);
    } catch {
      throw mergeError;
    }
  }
}

async function createCowartImageHolder(args = {}) {
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const { selection } = await readSelectionState(args);
  const viewState = await readViewState(args);

  const anchorShapeId = nonEmptyString(args.anchorShapeId) || firstSelectedShapeId(selection);
  const anchorShape = anchorShapeId ? getRecord(store, anchorShapeId, "anchor shape") : null;
  const pageId =
    nonEmptyString(args.pageId) ||
    (anchorShape ? findPageIdForShape(store, anchorShape.id) : null) ||
    nonEmptyString(viewState?.currentPageId) ||
    Object.values(store).find((record) => record?.typeName === "page")?.id;
  if (!pageId || !store[pageId]) throw new Error("Could not determine target pageId.");

  const parentId = pageId;
  const width = Math.max(1, finiteNumber(args.width, AI_IMAGE_HOLDER_DEFAULT_W));
  const height = Math.max(1, finiteNumber(args.height, AI_IMAGE_HOLDER_DEFAULT_H));
  const margin = Math.max(0, finiteNumber(args.margin, 40));
  const placement = ["right", "left", "below"].includes(args.placement) ? args.placement : "right";
  const { x, y } = choosePlacement({ store, pageId, parentId, anchorShape, width, height, margin, placement });

  const name = nonEmptyString(args.name) || AI_IMAGE_HOLDER_LABEL;
  const shapeId = uniqueRecordId(store, "shape", sanitizeIdPart(name, "ai-image"));
  const index = chooseIndex(store, parentId);
  const shapeRecord = {
    x,
    y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {
      cowartAiImageHolder: true,
      cowartAiImageHolderVersion: 1,
      ...(args.shapeMeta && typeof args.shapeMeta === "object" ? args.shapeMeta : {}),
    },
    id: shapeId,
    type: "frame",
    props: { w: width, h: height, name, color: "blue" },
    parentId,
    index,
    typeName: "shape",
  };

  if (!args.dryRun) {
    await persistRecords(cowartUrl, store, snapshot, { put: [shapeRecord] });
  }

  return { cowartUrl, pageId, parentId, shapeId, index, bounds: { x, y, w: width, h: height }, dryRun: Boolean(args.dryRun) };
}

function assetReferencedByOthers(store, assetId, exceptShapeId) {
  return Object.values(store).some(
    (record) => record?.typeName === "shape" && record.id !== exceptShapeId && record.props?.assetId === assetId
  );
}

async function replaceCowartImage(args = {}) {
  const imagePath = nonEmptyString(args.imagePath);
  if (!imagePath) throw new Error("imagePath is required.");
  const sourceImagePath = pathResolve(imagePath);
  const sourceStat = await stat(sourceImagePath);
  if (!sourceStat.isFile()) throw new Error(`imagePath is not a file: ${sourceImagePath}`);

  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const { selection } = await readSelectionState(args);

  const targetShapeId = nonEmptyString(args.targetShapeId) || nonEmptyString(args.shapeId) || firstSelectedShapeId(selection);
  if (!targetShapeId) throw new Error("targetShapeId is required (or select the image to replace).");
  let targetShape = getRecord(store, targetShapeId, "target shape");

  const pageId = findPageIdForShape(store, targetShape.id);
  if (!pageId) throw new Error(`Could not determine the page for ${targetShapeId}.`);

  // A frame holder: replace the image inside it.
  if (targetShape.type === "frame") {
    const child = getPageShapes(store, pageId).find(
      (shape) => shape.parentId === targetShape.id && shape.type === "image"
    );
    if (!child) {
      throw new Error(`Frame ${targetShapeId} has no image to replace. Use insert_cowart_image with fillAnchor instead.`);
    }
    targetShape = child;
  }
  if (targetShape.type !== "image") {
    throw new Error(`Target ${targetShape.id} is type "${targetShape.type}", not an image shape.`);
  }

  let imageSize = null;
  try {
    imageSize = await getImageDimensions(sourceImagePath);
  } catch {
    imageSize = null;
  }
  const width = finiteNumber(args.displayWidth, finiteNumber(targetShape.props?.w, imageSize?.width ?? 1));
  const height = finiteNumber(args.displayHeight, finiteNumber(targetShape.props?.h, imageSize?.height ?? 1));
  const naturalSize = imageSize ?? { width: Math.round(width), height: Math.round(height) };

  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "pages", pageDirName(pageId), "assets");
  if (!isSafeChildPath(canvasDir, assetsDir)) {
    throw new Error(`Unsafe page assets directory: ${assetsDir}`);
  }
  const { fileName, filePath } = await uniqueFilePath(assetsDir, args.fileName || basename(sourceImagePath));
  const assetId = uniqueRecordId(store, "asset", sanitizeIdPart(fileName));
  const oldAssetId = nonEmptyString(targetShape.props?.assetId);
  const mimeType = mimeTypeForFile(fileName);

  const assetRecord = {
    id: assetId,
    typeName: "asset",
    type: "image",
    props: {
      name: fileName,
      src: pageAssetUrl(pageId, fileName),
      w: naturalSize.width,
      h: naturalSize.height,
      fileSize: sourceStat.size,
      mimeType,
      isAnimated: false,
    },
    meta: args.assetMeta && typeof args.assetMeta === "object" ? args.assetMeta : {},
  };

  const updatedShape = {
    ...targetShape,
    props: { ...targetShape.props, assetId, w: width, h: height },
  };

  const removeOldAsset =
    oldAssetId && args.keepOldAsset !== true && !assetReferencedByOthers(store, oldAssetId, targetShape.id);

  if (!args.dryRun) {
    await mkdir(assetsDir, { recursive: true });
    await copyFile(sourceImagePath, filePath);
    await persistRecords(cowartUrl, store, snapshot, {
      put: [assetRecord, updatedShape],
      remove: removeOldAsset ? [oldAssetId] : [],
    });
  }

  return {
    cowartUrl,
    pageId,
    shapeId: targetShape.id,
    assetId,
    previousAssetId: oldAssetId ?? null,
    removedPreviousAsset: Boolean(removeOldAsset),
    assetFile: filePath,
    assetUrl: assetRecord.props.src,
    imageSize: naturalSize,
    bounds: { w: width, h: height },
    dryRun: Boolean(args.dryRun),
  };
}

function exportTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function localAssetFileForShape(store, shape, canvasDir) {
  const assetId = shape?.props?.assetId;
  const asset = assetId ? store[assetId] : null;
  const src = asset?.props?.src;
  if (!src || typeof src !== "string" || !src.startsWith(PAGE_ASSETS_ROUTE)) return null;
  const parts = src.slice(PAGE_ASSETS_ROUTE.length).split("/").map(decodeURIComponent);
  if (parts.length < 2 || !parts[0]) return null;
  const filePath = resolve(join(canvasDir, "pages", parts[0], "assets", ...parts.slice(1)));
  return isSafeChildPath(canvasDir, filePath) ? filePath : null;
}

function resolveSingleImageShape(store, { mode, shapeIds, selection }) {
  let ids = null;
  if (mode === "shapes" && Array.isArray(shapeIds)) ids = shapeIds;
  else if (mode === "selection") ids = (selection?.selectedShapes ?? []).map((shape) => shape.id);
  else return null; // page / currentPage are not a single image
  if (!ids || ids.length !== 1) return null;
  const shape = store[ids[0]];
  if (!shape) return null;
  if (shape.type === "image") return shape;
  if (shape.type === "frame") {
    const pageId = findPageIdForShape(store, shape.id);
    const child = pageId
      ? getPageShapes(store, pageId).find((candidate) => candidate.parentId === shape.id && candidate.type === "image")
      : null;
    return child ?? null;
  }
  return null;
}

async function exportCowartView(args = {}) {
  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const { selection } = await readSelectionState(args);

  const explicitShapeId = nonEmptyString(args.targetShapeId) || nonEmptyString(args.shapeId);
  let mode = nonEmptyString(args.mode);
  let shapeIds = Array.isArray(args.shapeIds) ? args.shapeIds.filter((value) => typeof value === "string") : null;
  if (!mode) {
    if (explicitShapeId) mode = "shapes";
    else if ((selection?.selectedShapes ?? []).length > 0) mode = "selection";
    else mode = "currentPage";
  }
  if (mode === "shapes" && (!shapeIds || shapeIds.length === 0) && explicitShapeId) shapeIds = [explicitShapeId];

  const requestedFormat = ["png", "jpeg", "svg", "webp"].includes(args.format) ? args.format : null;
  const canvasDir = resolveCanvasDir(args);

  // Asset fast-path: a single image (or a frame holder's image) with a local
  // file, and no explicit format/render -> copy the original bitmap losslessly.
  let strategy = null;
  let assetSourceFile = null;
  if (!args.render && !requestedFormat) {
    const single = resolveSingleImageShape(store, { mode, shapeIds, selection });
    if (single) {
      const file = localAssetFileForShape(store, single, canvasDir);
      if (file) {
        try {
          await stat(file);
          strategy = "asset";
          assetSourceFile = file;
        } catch {
          strategy = null;
        }
      }
    }
  }

  const format = requestedFormat ?? "png";
  const ext = strategy === "asset" ? extname(assetSourceFile) || ".png" : `.${format === "jpeg" ? "jpg" : format}`;
  const outputPath = nonEmptyString(args.outputPath)
    ? pathResolve(args.outputPath)
    : join(canvasDir, "exports", `cowart-export-${exportTimestamp()}${ext}`);

  if (args.dryRun) {
    return {
      cowartUrl,
      strategy: strategy ?? "render",
      mode,
      shapeIds: shapeIds ?? null,
      format: strategy === "asset" ? "asset" : format,
      outputPath,
      dryRun: true,
    };
  }

  await mkdir(dirname(outputPath), { recursive: true });

  if (strategy === "asset") {
    await copyFile(assetSourceFile, outputPath);
    const bytes = (await stat(outputPath)).size;
    return { cowartUrl, strategy: "asset", outputPath, sourceFile: assetSourceFile, bytes, dryRun: false };
  }

  // Render path: the MCP cannot rasterize tldraw, so a connected browser does it.
  const render = await fetchJson(`${cowartUrl}/api/canvas/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode,
      shapeIds: shapeIds ?? undefined,
      pageId: nonEmptyString(args.pageId) || undefined,
      format,
      scale: finiteNumber(args.scale, undefined),
      padding: finiteNumber(args.padding, undefined),
      background: typeof args.background === "boolean" ? args.background : undefined,
      timeoutMs: finiteNumber(args.timeoutMs, undefined),
    }),
  });
  if (!render?.base64) throw new Error("The Cowart browser returned no image data for the export.");
  const buffer = Buffer.from(render.base64, "base64");
  await writeFile(outputPath, buffer);
  return {
    cowartUrl,
    strategy: "render",
    outputPath,
    format,
    width: render.width ?? null,
    height: render.height ?? null,
    bytes: buffer.length,
    dryRun: false,
  };
}

function toolDefinitions() {
  return [
    {
      name: TOOL_GET_SELECTION,
      title: "Get Cowart Selection",
      description:
        "Return the currently selected Cowart/tldraw shapes and image asset metadata from a project's canvas/cowart-selection.json state file.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: {
            type: "string",
            description: "Absolute Cowart project directory. The tool reads <projectDir>/canvas/cowart-selection.json.",
          },
          canvasDir: {
            type: "string",
            description: "Absolute canvas directory. If provided, this takes precedence over projectDir.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: TOOL_INSERT_IMAGE,
      title: "Insert Cowart Image",
      description:
        "Copy a local bitmap into a Cowart page-local assets folder, create a tldraw image asset and shape, place it beside an anchor or clear page area, and save through the Cowart canvas API.",
      inputSchema: {
        type: "object",
        properties: {
          imagePath: { type: "string", description: "Absolute local bitmap path to insert." },
          projectDir: { type: "string", description: "Absolute Cowart project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          cowartUrl: { type: "string", description: "Running Cowart URL, for example http://127.0.0.1:43218." },
          pageId: { type: "string", description: "Target tldraw page id. Optional when an anchor or view-state page is available." },
          anchorShapeId: { type: "string", description: "Existing shape id to place beside, usually the source image or AI frame." },
          sourceShapeId: { type: "string", description: "Alias for anchorShapeId." },
          fileName: { type: "string", description: "Optional destination filename under the page assets folder." },
          placement: { type: "string", enum: ["right", "left", "below"], description: "Placement direction from the anchor. Ignored when fillAnchor is true." },
          margin: { type: "number", description: "Canvas units between the new image and nearby shapes. Defaults to 40." },
          matchAnchor: { type: "boolean", description: "Use the anchor display size when possible. Defaults to true." },
          fillAnchor: {
            type: "boolean",
            description:
              "Fill the anchor instead of placing beside it: for an AI 图片 frame holder the image is added as a child at 0,0 sized to the frame; for a legacy geo holder it overlays the holder's position, size, and rotation. Use for the image-gen holder workflow. Defaults to false.",
          },
          displayWidth: { type: "number", description: "Displayed shape width in canvas units." },
          displayHeight: { type: "number", description: "Displayed shape height in canvas units." },
          altText: { type: "string", description: "Image shape alt text." },
          annotationScreenshot: { type: "string", description: "Source annotation screenshot filename for metadata." },
          shapeMeta: { type: "object", description: "Additional tldraw shape metadata." },
          assetMeta: { type: "object", description: "Additional tldraw asset metadata." },
          dryRun: { type: "boolean", description: "Calculate insertion without copying or saving." },
        },
        required: ["imagePath"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: TOOL_GET_CANVAS,
      title: "Get Cowart Canvas",
      description:
        "Return a structured summary of the Cowart canvas (current page by default) so the agent can reason about what is on the board: each shape's id, type, page-space bounds, text, asset, and whether it is an AI 图片 holder or an annotation.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: { type: "string", description: "Absolute Cowart project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          cowartUrl: { type: "string", description: "Running Cowart URL, for example http://127.0.0.1:43217." },
          pageId: { type: "string", description: "Limit to a single page id. Defaults to the current view-state page." },
          allPages: { type: "boolean", description: "Include every page instead of just the current one. Defaults to false." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: TOOL_GET_ANNOTATIONS,
      title: "Get Cowart Annotations",
      description:
        "Return Cowart 批注 annotations as structured data: each annotation arrow's text label and the shape it points at (resolved from the arrow tip), so edit intent can be read without screenshotting the canvas.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: { type: "string", description: "Absolute Cowart project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          cowartUrl: { type: "string", description: "Running Cowart URL." },
          pageId: { type: "string", description: "Limit to a single page id. Defaults to the current view-state page." },
          allPages: { type: "boolean", description: "Include annotations on every page. Defaults to false." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: TOOL_CREATE_HOLDER,
      title: "Create Cowart Image Holder",
      description:
        "Create an AI 图片 holder (tldraw frame) on the canvas, matching the holder the UI tool creates, placed beside an anchor or in a clear page area. Use to set up a slot before generating an image into it.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: { type: "string", description: "Absolute Cowart project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          cowartUrl: { type: "string", description: "Running Cowart URL." },
          pageId: { type: "string", description: "Target page id. Optional when an anchor or view-state page is available." },
          anchorShapeId: { type: "string", description: "Existing shape id to place the holder beside." },
          placement: { type: "string", enum: ["right", "left", "below"], description: "Placement direction from the anchor. Defaults to right." },
          margin: { type: "number", description: "Canvas units between the holder and nearby shapes. Defaults to 40." },
          width: { type: "number", description: "Holder width in canvas units. Defaults to 320." },
          height: { type: "number", description: "Holder height in canvas units. Defaults to 220." },
          name: { type: "string", description: "Holder label. Defaults to AI 图片." },
          shapeMeta: { type: "object", description: "Additional tldraw shape metadata." },
          dryRun: { type: "boolean", description: "Calculate placement without saving." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: TOOL_REPLACE_IMAGE,
      title: "Replace Cowart Image",
      description:
        "Replace the bitmap of an existing image shape in place (the 替换 flow), keeping its position and size. If given a frame holder, replaces the image inside it. Copies the new bitmap into the page assets folder and updates the asset reference.",
      inputSchema: {
        type: "object",
        properties: {
          imagePath: { type: "string", description: "Absolute local bitmap path to swap in." },
          targetShapeId: { type: "string", description: "Image shape id to replace, or a frame holder whose image should be replaced. Falls back to the current selection." },
          shapeId: { type: "string", description: "Alias for targetShapeId." },
          projectDir: { type: "string", description: "Absolute Cowart project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          cowartUrl: { type: "string", description: "Running Cowart URL." },
          fileName: { type: "string", description: "Optional destination filename under the page assets folder." },
          displayWidth: { type: "number", description: "New displayed width. Defaults to the existing shape width." },
          displayHeight: { type: "number", description: "New displayed height. Defaults to the existing shape height." },
          keepOldAsset: { type: "boolean", description: "Keep the previous asset record/file instead of removing an now-unreferenced one. Defaults to false." },
          assetMeta: { type: "object", description: "Additional tldraw asset metadata." },
          dryRun: { type: "boolean", description: "Calculate the replacement without copying or saving." },
        },
        required: ["imagePath"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: TOOL_EXPORT_VIEW,
      title: "Export Cowart View",
      description:
        "Export the canvas to an image file the agent can attach or reference. A single image (or a frame holder's image) is copied losslessly from page assets (no browser needed). Pages, selections, or multi-shape regions are rasterized by a connected Cowart browser via editor.toImage, so the canvas must be open for those.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: { type: "string", description: "Absolute Cowart project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          cowartUrl: { type: "string", description: "Running Cowart URL." },
          outputPath: { type: "string", description: "Absolute destination file path. Defaults to <canvasDir>/exports/cowart-export-<timestamp>.<ext>." },
          mode: { type: "string", enum: ["selection", "shapes", "page", "currentPage"], description: "What to export. Defaults to a single targetShapeId, else selection, else the current page." },
          targetShapeId: { type: "string", description: "Export a single shape (image, or a frame holder's image). Falls back to the current selection." },
          shapeId: { type: "string", description: "Alias for targetShapeId." },
          shapeIds: { type: "array", items: { type: "string" }, description: "Shape ids to export when mode is 'shapes'." },
          pageId: { type: "string", description: "Page to export when mode is 'page'." },
          format: { type: "string", enum: ["png", "jpeg", "svg", "webp"], description: "Output format. Omit to copy a single image losslessly; set it to force a browser render." },
          render: { type: "boolean", description: "Force a browser render even for a single image. Defaults to false." },
          scale: { type: "number", description: "Render scale factor (render strategy only)." },
          padding: { type: "number", description: "Render padding in canvas units (render strategy only)." },
          background: { type: "boolean", description: "Include the page background in the render (render strategy only)." },
          dryRun: { type: "boolean", description: "Resolve the plan (strategy + output path) without writing or rendering." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

async function handleToolCall(id, params) {
  if (params?.name === TOOL_GET_SELECTION) {
    const { selection, selectionFile } = await readSelectionState(params.arguments ?? {});
    const selectedShapes = selection.selectedShapes ?? [];
    const summary =
      selectedShapes.length === 0
        ? "No Cowart shapes are currently selected."
        : selectedShapes
            .map((shape) => {
              const assetName = shape.asset?.name ? ` (${shape.asset.name})` : "";
              return `${shape.id} [${shape.type ?? "unknown"}]${assetName}`;
            })
            .join("\n");

    sendResult(id, {
      content: [{ type: "text", text: summary }],
      structuredContent: { selection, selectionFile },
    });
    return;
  }

  if (params?.name === TOOL_INSERT_IMAGE) {
    const result = await insertCowartImage(params.arguments ?? {});
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Inserted"} ${result.shapeId} on ${result.pageId} at (${result.bounds.x}, ${result.bounds.y}) using ${result.index}.`,
        },
      ],
      structuredContent: result,
    });
    return;
  }

  if (params?.name === TOOL_GET_CANVAS) {
    const result = await getCowartCanvas(params.arguments ?? {});
    const totalShapes = result.pages.reduce((sum, page) => sum + page.shapes.length, 0);
    const summary = result.pages.length === 0
      ? "Cowart canvas has no pages."
      : result.pages
          .map((page) => `${page.name ?? page.pageId} (${page.pageId}): ${page.shapes.length} shape(s)`)
          .join("\n") + `\n${totalShapes} shape(s) total.`;
    sendResult(id, { content: [{ type: "text", text: summary }], structuredContent: result });
    return;
  }

  if (params?.name === TOOL_GET_ANNOTATIONS) {
    const result = await getCowartAnnotations(params.arguments ?? {});
    const summary = result.annotations.length === 0
      ? "No Cowart annotations found."
      : result.annotations
          .map((annotation) => {
            const target = annotation.target
              ? ` -> ${annotation.target.id} [${annotation.target.type}]${annotation.target.asset?.name ? ` (${annotation.target.asset.name})` : ""}`
              : " -> (no target)";
            return `${annotation.id}: "${annotation.text}"${target}`;
          })
          .join("\n");
    sendResult(id, { content: [{ type: "text", text: summary }], structuredContent: result });
    return;
  }

  if (params?.name === TOOL_CREATE_HOLDER) {
    const result = await createCowartImageHolder(params.arguments ?? {});
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Created"} holder ${result.shapeId} on ${result.pageId} at (${result.bounds.x}, ${result.bounds.y}).`,
        },
      ],
      structuredContent: result,
    });
    return;
  }

  if (params?.name === TOOL_REPLACE_IMAGE) {
    const result = await replaceCowartImage(params.arguments ?? {});
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned replacement of" : "Replaced"} ${result.shapeId} asset -> ${result.assetId}${result.removedPreviousAsset ? " (old asset removed)" : ""}.`,
        },
      ],
      structuredContent: result,
    });
    return;
  }

  if (params?.name === TOOL_EXPORT_VIEW) {
    const result = await exportCowartView(params.arguments ?? {});
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned export" : "Exported"} (${result.strategy}) -> ${result.outputPath}`,
        },
      ],
      structuredContent: result,
    });
    return;
  }

  sendError(id, JsonRpcError.INVALID_PARAMS, `Unknown tool: ${params?.name ?? ""}`);
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      instructions:
        "Read and update Cowart canvas state without hand-writing tldraw records. Perceive: get_cowart_canvas (structured board), get_cowart_annotations (批注 text + targets), get_cowart_selection (current selection). Act: insert_cowart_image (place a bitmap), create_cowart_image_holder (make an AI 图片 slot), replace_cowart_image (swap a bitmap in place). Export: export_cowart_view (write an image file the agent can attach; pages/selections need the canvas open in a browser to render).",
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
      sendError(id, JsonRpcError.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
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

lines.on("line", (line) => {
  if (line.trim().length === 0) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  handleRequest(message).catch((error) => {
    if (message.id !== undefined) {
      sendError(message.id, JsonRpcError.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
    }
  });
});
