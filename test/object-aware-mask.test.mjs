import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import zlib from "node:zlib";

import {
  CowartSegmentMaskError,
  SEGMENT_MASK_LIMITS,
  decodeCanonicalMaskPng,
  encodeCanonicalMaskPng,
  refineSelectionMask,
  selectionToEditAlpha,
  summarizeSelectionMask,
} from "../shared/cowart-segment-mask.mjs";

const execFileAsync = promisify(execFile);

const pngChunk = (type, data) => {
  const typeBuffer = Buffer.from(type, "ascii");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  typeBuffer.copy(header, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuffer, data])) >>> 0, 0);
  return Buffer.concat([header, data, crc]);
};

const pngWithIhdrByte = (png, ihdrOffset, value) => {
  const mutated = Buffer.from(png);
  mutated[16 + ihdrOffset] = value;
  mutated.writeUInt32BE(zlib.crc32(Buffer.concat([mutated.subarray(12, 16), mutated.subarray(16, 29)])) >>> 0, 29);
  return mutated;
};

const oneByteIhdrPng = () => Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk("IHDR", Buffer.from([0])),
  pngChunk("IEND", Buffer.alloc(0)),
]);

test("Given canonical mask bytes When encoded and decoded Then bytes, bbox, area, and hash are deterministic", () => {
  const pixels = Uint8Array.from([0, 255, 0, 0, 255, 255, 0, 0, 0]);
  const png = encodeCanonicalMaskPng({ width: 3, height: 3, pixels });
  const decoded = decodeCanonicalMaskPng(png, { maxPixels: 64, maxBytes: 2048 });
  const summary = summarizeSelectionMask(decoded);

  assert.deepEqual(decoded, { width: 3, height: 3, pixels });
  assert.deepEqual(summary.bbox, { x: 1, y: 0, w: 2, h: 2 });
  assert.equal(summary.area, 3);
  assert.equal(summary.sha256, createHash("sha256").update(png).digest("hex"));
  assert.deepEqual(encodeCanonicalMaskPng(decoded), png);
});

test("Given unsupported or unsafe PNG inputs When decoded Then structured errors are returned before unsafe allocation", () => {
  assert.throws(() => decodeCanonicalMaskPng(Buffer.from("not a png")), (error) => {
    assert.ok(error instanceof CowartSegmentMaskError);
    assert.equal(error.code, "png_malformed");
    return true;
  });
  assert.throws(() => decodeCanonicalMaskPng(encodeCanonicalMaskPng({ width: 2, height: 2, pixels: new Uint8Array(4) }), { maxPixels: 3 }), (error) => {
    assert.equal(error.code, "png_too_large");
    return true;
  });
  const grayscale = encodeCanonicalMaskPng({ width: 1, height: 1, pixels: Uint8Array.from([255]) });
  assert.throws(() => decodeCanonicalMaskPng(pngWithIhdrByte(grayscale, 9, 3)), (error) => {
    assert.equal(error.code, "png_unsupported_color_type");
    return true;
  });
  assert.throws(() => decodeCanonicalMaskPng(pngWithIhdrByte(grayscale, 12, 1)), (error) => {
    assert.equal(error.code, "png_interlaced");
    return true;
  });
});

test("Given a malformed short IHDR chunk When decoded Then a structured PNG error is returned", () => {
  assert.throws(() => decodeCanonicalMaskPng(oneByteIhdrPng()), (error) => {
    assert.ok(error instanceof CowartSegmentMaskError);
    assert.equal(error.name, "CowartSegmentMaskError");
    assert.equal(error.code, "png_malformed");
    return true;
  });
});

test("Given an oversized typed-array view When decoded Then maxBytes is enforced on byteLength before copying", () => {
  const storage = new ArrayBuffer(4096);
  const view = new Uint8Array(storage, 1024, 128);

  assert.throws(() => decodeCanonicalMaskPng(view, { maxBytes: 64 }), (error) => {
    assert.ok(error instanceof CowartSegmentMaskError);
    assert.equal(error.code, "png_too_large");
    assert.deepEqual(error.details, { bytes: 128, maxBytes: 64 });
    return true;
  });
});

test("Given selection weights When converted to edit alpha Then alpha is explicitly inverted", () => {
  assert.deepEqual(selectionToEditAlpha(Uint8Array.from([0, 64, 255])), Uint8Array.from([255, 191, 0]));
});

test("Given a binary mask When expand contract and feather are applied Then refinement is deterministic", () => {
  const pixels = Uint8Array.from([
    0, 0, 0, 0, 0,
    0, 0, 255, 0, 0,
    0, 255, 255, 255, 0,
    0, 0, 255, 0, 0,
    0, 0, 0, 0, 0,
  ]);

  assert.deepEqual(refineSelectionMask({ width: 5, height: 5, pixels }, { expandPixels: 1, contractPixels: 1, featherPixels: 1 }).pixels, Uint8Array.from([
    0, 85, 85, 85, 0,
    85, 85, 170, 85, 85,
    85, 170, 170, 170, 85,
    85, 85, 170, 85, 85,
    0, 85, 85, 85, 0,
  ]));
});

