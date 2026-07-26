import { generateKeyBetween } from "fractional-indexing";

import { loadCanvasSnapshot, persistRecords } from "./canvas-client.mjs";
import { getPageShapes, pageBoundsForShape } from "./geometry.mjs";
import { finiteNumber, nonEmptyString, sanitizeIdPart, uniqueRecordId } from "./paths.mjs";
import { readViewState } from "./canvas-client.mjs";

const SHAPE_STYLE_VALUES = {
  color: new Set(["black", "grey", "light-violet", "violet", "blue", "light-blue", "yellow", "orange", "green", "light-green", "light-red", "red", "white"]),
  size: new Set(["s", "m", "l", "xl"]),
  font: new Set(["draw", "sans", "serif", "mono"]),
  dash: new Set(["draw", "solid", "dashed", "dotted", "none"]),
  fill: new Set(["none", "semi", "solid", "pattern", "fill", "lined-fill"]),
  align: new Set(["start", "middle", "end"]),
  verticalAlign: new Set(["start", "middle", "end"]),
  textAlign: new Set(["start", "middle", "end"]),
  geo: new Set(["rectangle", "ellipse", "triangle", "diamond", "pentagon", "hexagon", "octagon", "star", "rhombus", "oval", "trapezoid", "arrow-right", "arrow-left", "arrow-up", "arrow-down", "x-box", "check-box", "cloud", "heart"]),
  spline: new Set(["line", "cubic"]),
  arrowhead: new Set(["none", "arrow", "triangle", "square", "dot", "diamond", "inverted", "bar", "pipe"]),
  arrowKind: new Set(["arc", "elbow"]),
};

function pickStyle(kind, value, fallback) {
  return typeof value === "string" && SHAPE_STYLE_VALUES[kind].has(value) ? value : fallback;
}

function richTextFromText(text) {
  const value = nonEmptyString(text);
  return { type: "doc", content: [{ type: "paragraph", content: value ? [{ type: "text", text: value }] : [] }] };
}

