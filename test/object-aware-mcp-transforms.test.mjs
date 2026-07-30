import assert from "node:assert/strict";
import test from "node:test";

import {
  call,
  localImageSnapshot,
  putSnapshot,
  rgbaPng,
  rpc,
  structured,
  withViteHarness,
  writeLocalSource,
} from "./object-aware-mcp-harness.mjs";

function tldrawReferencePoint(localPoint, chain) {
  let point = { ...localPoint };
  for (const shape of chain) {
    const cos = Math.cos(shape.rotation ?? 0);
    const sin = Math.sin(shape.rotation ?? 0);
    point = {
      x: shape.x + point.x * cos - point.y * sin,
      y: shape.y + point.x * sin + point.y * cos,
    };
  }
  return point;
}

function boxCorners(box) {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ];
}

function boundsFromPoints(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

test("Given two transformed ancestors and an out-of-bounds edit box When MCP materializes rectangle selectors Then source mapping and clipping are correct", async () => {
  await withViteHarness(async (ctx) => {
    const sourceBytes = rgbaPng(8, 6);
    const transformed = localImageSnapshot(sourceBytes, 8, 6);
    const grandparent = {
      id: "shape:frame",
      typeName: "shape",
      type: "frame",
      parentId: "page:one",
      x: 100,
      y: -20,
      rotation: Math.PI / 9,
      index: "a1",
      meta: {},
      props: { w: 800, h: 600 },
    };
    const parent = {
      id: "shape:group",
      typeName: "shape",
      type: "group",
      parentId: grandparent.id,
      x: 30,
      y: 40,
      rotation: -7 * Math.PI / 36,
      index: "a2",
      meta: {},
      props: {},
    };
    const target = {
      ...transformed.store["shape:image"],
      parentId: parent.id,
      x: 12,
      y: 18,
      rotation: 5 * Math.PI / 36,
      props: {
        ...transformed.store["shape:image"].props,
        w: 4,
        h: 2,
        crop: {
          topLeft: { x: 0.25, y: 1 / 6 },
          bottomRight: { x: 0.75, y: 5 / 6 },
        },
        flipX: true,
        flipY: true,
      },
    };
    const editLocalBox = { x: -4, y: -1, w: 6, h: 2 };
    const cos = Math.cos(target.rotation);
    const sin = Math.sin(target.rotation);
    const regionShape = {
      id: "shape:region",
      typeName: "shape",
      type: "geo",
      parentId: parent.id,
      x: target.x + editLocalBox.x * cos - editLocalBox.y * sin,
      y: target.y + editLocalBox.x * sin + editLocalBox.y * cos,
      rotation: target.rotation,
      index: "a3",
      meta: {},
      props: { w: editLocalBox.w, h: editLocalBox.h, geo: "rectangle" },
    };
    Object.assign(transformed.store, {
      [grandparent.id]: grandparent,
      [parent.id]: parent,
      [target.id]: target,
      [regionShape.id]: regionShape,
    });
    const targetChain = [target, parent, grandparent];
    const regionPage = boundsFromPoints(boxCorners(editLocalBox).map((point) => tldrawReferencePoint(point, targetChain)));
    const expectedImageBounds = boundsFromPoints(boxCorners({ x: 0, y: 0, w: 4, h: 2 }).map((point) => tldrawReferencePoint(point, targetChain)));

    await writeLocalSource(ctx, sourceBytes);
    await putSnapshot(ctx.cowartUrl, transformed);
    const responses = await rpc([
      call(1, "make_cowart_mask", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        targetShapeId: target.id,
        region: regionPage,
        maskFileName: "two-ancestor-region.png",
      }),
      call(2, "make_cowart_mask", {
        cowartUrl: ctx.cowartUrl,
        canvasDir: ctx.canvasDir,
        targetShapeId: target.id,
        regionShapeId: regionShape.id,
        maskFileName: "two-ancestor-region-shape.png",
      }),
    ], ctx);

    for (const response of responses) {
      assert.equal(response.error, undefined, JSON.stringify(response));
      const result = structured(response);
      for (const key of ["x", "y", "w", "h"]) {
        assert.ok(Math.abs(result.imageBounds[key] - expectedImageBounds[key]) < 1e-9, `${key}: ${result.imageBounds[key]}`);
      }
      assert.deepEqual(result.pixelRegion, { x: 4, y: 1, w: 4, h: 5 });
      assert.equal(result.pixelRegion.x + result.pixelRegion.w, 8);
      assert.equal(result.pixelRegion.y + result.pixelRegion.h, 6);
    }
  });
});
