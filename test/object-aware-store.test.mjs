import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { encodeCanonicalMaskPng } from "../shared/cowart-segment-mask.mjs";
import { withViteHarness as withSharedViteHarness } from "./object-aware-mcp-harness.mjs";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const imageBytes = () => Buffer.from(PNG_1X1, "base64");
const otherImageBytes = () => Buffer.from("distinct-page-asset-bytes");
const maskPng = (pixels = Uint8Array.from([255])) => encodeCanonicalMaskPng({ width: 1, height: 1, pixels });
const source = (assetSha256) => ({ pageId: "page:one", shapeId: "shape:image", assetId: "asset:image", assetSha256, width: 1, height: 1 });

const oversizedMaskPng = () => {
  const png = Buffer.from(maskPng());
  png.writeUInt32BE(8193, 16);
  png.writeUInt32BE(zlib.crc32(Buffer.concat([png.subarray(12, 16), png.subarray(16, 29)])) >>> 0, 29);
  return png;
};

const withViteHarness = (fn) => withSharedViteHarness(fn, { prefix: "cowart-object-store-" });

function snapshot(src = `data:image/png;base64,${PNG_1X1}`) {
  return {
    schema: { schemaVersion: 2 },
    store: {
      "page:one": { id: "page:one", typeName: "page", name: "One", meta: {}, index: "a1" },
      "asset:image": { id: "asset:image", typeName: "asset", type: "image", meta: {}, props: { name: "pixel.png", src, w: 1, h: 1, mimeType: "image/png" } },
      "shape:image": { id: "shape:image", typeName: "shape", type: "image", parentId: "page:one", x: 0, y: 0, rotation: 0, index: "a1", meta: {}, props: { assetId: "asset:image", w: 10, h: 10 } },
    },
  };
}

function duplicateNameSnapshot(firstSrc = "/assets/a/same.png", secondSrc = "/assets/b/same.png") {
  return {
    schema: { schemaVersion: 2 },
    store: {
      "page:one": { id: "page:one", typeName: "page", name: "One", meta: {}, index: "a1" },
      "asset:first": { id: "asset:first", typeName: "asset", type: "image", meta: {}, props: { name: "same.png", src: firstSrc, w: 1, h: 1, mimeType: "image/png" } },
      "asset:second": { id: "asset:second", typeName: "asset", type: "image", meta: {}, props: { name: "same.png", src: secondSrc, w: 1, h: 1, mimeType: "image/png" } },
      "shape:first": { id: "shape:first", typeName: "shape", type: "image", parentId: "page:one", x: 0, y: 0, rotation: 0, index: "a1", meta: {}, props: { assetId: "asset:first", w: 10, h: 10 } },
      "shape:second": { id: "shape:second", typeName: "shape", type: "image", parentId: "page:one", x: 20, y: 0, rotation: 0, index: "a2", meta: {}, props: { assetId: "asset:second", w: 10, h: 10 } },
    },
  };
}

function crossPageTraversalSnapshot(src) {
  const value = snapshot(src);
  value.store["page:two"] = { id: "page:two", typeName: "page", name: "Two", meta: {}, index: "a2" };
  return value;
}

function sourceShapeOnPageTwoSnapshot() {
  const value = snapshot();
  value.store["page:two"] = { id: "page:two", typeName: "page", name: "Two", meta: {}, index: "a2" };
  value.store["shape:image"] = { ...value.store["shape:image"], parentId: "page:two" };
  return value;
}

function nestedSourceSnapshot(parentId = "page:one") {
  const value = snapshot();
  if (parentId === "page:two") value.store["page:two"] = { id: "page:two", typeName: "page", name: "Two", meta: {}, index: "a2" };
  value.store["shape:frame"] = { id: "shape:frame", typeName: "shape", type: "frame", parentId, x: 0, y: 0, rotation: 0, index: "a1", meta: {}, props: { w: 100, h: 100 } };
  value.store["shape:group"] = { id: "shape:group", typeName: "shape", type: "group", parentId: "shape:frame", x: 0, y: 0, rotation: 0, index: "a2", meta: {}, props: {} };
  value.store["shape:image"] = { ...value.store["shape:image"], parentId: "shape:group", index: "a3" };
  return value;
}

