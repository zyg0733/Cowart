import test from "node:test";
import assert from "node:assert/strict";

import { CowartCoordinateError, createImageCoordinateMapper } from "../shared/cowart-image-coordinates.mjs";

const source = {
  pageId: "page:one",
  shapeId: "shape:image",
  assetId: "asset:image",
  assetSha256: "sha256:fixture",
  width: 640,
  height: 480,
};

const closePoint = (actual, expected, maxError = 1) => {
  assert.ok(Math.abs(actual.x - expected.x) <= maxError, `x ${actual.x} differs from ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) <= maxError, `y ${actual.y} differs from ${expected.y}`);
};

const closeBox = (actual, expected, maxError = 1) => {
  assert.ok(Math.abs(actual.x - expected.x) <= maxError, `x ${actual.x} differs from ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) <= maxError, `y ${actual.y} differs from ${expected.y}`);
  assert.ok(Math.abs(actual.w - expected.w) <= maxError, `w ${actual.w} differs from ${expected.w}`);
  assert.ok(Math.abs(actual.h - expected.h) <= maxError, `h ${actual.h} differs from ${expected.h}`);
};

const tldrawReferencePoint = (localPoint, chain) => {
  let point = { ...localPoint };
  for (const shape of chain) {
    const angle = shape.rotation ?? 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    point = {
      x: shape.x + point.x * cos - point.y * sin,
      y: shape.y + point.x * sin + point.y * cos,
    };
  }
  return point;
};

