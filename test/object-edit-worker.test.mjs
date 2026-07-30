import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  encodeGrayscalePng,
  INTERACTIVE_SEGMENTER_MODEL_SHA256,
  INTERACTIVE_SEGMENTER_MODEL_URL,
  MEDIAPIPE_WASM_BASE_URL,
  assertModelChecksum,
  checkObjectEditWorkerSupport,
  normalizeObjectEditRoi,
  selectForegroundMaskBytes,
  validateMaskDimensions,
} from "../src/objectEditWorker.js";
import { decodeCanonicalMaskPng } from "../shared/cowart-segment-mask.mjs";

test("Given the pinned MediaPipe contract When constants are read Then package WASM and model URLs are exact", () => {
  assert.equal(MEDIAPIPE_WASM_BASE_URL, "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm");
  assert.equal(INTERACTIVE_SEGMENTER_MODEL_URL, "https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite");
  assert.match(INTERACTIVE_SEGMENTER_MODEL_SHA256, /^[a-f0-9]{64}$/);
});

test("Given Worker capability probes When OffscreenCanvas or WebGL2 is missing Then unsupported is honest", () => {
  assert.deepEqual(
    checkObjectEditWorkerSupport({ Worker: function Worker() {}, OffscreenCanvas: undefined }),
    { ok: false, code: "offscreen_canvas_unsupported", message: "Object editing requires OffscreenCanvas in a Worker-capable browser." }
  );
  assert.equal(checkObjectEditWorkerSupport({
    Worker: function Worker() {},
    OffscreenCanvas: class OffscreenCanvas {
      getContext() {
        return null;
      }
    },
  }).code, "webgl2_unsupported");
});

test("Given point and scribble inputs When normalized for MediaPipe Then a deterministic foreground keypoint is used", () => {
  assert.deepEqual(normalizeObjectEditRoi({ mode: "point", point: { x: 0.48, y: 0.54 } }), { keypoint: { x: 0.48, y: 0.54 } });
  assert.deepEqual(normalizeObjectEditRoi({
    mode: "scribble",
    points: [{ x: 0.36, y: 0.39 }, { x: 0.5, y: 0.62 }, { x: 0.58, y: 0.73 }],
  }), { keypoint: { x: 0.48, y: 0.58 } });
});

test("Given category masks with either polarity When foreground is selected Then the ROI category becomes white", () => {
  const backgroundIsOne = {
    width: 2,
    height: 2,
    getAsUint8Array: () => Uint8Array.from([0, 1, 1, 1]),
    closeCalled: false,
    close() {
      this.closeCalled = true;
    },
  };
  const foregroundIsOne = {
    width: 2,
    height: 2,
    getAsUint8Array: () => Uint8Array.from([0, 1, 0, 0]),
    closeCalled: false,
    close() {
      this.closeCalled = true;
    },
  };

  assert.deepEqual(
    selectForegroundMaskBytes({ categoryMask: backgroundIsOne }, 2, 2, { keypoint: { x: 0.25, y: 0.25 } }),
    { width: 2, height: 2, pixels: Uint8Array.from([255, 0, 0, 0]) }
  );
  assert.deepEqual(
    selectForegroundMaskBytes({ categoryMask: foregroundIsOne }, 2, 2, { keypoint: { x: 0.75, y: 0.25 } }),
    { width: 2, height: 2, pixels: Uint8Array.from([0, 255, 0, 0]) }
  );
  assert.equal(backgroundIsOne.closeCalled, true);
  assert.equal(foregroundIsOne.closeCalled, true);
});

test("Given selected foreground bytes When encoded for Segment Store Then PNG decodes as canonical grayscale", () => {
  const encoded = encodeGrayscalePng({ width: 2, height: 2, pixels: Uint8Array.from([0, 255, 255, 0]) });
  const decoded = decodeCanonicalMaskPng(encoded);

  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.deepEqual(decoded.pixels, Uint8Array.from([0, 255, 255, 0]));
});

test("Given downloaded model bytes When checksum differs Then initialization is blocked", async () => {
  const bytes = new TextEncoder().encode("not the official model");
  const digest = createHash("sha256").update(bytes).digest("hex");

  await assert.rejects(assertModelChecksum(bytes, "0".repeat(64)), /checksum/i);
  await assert.doesNotReject(assertModelChecksum(bytes, digest));
});

test("Given malformed MediaPipe category masks When foreground bytes are selected Then a structured worker error is thrown before allocation", () => {
  const mismatchedMask = {
    width: 4,
    height: 3,
    getAsUint8Array: () => Uint8Array.from([1, 1, 1]),
    close() {},
  };

  assert.throws(
    () => selectForegroundMaskBytes({ categoryMask: mismatchedMask }, 4, 3, { keypoint: { x: 0.5, y: 0.5 } }),
    (error) => error.code === "invalid_mask_bytes" && /expected 12/.test(error.message)
  );
});

test("Given oversized MediaPipe dimensions When validated Then a structured worker error blocks allocation", () => {
  assert.throws(
    () => validateMaskDimensions({ width: 8193, height: 1 }, "categoryMask"),
    (error) => error.code === "invalid_mask_dimensions" && /8192/.test(error.message)
  );
  assert.throws(
    () => validateMaskDimensions({ width: 8000, height: 6000 }, "categoryMask"),
    (error) => error.code === "invalid_mask_dimensions" && /40MP/.test(error.message)
  );
  assert.throws(
    () => validateMaskDimensions({ width: 2.5, height: 4 }, "categoryMask"),
    (error) => error.code === "invalid_mask_dimensions"
  );
});

test("Given malformed MediaPipe confidence masks When foreground bytes are selected Then raw type and length are validated", () => {
  const wrongTypeMask = {
    width: 2,
    height: 2,
    getAsFloat32Array: () => Uint8Array.from([1, 0, 0, 0]),
    close() {},
  };
  const wrongLengthMask = {
    width: 2,
    height: 2,
    getAsFloat32Array: () => new Float32Array([1, 0]),
    close() {},
  };

  assert.throws(
    () => selectForegroundMaskBytes({ confidenceMasks: [wrongTypeMask] }, 2, 2),
    (error) => error.code === "invalid_mask_bytes" && /Float32Array/.test(error.message)
  );
  assert.throws(
    () => selectForegroundMaskBytes({ confidenceMasks: [wrongLengthMask] }, 2, 2),
    (error) => error.code === "invalid_mask_bytes" && /expected 4/.test(error.message)
  );
});