function currentPageSnapshotWith(records) {
  return {
    schema: { schemaVersion: 2 },
    store: {
      "page:one": { id: "page:one", typeName: "page", name: "One", meta: {}, index: "a1" },
      "asset:image": { id: "asset:image", typeName: "asset", type: "image", meta: { cowartSha256: sha256(imageBytes()) }, props: { name: "asset-image.png", src: "/page-assets/one/asset-image.png", fileSize: imageBytes().length, w: 1, h: 1, mimeType: "image/png" } },
      ...records,
    },
  };
}

async function writeCurrentPageSnapshot(canvasDir, records) {
  await writeFile(join(canvasDir, "pages", "one", "cowart-canvas.json"), `${JSON.stringify(currentPageSnapshotWith(records), null, 2)}\n`);
}

async function requestJson(url, method, body) {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

async function requestOversizedJson(url, byteLength) {
  const target = new URL(url);
  const responseText = await new Promise((resolveResponse, rejectResponse) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(byteLength) },
    });
    req.setTimeout(5000, () => req.destroy(new Error("Timed out waiting for oversized response")));
    req.on("error", rejectResponse);
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolveResponse({ status: res.statusCode, headers: res.headers, body }));
    });
    req.write("{");
    const chunk = Buffer.alloc(1024 * 1024, "a");
    let written = 1;
    function writeMore() {
      while (written < byteLength) {
        const next = chunk.subarray(0, Math.min(chunk.length, byteLength - written));
        written += next.length;
        if (!req.write(next)) {
          req.once("drain", writeMore);
          return;
        }
      }
      req.end();
    }
    writeMore();
  });
  return { ...responseText, body: JSON.parse(responseText.body) };
}

async function interruptPost(url, prefix) {
  const target = new URL(url);
  await new Promise((resolveInterrupt) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(prefix.length + 1024) },
    });
    req.on("error", resolveInterrupt);
    req.write(prefix);
    req.destroy();
  });
}

