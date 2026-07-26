import test from "node:test";
import assert from "node:assert/strict";

import { createImageCoordinateMapper } from "../shared/cowart-image-coordinates.mjs";
import {
  OBJECT_EDIT_TEST_IDS,
  buildObjectEditSource,
  getObjectEditToolState,
  isLocalPageAssetUrl,
} from "../src/objectEditState.js";
import {
  createPreviewUrlStore,
  getObjectEditPanelDock,
  getPreviewLayout,
} from "../src/objectEditGeometry.js";

function fakeEditor({ selected = ["shape:image"], shape, asset, toolId = "select" } = {}) {
  const pageId = "page:one";
  return {
    getCurrentPageId: () => pageId,
    getCurrentToolId: () => toolId,
    getSelectedShapeIds: () => selected,
    getShape: (id) => (id === shape?.id ? shape : null),
    getAsset: (id) => (id === asset?.id ? asset : null),
  };
}

function imageFixture(overrides = {}) {
  const asset = {
    id: "asset:image",
    type: "image",
    props: {
      src: "/page-assets/page/source.png",
      w: 1000,
      h: 500,
      mimeType: "image/png",
    },
    meta: { cowartSha256: "abc123" },
  };
  const shape = {
    id: "shape:image",
    type: "image",
    parentId: "page:one",
    x: 10,
    y: 20,
    rotation: 0,
    props: { assetId: asset.id, w: 200, h: 100 },
    ...overrides.shape,
  };
  return { asset: { ...asset, ...overrides.asset }, shape };
}

test("Given one filled local image selection When object editing evaluates state Then source identity is complete and local-only", () => {
  const { shape, asset } = imageFixture();
  const editor = fakeEditor({ shape, asset, toolId: "cowart-object-edit" });

  assert.equal(isLocalPageAssetUrl(asset.props.src, "http://127.0.0.1:5173/"), true);
  assert.equal(isLocalPageAssetUrl("https://example.com/image.png", "http://127.0.0.1:5173/"), false);
  assert.deepEqual(buildObjectEditSource(editor), {
    pageId: "page:one",
    shapeId: "shape:image",
    assetId: "asset:image",
    assetSha256: "abc123",
    width: 1000,
    height: 500,
  });
  assert.deepEqual(getObjectEditToolState(editor), { kind: "ready" });
});

test("Given unsupported selections or non-local sources When object editing evaluates state Then it does not fake readiness", () => {
  const { shape, asset } = imageFixture();

  assert.deepEqual(getObjectEditToolState(fakeEditor({ selected: [] })), { kind: "idle" });
  assert.deepEqual(getObjectEditToolState(fakeEditor({ selected: ["one", "two"] })), { kind: "unsupported_selection" });
  assert.deepEqual(getObjectEditToolState(fakeEditor({ shape: { ...shape, type: "geo" }, asset })), { kind: "unsupported_selection" });
  assert.deepEqual(
    getObjectEditToolState(fakeEditor({ shape, asset: { ...asset, props: { ...asset.props, src: "https://example.com/image.png" } } })),
    { kind: "source_not_local" }
  );
  assert.deepEqual(
    getObjectEditToolState(fakeEditor({ shape, asset: { ...asset, meta: {} } })),
    { kind: "missing_source_hash" }
  );
});

test("Given accessibility requirements When exported test IDs are read Then the overlay selectors are stable", () => {
  assert.deepEqual(OBJECT_EDIT_TEST_IDS, {
    tool: "object-edit.tool",
    overlay: "object-edit.overlay",
    status: "object-edit.status",
    loading: "object-edit.loading",
    error: "object-edit.error",
    accept: "object-edit.accept",
    cancel: "object-edit.cancel",
    retry: "object-edit.retry",
  });
});

test("Given cropped and flipped tldraw images When preview layout is derived Then the natural mask maps into the visible crop", () => {
  const source = { pageId: "page:one", shapeId: "shape:image", assetId: "asset:image", assetSha256: "abc", width: 1000, height: 500 };
  const cases = [
    { name: "crop", props: { crop: { topLeft: { x: 0.1, y: 0.2 }, bottomRight: { x: 0.9, y: 0.8 } } }, expected: [0.25, 0, 0, 1 / 3, -25, -100 / 3] },
    { name: "flipX", props: { crop: { topLeft: { x: 0.1, y: 0.2 }, bottomRight: { x: 0.9, y: 0.8 } }, flipX: true }, expected: [-0.25, 0, 0, 1 / 3, 225, -100 / 3] },
    { name: "flipY", props: { crop: { topLeft: { x: 0.1, y: 0.2 }, bottomRight: { x: 0.9, y: 0.8 } }, flipY: true }, expected: [0.25, 0, 0, -1 / 3, -25, 400 / 3] },
  ];

  for (const item of cases) {
    const mapper = createImageCoordinateMapper({
      source,
      shape: { id: "shape:image", x: 0, y: 0, props: { assetId: "asset:image", w: 200, h: 100, ...item.props } },
      ancestors: [],
    });
    const layout = getPreviewLayout({
      editor: { pageToScreen: (point) => point },
      mapper,
      source,
    });
    const actual = layout.imageMatrix;

    assert.equal(layout.imageStyle.width, "1000px", item.name);
    assert.equal(layout.imageStyle.height, "500px", item.name);
    item.expected.forEach((expectedValue, index) => {
      assert.ok(Math.abs(actual[index] - expectedValue) < 0.000001, `${item.name} matrix[${index}]`);
    });
  }
});

test("Given mobile toolbar geometry When panel is docked Then it stays above toolbar and within viewport", () => {
  const dock = getObjectEditPanelDock({
    viewport: { width: 375, height: 812 },
    anchor: { x: 520, y: 618 },
    panel: { width: 351, height: 98 },
    avoidRects: [{ x: 0, y: 714, width: 399, height: 90 }],
  });

  assert.deepEqual(dock, { left: 12, top: 608 });
  assert.ok(dock.top + 98 <= 706);
});

test("Given preview object URLs When candidates are replaced or cleared Then stale object URLs are revoked exactly once", () => {
  const calls = [];
  const store = createPreviewUrlStore({
    createObjectURL: (blob) => `blob:${blob.size}`,
    revokeObjectURL: (url) => calls.push(url),
  });

  assert.equal(store.replace(new Uint8Array([1, 2, 3])), "blob:3");
  assert.equal(store.replace(new Uint8Array([4])), "blob:1");
  store.clear();
  store.clear();

  assert.deepEqual(calls, ["blob:3", "blob:1"]);
});