test("Given malformed morphology values When refining Then structured errors are returned without hanging", async () => {
  const mask = { width: 3, height: 3, pixels: Uint8Array.from([0, 0, 0, 0, 255, 0, 0, 0, 0]) };
  const cases = [
    ["expandPixels", -1], ["expandPixels", 1.5], ["expandPixels", Number.NaN], ["expandPixels", Infinity], ["expandPixels", 65],
    ["contractPixels", -1], ["contractPixels", 1.5], ["contractPixels", Number.NaN], ["contractPixels", Infinity], ["contractPixels", 65],
    ["featherPixels", -1], ["featherPixels", 1.5], ["featherPixels", Number.NaN], ["featherPixels", Infinity], ["featherPixels", 33],
  ];
  const rejections = [];
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("refineSelectionMask hung on malformed morphology input")), 100);
  });

  await Promise.race([
    Promise.resolve().then(() => {
      for (const [field, value] of cases) {
        assert.throws(() => refineSelectionMask(mask, { [field]: value }), (error) => {
          assert.ok(error instanceof CowartSegmentMaskError);
          assert.equal(error.code, "invalid_morphology_parameter");
          assert.equal(error.details.field, field);
          rejections.push({ field, value: String(value), code: error.code });
          return true;
        });
      }
    }),
    timeout,
  ]);

  assert.equal(rejections.length, cases.length);
});

test("Given a valid IDAT chunk after PNG IEND When decoded Then a structured PNG error is returned", () => {
  const png = encodeCanonicalMaskPng({ width: 1, height: 1, pixels: Uint8Array.from([255]) });
  const appendedIdat = Buffer.concat([png, pngChunk("IDAT", zlib.deflateSync(Buffer.from([0, 255])))]);

  assert.throws(() => decodeCanonicalMaskPng(appendedIdat), (error) => {
    assert.ok(error instanceof CowartSegmentMaskError);
    assert.equal(error.name, "CowartSegmentMaskError");
    assert.equal(error.code, "png_malformed");
    return true;
  });
});

test("Given arbitrary bytes after PNG IEND When decoded Then a structured PNG error is returned", () => {
  const png = encodeCanonicalMaskPng({ width: 1, height: 1, pixels: Uint8Array.from([255]) });
  const trailingBytes = Buffer.concat([png, Buffer.from([1, 2, 3])]);

  assert.throws(() => decodeCanonicalMaskPng(trailingBytes), (error) => {
    assert.ok(error instanceof CowartSegmentMaskError);
    assert.equal(error.name, "CowartSegmentMaskError");
    assert.equal(error.code, "png_malformed");
    return true;
  });
});

test("Given a 512x512 mask When featherPixels is one Then refinement completes within the performance budget", async () => {
  const script = [
    "import { performance } from 'node:perf_hooks';",
    "import { refineSelectionMask } from './shared/cowart-segment-mask.mjs';",
    "const width = 512, height = 512;",
    "const pixels = new Uint8Array(width * height);",
    "for (let y = 156; y < 356; y += 1) for (let x = 156; x < 356; x += 1) pixels[y * width + x] = 255;",
    "const started = performance.now();",
    "const refined = refineSelectionMask({ width, height, pixels }, { featherPixels: 1 });",
    "const elapsedMs = performance.now() - started;",
    "console.log(JSON.stringify({ elapsedMs, length: refined.pixels.length, center: refined.pixels[256 * width + 256] }));",
  ].join(" ");
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { timeout: 2000 });
  const result = JSON.parse(stdout);

  assert.equal(result.length, 512 * 512);
  assert.equal(result.center, 255);
  assert.ok(result.elapsedMs < 1500, `feather took ${result.elapsedMs}ms`);
});

test("Given large accepted dimensions with invalid pixels When refining Then validation is structured and allocation-bounded", () => {
  const width = SEGMENT_MASK_LIMITS.maxDimension;
  const height = Math.floor(SEGMENT_MASK_LIMITS.maxPixels / width);

  assert.throws(() => refineSelectionMask({ width, height, pixels: new Uint8Array(0) }, { featherPixels: 1 }), (error) => {
    assert.ok(error instanceof CowartSegmentMaskError);
    assert.equal(error.code, "invalid_mask_pixels");
    assert.equal(error.details.expected, width * height);
    return true;
  });
});

test("Given overflow-prone mask dimensions When refining Then validation fails before allocation-heavy work", () => {
  assert.throws(() => refineSelectionMask({ width: 8193, height: 1, pixels: new Uint8Array(0) }), (error) => {
    assert.ok(error instanceof CowartSegmentMaskError);
    assert.equal(error.code, "png_too_large");
    return true;
  });
  assert.throws(() => refineSelectionMask({ width: 8192, height: 8192, pixels: new Uint8Array(0) }), (error) => {
    assert.ok(error instanceof CowartSegmentMaskError);
    assert.equal(error.code, "png_too_large");
    return true;
  });
});