async function waitForPromise(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function putSnapshot(cowartUrl, payload) {
  const result = await requestJson(`${cowartUrl}/api/canvas`, "PUT", payload);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function getCanvas(cowartUrl) {
  const result = await requestJson(`${cowartUrl}/api/canvas`, "GET");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function confirm(cowartUrl, body = {}) {
  return requestJson(`${cowartUrl}/api/canvas/segments/confirm`, "POST", {
    segmentId: "segment:fixture",
    source: source(sha256(imageBytes())),
    maskBase64: maskPng().toString("base64"),
    previewBase64: maskPng().toString("base64"),
    selection: { mode: "point", points: [{ x: 0, y: 0, label: "positive" }] },
    provider: { id: "test", runtime: "browser", processing: "local", model: "fixture", version: "1" },
    ...body,
  });
}

async function tree(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(relative(root, path));
    }
  }
  await walk(root);
  return files.sort();
}

test("Given image snapshots When localized imported and replaced Then existing page assets and revisions are preserved and assets gain SHA identity", async () => {
  await withViteHarness(async ({ canvasDir, cowartUrl }) => {
    const first = await putSnapshot(cowartUrl, snapshot());
    const loaded = await getCanvas(cowartUrl);
    const asset = loaded.snapshot.store["asset:image"];
    assert.equal(first.revision, 1);
    assert.match(asset.props.src, /^\/page-assets\/one\/asset-image\.png$/);
    assert.equal(asset.props.fileSize, imageBytes().length);
    assert.equal(asset.meta.cowartSha256, sha256(imageBytes()));

    const assetPath = join(canvasDir, "pages", "one", "assets", "asset-image.png");
    await writeFile(assetPath, imageBytes());
    await putSnapshot(cowartUrl, snapshot("/page-assets/one/asset-image.png"));
    const relocalized = await getCanvas(cowartUrl);
    assert.equal(relocalized.revision, 2);
    assert.equal(relocalized.snapshot.store["asset:image"].meta.cowartSha256, sha256(imageBytes()));
  });
});

test("Given same-name local image assets When the page is saved Then each asset keeps distinct bytes and SHA identity", async () => {
  await withViteHarness(async ({ canvasDir, cowartUrl }) => {
    await mkdir(join(canvasDir, "assets", "a"), { recursive: true });
    await mkdir(join(canvasDir, "assets", "b"), { recursive: true });
    await writeFile(join(canvasDir, "assets", "a", "same.png"), imageBytes());
    await writeFile(join(canvasDir, "assets", "b", "same.png"), otherImageBytes());
    await putSnapshot(cowartUrl, duplicateNameSnapshot());
    const loaded = await getCanvas(cowartUrl);
    const first = loaded.snapshot.store["asset:first"];
    const second = loaded.snapshot.store["asset:second"];
    assert.notEqual(first.props.src, second.props.src);
    assert.notEqual(first.props.name, second.props.name);
    assert.equal(first.meta.cowartSha256, sha256(imageBytes()));
    assert.equal(second.meta.cowartSha256, sha256(otherImageBytes()));

    const firstPath = join(canvasDir, "pages", "one", "assets", decodeURIComponent(first.props.src.split("/").pop()));
    const secondPath = join(canvasDir, "pages", "one", "assets", decodeURIComponent(second.props.src.split("/").pop()));
    assert.notEqual(firstPath, secondPath);
    assert.equal(sha256(await readFile(firstPath)), sha256(imageBytes()));
    assert.equal(sha256(await readFile(secondPath)), sha256(otherImageBytes()));
  });
});

test("Given encoded cross-page traversal in a page asset URL When served or used for source preconditions Then it is rejected", async () => {
  await withViteHarness(async ({ canvasDir, cowartUrl }) => {
    const external = otherImageBytes();
    await mkdir(join(canvasDir, "pages", "two", "assets"), { recursive: true });
    await writeFile(join(canvasDir, "pages", "two", "assets", "external.png"), external);
    const maliciousSrc = "/page-assets/one/..%2F..%2Ftwo/assets/external.png";
    await putSnapshot(cowartUrl, crossPageTraversalSnapshot(maliciousSrc));

    const served = await fetch(`${cowartUrl}${maliciousSrc}`);
    assert.notEqual(served.status, 200);
    const created = await confirm(cowartUrl, { source: source(sha256(external)) });
    assert.equal(created.status, 409, JSON.stringify(created.body));
    assert.equal(created.body.code, "source_asset_not_local");
  });
});

test("Given a symlinked page asset When served or used for source preconditions Then symlink traversal is rejected without leaking paths", async () => {
  await withViteHarness(async ({ canvasDir, cowartUrl }) => {
    await mkdir(join(canvasDir, "pages", "one", "assets"), { recursive: true });
    await symlink("/etc/hosts", join(canvasDir, "pages", "one", "assets", "hosts.png"));
    await putSnapshot(cowartUrl, snapshot("/page-assets/one/hosts.png"));
    const hostsHash = sha256(await readFile("/etc/hosts"));

    const served = await fetch(`${cowartUrl}/page-assets/one/hosts.png`);
    assert.notEqual(served.status, 200);
    const body = await served.text();
    assert.equal(body.includes("/etc/hosts"), false);
    assert.equal(body.includes(canvasDir), false);

    const created = await confirm(cowartUrl, { source: source(hostsHash) });
    assert.equal(created.status, 409, JSON.stringify(created.body));
    assert.equal(created.body.code, "source_asset_not_local");
    assert.equal(JSON.stringify(created.body).includes("/etc/hosts"), false);
    assert.equal(JSON.stringify(created.body).includes(canvasDir), false);
  });
});

test("Given a deterministic page asset destination is a symlink When the canvas is saved Then PUT does not overwrite outside bytes", async () => {
  await withViteHarness(async ({ canvasDir, cowartUrl }) => {
    const outsidePath = join(canvasDir, "..", "outside-page-asset-target.txt");
    const outsideBytes = Buffer.from("outside bytes must stay unchanged");
    await writeFile(outsidePath, outsideBytes);
    await mkdir(join(canvasDir, "pages", "one", "assets"), { recursive: true });
    const destinationPath = join(canvasDir, "pages", "one", "assets", "asset-image.png");
    await symlink(outsidePath, destinationPath);

    const result = await requestJson(`${cowartUrl}/api/canvas`, "PUT", snapshot());
    assert.notEqual(result.status, 200, JSON.stringify(result.body));
    assert.equal(sha256(await readFile(outsidePath)), sha256(outsideBytes));
    assert.equal((await lstat(destinationPath)).isSymbolicLink(), true);
    assert.equal(JSON.stringify(result.body).includes(outsidePath), false);
    assert.equal(JSON.stringify(result.body).includes(canvasDir), false);
  });
});

test("Given a page id that resolves above the pages directory When the canvas is saved Then the request is rejected before root files are written", async () => {
  await withViteHarness(async ({ canvasDir, cowartUrl }) => {
    const malicious = {
      schema: { schemaVersion: 2 },
      store: {
        "page:..": { id: "page:..", typeName: "page", name: "Unsafe", meta: {}, index: "a1" },
      },
    };

    const result = await requestJson(`${cowartUrl}/api/canvas`, "PUT", malicious);

    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.code, "invalid_page_id");
    await assert.rejects(readFile(join(canvasDir, "cowart-canvas.json")), { code: "ENOENT" });
    await assert.rejects(readdir(join(canvasDir, "assets")), { code: "ENOENT" });
    await assert.rejects(readFile(join(canvasDir, "pages", "manifest.json")), { code: "ENOENT" });
  });
});

