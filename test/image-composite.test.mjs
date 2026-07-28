import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import {
  decodeRgbaForTest,
  extractMaskedObject,
  preserveOutsideComposite,
} from "../mcp/image-composite.mjs";
import { encodeCanonicalMaskPng } from "../shared/cowart-segment-mask.mjs";

function rawPng(width, height, pixels) {
  return sharp(Buffer.from(pixels), { raw: { width, height, channels: 4 } }).png().toBuffer();
}

test("Given a selection mask When a candidate is composited Then every outside RGBA byte remains identical", async () => {
  const sourcePixels = [
    1, 2, 3, 4,
    10, 20, 30, 40,
    50, 60, 70, 80,
    90, 100, 110, 120,
  ];
  const candidatePixels = [
    201, 202, 203, 204,
    210, 220, 230, 240,
    150, 160, 170, 180,
    190, 200, 210, 220,
  ];
  const selection = Uint8Array.from([0, 255, 128, 0]);
  const output = await preserveOutsideComposite({
    sourceBytes: await rawPng(2, 2, sourcePixels),
    candidateBytes: await rawPng(2, 2, candidatePixels),
    selectionMaskBytes: encodeCanonicalMaskPng({ width: 2, height: 2, pixels: selection }),
    width: 2,
    height: 2,
  });
  const decoded = await decodeRgbaForTest(output);
  assert.deepEqual([...decoded.data.subarray(0, 4)], sourcePixels.slice(0, 4));
  assert.deepEqual([...decoded.data.subarray(4, 8)], candidatePixels.slice(4, 8));
  assert.deepEqual([...decoded.data.subarray(12, 16)], sourcePixels.slice(12, 16));
  assert.deepEqual([...decoded.data.subarray(8, 12)], [100, 110, 120, 130]);
});

test("Given a confirmed selection When an object is extracted Then RGB is source-derived and alpha follows the mask", async () => {
  const sourcePixels = [
    20, 30, 40, 255,
    50, 60, 70, 200,
    80, 90, 100, 128,
  ];
  const selection = Uint8Array.from([0, 255, 128]);
  const full = await extractMaskedObject({
    sourceBytes: await rawPng(3, 1, sourcePixels),
    selectionMaskBytes: encodeCanonicalMaskPng({ width: 3, height: 1, pixels: selection }),
    width: 3,
    height: 1,
    crop: false,
  });
  const decodedFull = await decodeRgbaForTest(full.buffer);
  assert.deepEqual([...decodedFull.data], [
    20, 30, 40, 0,
    50, 60, 70, 200,
    80, 90, 100, 64,
  ]);

  const cropped = await extractMaskedObject({
    sourceBytes: await rawPng(3, 1, sourcePixels),
    selectionMaskBytes: encodeCanonicalMaskPng({ width: 3, height: 1, pixels: selection }),
    width: 3,
    height: 1,
    bbox: { x: 1, y: 0, w: 2, h: 1 },
  });
  const decodedCrop = await decodeRgbaForTest(cropped.buffer);
  assert.deepEqual({ width: decodedCrop.info.width, height: decodedCrop.info.height }, { width: 2, height: 1 });
  assert.deepEqual([...decodedCrop.data], [50, 60, 70, 200, 80, 90, 100, 64]);
});