const boundsFromPoints = (points) => {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

test("Given an axis-aligned image When a page rectangle is mapped Then it matches the existing MCP rectangle math", () => {
  const mapper = createImageCoordinateMapper({
    source: { ...source, width: 800, height: 600 },
    shape: { id: "shape:image", parentId: "page:one", x: 10, y: 20, rotation: 0, props: { w: 400, h: 200 } },
  });

  assert.deepEqual(mapper.pageAabbToNaturalAabb({ x: 60, y: 70, w: 100, h: 50 }), {
    x: 100,
    y: 150,
    w: 200,
    h: 150,
  });
});

test("Given a rotated image When local points map to page Then tldraw origin-pivot semantics are used", () => {
  const shape = { id: "shape:image", x: 100, y: 80, rotation: Math.PI / 6, props: { w: 320, h: 240 } };
  const mapper = createImageCoordinateMapper({ source, shape });
  const localTopRight = { x: 320, y: 0 };
  const expected = tldrawReferencePoint(localTopRight, [shape]);

  closePoint(mapper.localPointToPagePoint(localTopRight), expected, 0.001);
  closePoint(mapper.localPointToPagePoint(localTopRight), { x: 377.1281292110204, y: 240 }, 0.001);
  closePoint(mapper.pagePointToNaturalPoint(mapper.naturalPointToPagePoint({ x: 240.25, y: 130.75 })), { x: 240.25, y: 130.75 });
});

test("Given nested parent transforms When a local point maps to page Then parent and child origin transforms compose in order", () => {
  const parent = { id: "shape:frame", x: 30, y: 40, rotation: Math.PI / 8, props: { w: 500, h: 400 } };
  const child = { id: "shape:image", parentId: "shape:frame", x: 50, y: 60, rotation: Math.PI / 5, props: { w: 320, h: 240 } };
  const mapper = createImageCoordinateMapper({ source, ancestors: [parent], shape: child });
  const localPoint = { x: 100, y: 70 };

  closePoint(mapper.localPointToPagePoint(localPoint), tldrawReferencePoint(localPoint, [child, parent]), 0.001);
  closePoint(mapper.pagePointToNaturalPoint(mapper.naturalPointToPagePoint({ x: 420, y: 350 })), { x: 420, y: 350 });
});

test("Given two non-commuting ancestors When a local point maps to page Then immediate parent and grandparent compose in tldraw order", () => {
  const grandparent = { id: "shape:frame", x: 100, y: -20, rotation: Math.PI / 9, props: { w: 800, h: 600 } };
  const parent = { id: "shape:group", parentId: "shape:frame", x: 30, y: 40, rotation: -7 * Math.PI / 36, props: {} };
  const child = { id: "shape:image", parentId: "shape:group", x: 12, y: 18, rotation: 5 * Math.PI / 36, props: { w: 320, h: 240 } };
  const point = { x: 37, y: 29 };
  const mapper = createImageCoordinateMapper({ source, shape: child, ancestors: [parent, grandparent] });

  closePoint(mapper.localPointToPagePoint(point), tldrawReferencePoint(point, [child, parent, grandparent]), 0.001);
});

test("Given real tldraw crop and flips When local corners are mapped Then natural pixels use the canonical crop", () => {
  const mapper = createImageCoordinateMapper({
    source,
    shape: {
      id: "shape:image",
      x: 0,
      y: 0,
      rotation: 0,
      props: {
        w: 200,
        h: 100,
        flipX: true,
        flipY: true,
        crop: { topLeft: { x: 0.25, y: 0.125 }, bottomRight: { x: 0.75, y: 0.625 } },
      },
    },
  });

  assert.deepEqual(mapper.localPointToNaturalPoint({ x: 0, y: 0 }), { x: 480, y: 420 });
  assert.deepEqual(mapper.localPointToNaturalPoint({ x: 200, y: 100 }), { x: 160, y: 180 });
});

test("Given non-tldraw crop fields When a mapper is created Then the speculative adapter is rejected", () => {
  assert.throws(
    () => createImageCoordinateMapper({ source, shape: { id: "shape:image", props: { w: 200, h: 100, crop: { x: 0.25, y: 0.125, w: 0.5, h: 0.5 } } } }),
    (error) => {
      assert.ok(error instanceof CowartCoordinateError);
      assert.equal(error.code, "invalid_crop");
      return true;
    }
  );
});

test("Given a rotated natural box When converted to page Then oriented quad and AABB APIs stay distinct", () => {
  const shape = { id: "shape:image", x: 100, y: 100, rotation: Math.PI / 5, props: { w: 320, h: 240 } };
  const mapper = createImageCoordinateMapper({ source, shape });
  const naturalBox = { x: 100, y: 100, w: 100, h: 80 };
  const oriented = mapper.naturalBoxToPageOrientedQuad(naturalBox);
  const aabb = mapper.naturalBoxToPageAabb(naturalBox);
  const expectedPoints = [
    { x: 50, y: 50 },
    { x: 100, y: 50 },
    { x: 100, y: 90 },
    { x: 50, y: 90 },
  ].map((point) => tldrawReferencePoint(point, [shape]));

  assert.deepEqual(Object.keys(oriented).sort(), ["kind", "points"].sort());
  assert.equal(oriented.kind, "oriented_quad");
  assert.equal(oriented.points.length, 4);
  oriented.points.forEach((point, index) => closePoint(point, expectedPoints[index], 0.001));
  closeBox(aabb, boundsFromPoints(expectedPoints), 0.001);
  closeBox(mapper.pageOrientedQuadToNaturalAabb(oriented), naturalBox);
  assert.notDeepEqual(aabb, oriented);
});

test("Given point box and polygon mappings When they round trip Then all coordinates remain stable", () => {
  const mapper = createImageCoordinateMapper({ source, shape: { id: "shape:image", x: -30, y: 22, rotation: -Math.PI / 7, props: { w: 320, h: 240 } } });
  const point = { x: 18, y: 44 };
  const box = { x: 20, y: 30, w: 90, h: 70 };
  const polygon = [{ x: 5, y: 6 }, { x: 90, y: 20 }, { x: 40, y: 88 }];

  closePoint(mapper.naturalPointToLocalPoint(mapper.localPointToNaturalPoint(point)), point);
  assert.deepEqual(mapper.naturalBoxToLocalAabb(mapper.localAabbToNaturalAabb(box)), box);
  assert.deepEqual(mapper.naturalPolygonToLocalPolygon(mapper.localPolygonToNaturalPolygon(polygon)), polygon);
});

test("Given a page ROI When normalized for a provider Then it can be denormalized without losing source fields", () => {
  const mapper = createImageCoordinateMapper({ source, shape: { id: "shape:image", x: 10, y: 20, rotation: 0, props: { w: 320, h: 240 } } });

  const roi = mapper.pageAabbToNormalizedRoi({ x: 90, y: 80, w: 80, h: 60 });
  assert.deepEqual(roi.source, mapper.sourceIdentity);
  assert.deepEqual(roi.normalizedBox, { x: 0.25, y: 0.25, w: 0.25, h: 0.25 });
  assert.deepEqual(mapper.normalizedRoiToNaturalAabb(roi), { x: 160, y: 120, w: 160, h: 120 });
});