test("Given a local image source When segments are confirmed refined listed fetched and deleted Then immutable store semantics hold without a canvas revision bump", async () => {
  await withViteHarness(async ({ cowartUrl }) => {
    await putSnapshot(cowartUrl, snapshot());
    const beforeRevision = (await getCanvas(cowartUrl)).revision;

    const created = await confirm(cowartUrl);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.segment.segmentId, "segment:fixture");
    assert.equal((await getCanvas(cowartUrl)).revision, beforeRevision);

    const listed = await requestJson(`${cowartUrl}/api/canvas/segments?shapeId=shape:image&assetId=asset:image`, "GET");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.segments.map((segment) => segment.segmentId), ["segment:fixture"]);

    const mask = await fetch(`${cowartUrl}/api/canvas/segments/segment%3Afixture/mask`);
    const preview = await fetch(`${cowartUrl}/api/canvas/segments/segment%3Afixture/preview`);
    assert.equal(mask.status, 200);
    assert.equal(preview.status, 200);
    assert.equal(Buffer.compare(Buffer.from(await mask.arrayBuffer()), maskPng()), 0);

    const refined = await requestJson(`${cowartUrl}/api/canvas/segments/segment%3Afixture/refine`, "POST", {
      segmentId: "segment:child",
      maskBase64: maskPng(Uint8Array.from([128])).toString("base64"),
      previewBase64: maskPng(Uint8Array.from([128])).toString("base64"),
      selection: { mode: "refine" },
    });
    assert.equal(refined.status, 201, JSON.stringify(refined.body));
    assert.equal(refined.body.segment.parentSegmentId, "segment:fixture");

    assert.equal((await requestJson(`${cowartUrl}/api/canvas/segments/segment%3Afixture`, "GET")).body.segment.mask.area, 1);
    assert.equal((await requestJson(`${cowartUrl}/api/canvas/segments/segment%3Afixture`, "DELETE")).status, 409);
    assert.equal((await requestJson(`${cowartUrl}/api/canvas/segments/segment%3Achild`, "DELETE")).status, 200);

    const referenced = await requestJson(`${cowartUrl}/api/canvas/records`, "POST", {
      put: [{ id: "shape:result", typeName: "shape", type: "image", parentId: "page:one", x: 20, y: 0, rotation: 0, index: "a2", meta: { cowartObjectEdit: { segmentId: "segment:fixture" } }, props: { assetId: "asset:image", w: 10, h: 10 } }],
      conditions: [{ type: "sourceAsset", source: source(sha256(imageBytes())) }],
    });
    assert.equal(referenced.status, 200, JSON.stringify(referenced.body));
    const deleteReferenced = await requestJson(`${cowartUrl}/api/canvas/segments/segment%3Afixture`, "DELETE");
    assert.equal(deleteReferenced.status, 409, JSON.stringify(deleteReferenced.body));
    assert.equal(deleteReferenced.body.code, "segment_referenced");
    const retained = await requestJson(`${cowartUrl}/api/canvas/segments/segment%3Afixture`, "GET");
    assert.equal(retained.status, 200, JSON.stringify(retained.body));
    assert.equal(retained.body.segment.segmentId, "segment:fixture");
  });
});