function buildLinePoints(input) {
  const pts = Array.isArray(input) && input.length >= 2 ? input : [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const points = {};
  let prevIndex = null;
  for (const point of pts) {
    const index = generateKeyBetween(prevIndex, null);
    prevIndex = index;
    points[index] = { id: index, index, x: finiteNumber(point?.x, 0), y: finiteNumber(point?.y, 0) };
  }
  return points;
}

export const SHAPE_BUILDERS = {
  text: (spec) => ({
    color: pickStyle("color", spec.color, "black"), size: pickStyle("size", spec.size, "m"), font: pickStyle("font", spec.font, "draw"),
    textAlign: pickStyle("textAlign", spec.textAlign ?? spec.align, "start"), w: Math.max(1, finiteNumber(spec.w, 200)),
    richText: richTextFromText(spec.text), scale: Math.max(0.01, finiteNumber(spec.scale, 1)), autoSize: spec.autoSize !== false,
  }),
  geo: (spec) => ({
    geo: pickStyle("geo", spec.geo, "rectangle"), dash: pickStyle("dash", spec.dash, "draw"), url: "", w: Math.max(1, finiteNumber(spec.w, 160)),
    h: Math.max(1, finiteNumber(spec.h, 100)), growY: 0, scale: Math.max(0.01, finiteNumber(spec.scale, 1)),
    labelColor: pickStyle("color", spec.labelColor, "black"), color: pickStyle("color", spec.color, "black"), fill: pickStyle("fill", spec.fill, "none"),
    size: pickStyle("size", spec.size, "m"), font: pickStyle("font", spec.font, "draw"), align: pickStyle("align", spec.align, "middle"),
    verticalAlign: pickStyle("verticalAlign", spec.verticalAlign, "middle"), richText: richTextFromText(spec.text),
  }),
  note: (spec) => ({
    color: pickStyle("color", spec.color, "yellow"), labelColor: pickStyle("color", spec.labelColor, "black"), size: pickStyle("size", spec.size, "m"),
    font: pickStyle("font", spec.font, "draw"), fontSizeAdjustment: 0, align: pickStyle("align", spec.align, "middle"),
    verticalAlign: pickStyle("verticalAlign", spec.verticalAlign, "middle"), growY: 0, url: "", richText: richTextFromText(spec.text),
    scale: Math.max(0.01, finiteNumber(spec.scale, 1)), textFirstEditedBy: null,
  }),
  line: (spec) => ({
    color: pickStyle("color", spec.color, "black"), dash: pickStyle("dash", spec.dash, "draw"), size: pickStyle("size", spec.size, "m"),
    spline: pickStyle("spline", spec.spline, "line"), scale: Math.max(0.01, finiteNumber(spec.scale, 1)), points: buildLinePoints(spec.points),
  }),
  arrow: (spec) => {
    const start = spec.start && typeof spec.start === "object" ? spec.start : { x: 0, y: 0 };
    const end = spec.end && typeof spec.end === "object" ? spec.end : { x: 100, y: 0 };
    return {
      kind: pickStyle("arrowKind", spec.kind, "arc"), labelColor: pickStyle("color", spec.labelColor, "black"), color: pickStyle("color", spec.color, "black"),
      fill: pickStyle("fill", spec.fill, "none"), dash: pickStyle("dash", spec.dash, "draw"), size: pickStyle("size", spec.size, "m"),
      arrowheadStart: pickStyle("arrowhead", spec.arrowheadStart, "none"), arrowheadEnd: pickStyle("arrowhead", spec.arrowheadEnd, "arrow"),
      font: pickStyle("font", spec.font, "draw"), start: { x: finiteNumber(start.x, 0), y: finiteNumber(start.y, 0) },
      end: { x: finiteNumber(end.x, 100), y: finiteNumber(end.y, 0) }, bend: finiteNumber(spec.bend, 0),
      richText: richTextFromText(spec.text), labelPosition: finiteNumber(spec.labelPosition, 0.5), scale: Math.max(0.01, finiteNumber(spec.scale, 1)),
      elbowMidPoint: finiteNumber(spec.elbowMidPoint, 0.5),
    };
  },
};

function maxSiblingIndex(store, parentId) {
  const indexes = Object.values(store).filter((record) => record?.typeName === "shape" && record.parentId === parentId && typeof record.index === "string").map((record) => record.index).sort();
  return indexes.at(-1) ?? null;
}

function shapeCenter(store, shape) {
  const bounds = pageBoundsForShape(store, shape);
  return bounds ? { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 } : null;
}

function resolveArrowConnection(store, spec) {
  const fromId = nonEmptyString(spec.fromId);
  const toId = nonEmptyString(spec.toId);
  if (!fromId && !toId) return null;
  const fromShape = fromId ? store[fromId] : null;
  const toShape = toId ? store[toId] : null;
  if (fromId && (!fromShape || fromShape.typeName !== "shape")) throw new Error(`connect fromId is not a shape: ${fromId}`);
  if (toId && (!toShape || toShape.typeName !== "shape")) throw new Error(`connect toId is not a shape: ${toId}`);

  const fromCenter = fromShape ? shapeCenter(store, fromShape) : null;
  const toCenter = toShape ? shapeCenter(store, toShape) : null;
  const origin = fromCenter ?? { x: finiteNumber(spec.x, 0), y: finiteNumber(spec.y, 0) };
  const start = fromCenter ? { x: 0, y: 0 } : spec.start && typeof spec.start === "object" ? spec.start : { x: 0, y: 0 };
  const end = toCenter ? { x: toCenter.x - origin.x, y: toCenter.y - origin.y } : spec.end && typeof spec.end === "object" ? spec.end : { x: 100, y: 0 };
  return { x: origin.x, y: origin.y, start, end, bindFrom: fromId || null, bindTo: toId || null };
}

export function makeArrowBinding(store, arrowId, targetId, terminal) {
  const id = uniqueRecordId(store, "binding", terminal);
  const record = {
    id, typeName: "binding", type: "arrow", fromId: arrowId, toId: targetId,
    props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" },
    meta: {},
  };
  store[id] = record;
  return record;
}

export async function addCowartShapes(args = {}) {
  const specs = Array.isArray(args.shapes) ? args.shapes : args.shape ? [args.shape] : [];
  if (specs.length === 0) throw new Error("Provide a non-empty 'shapes' array.");
  if (specs.length > 200) throw new Error("Too many shapes in one call (max 200).");

  const { cowartUrl, snapshot } = await loadCanvasSnapshot(args);
  const store = snapshot.store;
  const viewState = await readViewState(args);
  const defaultPageId = nonEmptyString(args.pageId) || nonEmptyString(viewState?.currentPageId) || Object.values(store).find((record) => record?.typeName === "page")?.id;
  if (!defaultPageId || !store[defaultPageId]) throw new Error("Could not determine target pageId.");

  const batchParentId = nonEmptyString(args.parentId) && store[nonEmptyString(args.parentId)] ? nonEmptyString(args.parentId) : null;
  const lastIndexByParent = new Map();
  const records = [];
  const created = [];
  const bindings = [];

  for (const spec of specs) {
    const type = nonEmptyString(spec?.type);
    const build = type ? SHAPE_BUILDERS[type] : null;
    if (!build) throw new Error(`Unsupported shape type: ${spec?.type}. Supported: ${Object.keys(SHAPE_BUILDERS).join(", ")}.`);
    const specParentId = nonEmptyString(spec.parentId) && store[nonEmptyString(spec.parentId)] ? nonEmptyString(spec.parentId) : null;
    const parentId = specParentId || batchParentId || defaultPageId;
    const prevIndex = lastIndexByParent.has(parentId) ? lastIndexByParent.get(parentId) : maxSiblingIndex(store, parentId);
    const index = generateKeyBetween(prevIndex, null);
    lastIndexByParent.set(parentId, index);
    const connection = type === "arrow" ? resolveArrowConnection(store, spec) : null;
    const effSpec = connection ? { ...spec, x: connection.x, y: connection.y, start: connection.start, end: connection.end } : spec;
    const shapeId = uniqueRecordId(store, "shape", sanitizeIdPart(type, "shape"));
    const record = {
      id: shapeId, typeName: "shape", type, x: finiteNumber(effSpec.x, 0), y: finiteNumber(effSpec.y, 0), rotation: finiteNumber(effSpec.rotation, 0),
      index, parentId, isLocked: spec.isLocked === true, opacity: Math.min(1, Math.max(0, finiteNumber(spec.opacity, 1))),
      meta: spec.meta && typeof spec.meta === "object" ? spec.meta : {}, props: build(effSpec),
    };
    store[shapeId] = record;
    records.push(record);
    const createdEntry = { id: shapeId, type, parentId, index };
    if (connection) addConnectionRecords(store, records, bindings, createdEntry, shapeId, connection);
    created.push(createdEntry);
  }
  if (!args.dryRun) await persistRecords(cowartUrl, store, snapshot, { put: records });
  return { cowartUrl, pageId: defaultPageId, created, count: created.length, bindingCount: bindings.length, records: args.dryRun ? records : undefined, dryRun: Boolean(args.dryRun) };
}

function addConnectionRecords(store, records, bindings, createdEntry, shapeId, connection) {
  const bound = [];
  for (const [terminal, targetId] of [["start", connection.bindFrom], ["end", connection.bindTo]]) {
    if (!targetId) continue;
    const binding = makeArrowBinding(store, shapeId, targetId, terminal);
    records.push(binding);
    bindings.push(binding.id);
    bound.push({ terminal, toId: targetId, bindingId: binding.id });
  }
  if (bound.length > 0) createdEntry.bindings = bound;
}
