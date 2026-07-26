import test from "node:test";
import assert from "node:assert/strict";

import {
  ObjectEditApiError,
  confirmObjectSegment,
  deleteObjectSegment,
  fetchObjectSegmentMask,
  fetchObjectSegmentPreview,
  getObjectSegment,
  listObjectSegments,
  refineObjectSegment,
} from "../src/objectEditApi.js";

test("Given Segment Store routes When object edit API helpers run Then they use structured JSON errors and AbortSignal", async () => {
  const requests = [];
  const signal = new AbortController().signal;
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/mask") || String(url).endsWith("/preview")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    return Response.json({ ok: true, segment: { segmentId: "segment:one" }, segments: [{ segmentId: "segment:one" }] }, { status: 201 });
  };
  const api = { baseUrl: "http://127.0.0.1:5173", fetchImpl, signal };
  const source = { pageId: "page:one", shapeId: "shape:image", assetId: "asset:image", assetSha256: "abc", width: 2, height: 2 };

  await confirmObjectSegment(api, {
    segmentId: "segment:one",
    source,
    maskBase64: "AA==",
    previewBase64: "AA==",
    selection: { mode: "point" },
    provider: { id: "mediapipe-interactive" },
  });
  await listObjectSegments(api, { shapeId: "shape:image", assetId: "asset:image" });
  await getObjectSegment(api, "segment:one");
  assert.deepEqual(await fetchObjectSegmentMask(api, "segment:one"), new Uint8Array([1, 2, 3]));
  assert.deepEqual(await fetchObjectSegmentPreview(api, "segment:one"), new Uint8Array([1, 2, 3]));
  await refineObjectSegment(api, "segment:one", { segmentId: "segment:two", maskBase64: "AA==", selection: { mode: "refine" } });
  await deleteObjectSegment(api, "segment:one");

  assert.equal(requests[0].url, "http://127.0.0.1:5173/api/canvas/segments/confirm");
  assert.equal(requests[1].url, "http://127.0.0.1:5173/api/canvas/segments?shapeId=shape%3Aimage&assetId=asset%3Aimage");
  assert.equal(requests.at(-1).init.method, "DELETE");
  assert.ok(requests.every((request) => request.init.signal === signal));
});

test("Given a Segment Store JSON failure When an API helper runs Then a typed error preserves code status and details", async () => {
  const fetchImpl = async () => Response.json({ error: "Source asset bytes changed.", code: "source_asset_changed", details: { expected: "a", actual: "b" } }, { status: 409 });

  await assert.rejects(
    confirmObjectSegment({ fetchImpl }, { segmentId: "segment:bad" }),
    (error) => {
      assert.ok(error instanceof ObjectEditApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "source_asset_changed");
      assert.deepEqual(error.details, { expected: "a", actual: "b" });
      return true;
    }
  );
});

test("Given a Segment Store non-JSON failure When an API helper runs Then callers receive typed Cowart error instead of SyntaxError", async () => {
  const fetchImpl = async () => new Response("<html>Bad Gateway</html>", {
    status: 502,
    statusText: "Bad Gateway",
    headers: { "content-type": "text/html" },
  });

  await assert.rejects(
    listObjectSegments({ fetchImpl }),
    (error) => {
      assert.ok(error instanceof ObjectEditApiError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "object_edit_api_error");
      assert.match(error.message, /Bad Gateway|502/);
      return true;
    }
  );
});