test("Given segment source page ownership boundaries When confirming refining or writeback preconditions run Then only shapes descended from the declared page are accepted", async () => {
  await withViteHarness(async ({ canvasDir, cowartUrl }) => {
    await putSnapshot(cowartUrl, sourceShapeOnPageTwoSnapshot());
    const crossPage = await confirm(cowartUrl, { segmentId: "segment:cross-page-source" });
    assert.equal(crossPage.status, 409, JSON.stringify(crossPage.body));
    assert.equal(crossPage.body.code, "source_shape_page_mismatch");
    assert.equal(JSON.stringify(crossPage.body).includes(canvasDir), false);
    assert.deepEqual((await tree(canvasDir)).filter((file) => file.includes("segments") || file.includes(".cowart-segment-staging")), []);

    await putSnapshot(cowartUrl, snapshot());
    const direct = await confirm(cowartUrl, { segmentId: "segment:direct-child" });
    assert.equal(direct.status, 201, JSON.stringify(direct.body));
    assert.equal(direct.body.segment.source.pageId, "page:one");

    await putSnapshot(cowartUrl, nestedSourceSnapshot());
    const nested = await confirm(cowartUrl, { segmentId: "segment:nested-child" });
    assert.equal(nested.status, 201, JSON.stringify(nested.body));
    assert.equal(nested.body.segment.source.shapeId, "shape:image");

    await putSnapshot(cowartUrl, sourceShapeOnPageTwoSnapshot());
    const beforeWritebackRevision = (await getCanvas(cowartUrl)).revision;
    const staleWriteback = await requestJson(`${cowartUrl}/api/canvas/records`, "POST", {
      put: [{ id: "shape:writeback-result", typeName: "shape", type: "geo", parentId: "page:one", x: 0, y: 0, rotation: 0, index: "a4", meta: {}, props: { w: 10, h: 10, color: "red" } }],
      conditions: [{ type: "sourceAsset", source: source(sha256(imageBytes())) }],
    });
    assert.equal(staleWriteback.status, 409, JSON.stringify(staleWriteback.body));
    assert.equal(staleWriteback.body.code, "source_shape_page_mismatch");
    assert.equal((await getCanvas(cowartUrl)).revision, beforeWritebackRevision);

    await putSnapshot(cowartUrl, snapshot());
    const parent = await confirm(cowartUrl, { segmentId: "segment:parent-for-refine" });
    assert.equal(parent.status, 201, JSON.stringify(parent.body));
    await putSnapshot(cowartUrl, sourceShapeOnPageTwoSnapshot());
    const staleRefine = await requestJson(`${cowartUrl}/api/canvas/segments/segment%3Aparent-for-refine/refine`, "POST", {
      segmentId: "segment:stale-refine",
      maskBase64: maskPng(Uint8Array.from([128])).toString("base64"),
      previewBase64: maskPng(Uint8Array.from([128])).toString("base64"),
      selection: { mode: "refine" },
    });
    assert.equal(staleRefine.status, 409, JSON.stringify(staleRefine.body));
    assert.equal(staleRefine.body.code, "source_shape_page_mismatch");

    await putSnapshot(cowartUrl, nestedSourceSnapshot("page:two"));
    const wrongPageNested = await confirm(cowartUrl, { segmentId: "segment:wrong-page-nested" });
    assert.equal(wrongPageNested.status, 409, JSON.stringify(wrongPageNested.body));
    assert.equal(wrongPageNested.body.code, "source_shape_page_mismatch");

    await putSnapshot(cowartUrl, snapshot());
    await writeCurrentPageSnapshot(canvasDir, {
      "shape:image": { id: "shape:image", typeName: "shape", type: "image", parentId: "shape:missing", x: 0, y: 0, rotation: 0, index: "a1", meta: {}, props: { assetId: "asset:image", w: 10, h: 10 } },
    });
    const missingAncestor = await waitForPromise(confirm(cowartUrl, { segmentId: "segment:missing-ancestor" }), 1000, "missing ancestor rejection");
    assert.equal(missingAncestor.status, 409, JSON.stringify(missingAncestor.body));
    assert.equal(missingAncestor.body.code, "source_shape_page_mismatch");

    await writeCurrentPageSnapshot(canvasDir, {
      "shape:image": { id: "shape:image", typeName: "shape", type: "image", parentId: "shape:cycle", x: 0, y: 0, rotation: 0, index: "a1", meta: {}, props: { assetId: "asset:image", w: 10, h: 10 } },
      "shape:cycle": { id: "shape:cycle", typeName: "shape", type: "group", parentId: "shape:image", x: 0, y: 0, rotation: 0, index: "a2", meta: {}, props: {} },
    });
    const cyclicAncestor = await waitForPromise(confirm(cowartUrl, { segmentId: "segment:cyclic-ancestor" }), 1000, "cyclic ancestor rejection");
    assert.equal(cyclicAncestor.status, 409, JSON.stringify(cyclicAncestor.body));
    assert.equal(cyclicAncestor.body.code, "source_shape_page_mismatch");
  });
});

