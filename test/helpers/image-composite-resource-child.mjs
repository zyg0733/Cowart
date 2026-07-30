import sharp from "sharp";

import { preserveOutsideComposite } from "../../mcp/image-composite.mjs";
import { encodeCanonicalMaskPng } from "../../shared/cowart-segment-mask.mjs";

const width = 3840;
const height = 2160;
const sourceBytes = await sharp({
  create: { width, height, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
}).png().toBuffer();
const candidateBytes = await sharp({
  create: { width: 1920, height: 1080, channels: 4, background: { r: 220, g: 180, b: 40, alpha: 1 } },
}).png().toBuffer();
let maskPixels = new Uint8Array(width * height);
for (let y = 540; y < 1620; y += 1) {
  maskPixels.fill(255, y * width + 960, y * width + 2880);
}
const selectionMaskBytes = encodeCanonicalMaskPng({ width, height, pixels: maskPixels });
maskPixels = null;
global.gc?.();

let peakRss = process.memoryUsage().rss;
const sample = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 5);
const output = await preserveOutsideComposite({
  sourceBytes,
  candidateBytes,
  selectionMaskBytes,
  width,
  height,
});
peakRss = Math.max(peakRss, process.memoryUsage().rss);
clearInterval(sample);
const metadata = await sharp(output).metadata();
process.stdout.write(JSON.stringify({ peakRss, outputBytes: output.length, width: metadata.width, height: metadata.height }));
