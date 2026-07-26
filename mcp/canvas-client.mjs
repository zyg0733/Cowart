import { readFile } from "node:fs/promises";

import { codedError } from "./object-aware-errors.mjs";
import { nonEmptyString, resolveCanvasDir, resolveSelectionFile, resolveViewStateFile } from "./paths.mjs";

export async function readSelectionState(args) {
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

export async function readViewState(args) {
  const viewStateFile = resolveViewStateFile(args);
  try {
    const payload = JSON.parse(await readFile(viewStateFile, "utf8"));
    return payload?.viewState ?? payload;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function normalizeCowartUrl(args = {}) {
  const value = nonEmptyString(args.cowartUrl) || nonEmptyString(process.env.COWART_URL) || "http://127.0.0.1:43217";
  return value.replace(/\/+$/, "");
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

export async function loadCanvasSnapshot(args) {
  const cowartUrl = normalizeCowartUrl(args);
  const payload = await fetchJson(`${cowartUrl}/api/canvas`);
  const snapshot = payload?.snapshot ?? payload;
  if (!snapshot || typeof snapshot !== "object" || !snapshot.schema || !snapshot.store) {
    throw new Error(`Expected Cowart canvas snapshot from ${cowartUrl}/api/canvas`);
  }
  return { cowartUrl, snapshot, payload };
}

export async function saveCanvasSnapshot(cowartUrl, snapshot) {
  return fetchJson(`${cowartUrl}/api/canvas`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot),
  });
}

export async function mergeCanvasRecords(cowartUrl, patch) {
  return fetchJson(`${cowartUrl}/api/canvas/records`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function getRecord(store, id, label) {
  const record = store[id];
  if (!record) throw new Error(`Missing ${label}: ${id}`);
  return record;
}

export function findPageIdForShape(store, shapeId) {
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

export async function persistRecords(cowartUrl, store, snapshot, { put = [], remove = [], conditions = [] }) {
  try {
    await mergeCanvasRecords(cowartUrl, { put, remove, conditions });
  } catch (mergeError) {
    if (conditions.length > 0) {
      if (conditions.some((condition) => condition?.field === "meta.cowartRequest.id" || condition?.field === "props.status")) {
        codedError("request_precondition_failed", "Cannot update holder: active request state changed.", 409);
      }
      throw mergeError;
    }
    try {
      for (const id of remove) delete store[id];
      for (const record of put) store[record.id] = record;
      await saveCanvasSnapshot(cowartUrl, snapshot);
    } catch {
      throw mergeError;
    }
  }
}