test("Given malformed stale duplicate and traversal inputs When segment routes run Then structured errors and clean staging are returned", async () => {
  await withViteHarness(async ({ canvasDir, cowartUrl }) => {
    await putSnapshot(cowartUrl, snapshot());
    assert.equal((await confirm(cowartUrl)).status, 201);
    assert.equal((await confirm(cowartUrl)).status, 409);

    const badPath = await requestJson(`${cowartUrl}/api/canvas/segments/..%2Fescape`, "GET");
    assert.equal(badPath.status, 400);
    assert.equal(badPath.body.code, "invalid_id");
    const badEncoding = await requestJson(`${cowartUrl}/api/canvas/segments/%E0%A4%A`, "GET");
    assert.equal(badEncoding.status, 400);
    assert.equal(badEncoding.body.code, "invalid_segment_route");
    const malformed = await confirm(cowartUrl, { segmentId: "segment:bad", maskBase64: Buffer.from("bad").toString("base64") });
    assert.equal(malformed.status, 400);
    const oversized = await confirm(cowartUrl, { segmentId: "segment:oversized", maskBase64: oversizedMaskPng().toString("base64") });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.body.code, "png_too_large");
    await interruptPost(`${cowartUrl}/api/canvas/segments/confirm`, '{"segmentId":"segment:interrupted",');
    assert.ok(!(await tree(canvasDir)).some((file) => file.includes(".tmp-segment") || file.includes("segment%3Ainterrupted")));
    const wrongShape = await confirm(cowartUrl, { segmentId: "segment:wrong-shape", source: { ...source(sha256(imageBytes())), shapeId: "shape:missing" } });
    assert.equal(wrongShape.status, 409);
    const wrongAsset = await confirm(cowartUrl, { segmentId: "segment:wrong-asset", source: { ...source(sha256(imageBytes())), assetId: "asset:missing" } });
    assert.equal(wrongAsset.status, 409);
    const wrongDims = await confirm(cowartUrl, { segmentId: "segment:wrong-dims", source: { ...source(sha256(imageBytes())), width: 2 } });
    assert.equal(wrongDims.status, 409);

    await writeFile(join(canvasDir, "pages", "one", "assets", "asset-image.png"), maskPng());
    const beforeStaleWriteback = (await getCanvas(cowartUrl)).revision;
    const staleWriteback = await requestJson(`${cowartUrl}/api/canvas/records`, "POST", {
      put: [{ id: "shape:stale-result", typeName: "shape", type: "geo", parentId: "page:one", x: 0, y: 0, rotation: 0, index: "a3", meta: {}, props: { w: 10, h: 10, color: "red" } }],
      conditions: [{ type: "sourceAsset", source: source(sha256(imageBytes())) }],
    });
    assert.equal(staleWriteback.status, 409, JSON.stringify(staleWriteback.body));
    assert.equal(staleWriteback.body.code, "source_asset_changed");
    assert.equal((await getCanvas(cowartUrl)).revision, beforeStaleWriteback);
    const stale = await confirm(cowartUrl, { segmentId: "segment:stale" });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "source_asset_changed");
    assert.ok(!(await tree(canvasDir)).some((file) => file.includes(".tmp-segment")));
  });
});

test("Given segment JSON exceeds the body limit When posted over raw HTTP Then the API returns structured 413 without staging residue", async () => {
  await withViteHarness(async ({ canvasDir, cowartUrl }) => {
    await putSnapshot(cowartUrl, snapshot());
    const response = await requestOversizedJson(`${cowartUrl}/api/canvas/segments/confirm`, 33 * 1024 * 1024);
    assert.equal(response.status, 413, JSON.stringify(response.body));
    assert.equal(response.body.code, "payload_too_large");
    assert.equal(response.body.error, "Request payload is too large.");
    assert.equal(response.headers["content-type"], "application/json");
    assert.deepEqual((await tree(canvasDir)).filter((file) => file.includes("segments") || file.includes(".cowart-segment-staging")), []);
  });
});

test("Given visible staging-like segment directories When listing segments Then unpublished candidates are ignored", async () => {
  const canvasDir = await mkdtemp(join(tmpdir(), "cowart-object-store-direct-"));
  try {
    const { createSegmentStore } = await import("../shared/cowart-segment-store.mjs");
    const store = createSegmentStore({ pagesDir: join(canvasDir, "pages"), now: () => "2026-07-18T00:00:00.000Z" });
    const staged = join(canvasDir, "pages", "one", "segments", ".tmp-segment-reviewer");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "manifest.json"), `${JSON.stringify({ segmentId: "segment:staged", source: source(sha256(imageBytes())), createdAt: "2026-07-18T00:00:00.000Z" })}\n`);
    assert.deepEqual(await store.list(), []);
    await assert.rejects(store.get("segment:staged"), /Segment not found/);
  } finally {
    await rm(canvasDir, { recursive: true, force: true });
  }
});

test("Given a publish paused after staging When segments are listed concurrently Then no partial candidate appears", async () => {
  const canvasDir = await mkdtemp(join(tmpdir(), "cowart-object-store-direct-"));
  try {
    const { createSegmentStore } = await import("../shared/cowart-segment-store.mjs");
    const store = createSegmentStore({
      pagesDir: join(canvasDir, "pages"),
      now: () => "2026-07-18T00:00:00.000Z",
      publishHooks: {
        beforePublish: async () => {
          stagedReady();
          await staged;
        },
      },
    });
    await mkdir(join(canvasDir, "pages", "one"), { recursive: true });
    let releasePublish;
    const staged = new Promise((resolveStaged) => {
      releasePublish = resolveStaged;
    });
    let stagedReady;
    const stagedReadyPromise = new Promise((resolveStagedReady) => {
      stagedReady = resolveStagedReady;
    });
    const published = store.confirm({
      segmentId: "segment:paused",
      pageId: "page:one",
      source: source(sha256(imageBytes())),
      maskPng: maskPng(),
      previewPng: maskPng(),
      selection: { mode: "point" },
      provider: { id: "test" },
    });
    await waitForPromise(stagedReadyPromise, 1000, "staged publish barrier");
    assert.deepEqual(await store.list(), []);
    releasePublish();
    assert.equal((await published).segmentId, "segment:paused");
    assert.deepEqual((await store.list()).map((segment) => segment.segmentId), ["segment:paused"]);
  } finally {
    await rm(canvasDir, { recursive: true, force: true });
  }
});

test("Given test-control-shaped fields in operation input When confirming a segment Then the public store input ignores them", async () => {
  const canvasDir = await mkdtemp(join(tmpdir(), "cowart-object-store-direct-"));
  try {
    const { createSegmentStore } = await import("../shared/cowart-segment-store.mjs");
    const store = createSegmentStore({ pagesDir: join(canvasDir, "pages"), now: () => "2026-07-18T00:00:00.000Z" });
    await mkdir(join(canvasDir, "pages", "one"), { recursive: true });
    let operationHookCalls = 0;
    const manifest = await store.confirm({
      segmentId: "segment:public-input",
      pageId: "page:one",
      source: source(sha256(imageBytes())),
      maskPng: maskPng(),
      previewPng: maskPng(),
      selection: { mode: "point" },
      provider: { id: "test" },
      pauseBeforePublish: async () => { operationHookCalls += 1; },
      failAfterStage: true,
    });
    assert.equal(manifest.segmentId, "segment:public-input");
    assert.equal(operationHookCalls, 0);
    assert.deepEqual((await store.list()).map((segment) => segment.segmentId), ["segment:public-input"]);
  } finally {
    await rm(canvasDir, { recursive: true, force: true });
  }
});

test("Given injected publication failures When the real store writes Then no partial segment directory remains", async () => {
  const canvasDir = await mkdtemp(join(tmpdir(), "cowart-object-store-direct-"));
  try {
    const { createSegmentStore } = await import("../shared/cowart-segment-store.mjs");
    const store = createSegmentStore({
      pagesDir: join(canvasDir, "pages"),
      now: () => "2026-07-18T00:00:00.000Z",
      publishHooks: {
        beforePublish: () => {
          throw new Error("Injected publication failure.");
        },
      },
    });
    const pageDir = join(canvasDir, "pages", "one");
    await mkdir(pageDir, { recursive: true });
    await assert.rejects(
      store.confirm({
        segmentId: "segment:fail",
        pageId: "page:one",
        source: source(sha256(imageBytes())),
        maskPng: maskPng(),
        previewPng: maskPng(),
        selection: { mode: "point" },
        provider: { id: "test" },
      }),
      /injected/i
    );
    assert.deepEqual((await tree(canvasDir)).filter((file) => file.includes("segments")), []);
  } finally {
    await rm(canvasDir, { recursive: true, force: true });
  }
});
