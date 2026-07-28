import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const DOCS = [
  "README.md",
  "README.en.md",
  "docs/product/cowart-improvement-plan.md",
  "docs/product/object-aware-editing-plan.md",
  "skills/cowart-image-edit/SKILL.md",
];

const TOOL_NAMES = [
  "get_cowart_selection",
  "insert_cowart_image",
  "get_cowart_canvas",
  "get_cowart_annotations",
  "create_cowart_image_holder",
  "replace_cowart_image",
  "export_cowart_view",
  "add_cowart_shapes",
  "make_cowart_mask",
  "update_cowart_holder",
  "get_cowart_references",
  "get_cowart_requests",
  "segment_cowart_image",
  "refine_cowart_segment",
  "extract_cowart_object",
  "create_cowart_variant_grid",
  "select_cowart_variant",
];

const REQUIRED_README_PHRASES = [
  "MCP server version: `0.6.0`; current public tool count: `17`.",
  "@mediapipe/tasks-vision@0.10.35",
  "cdn.jsdelivr.net",
  "cdn.tldraw.com",
  "storage.googleapis.com",
  "source image is fetched only from localhost",
  "Segment Store",
  "mask remains guidance",
  "browser-local",
];

async function read(path) {
  return readFile(path, "utf8");
}

test("Given release metadata When Cowart version is read Then package plugin server and docs stay aligned", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const pluginJson = JSON.parse(await read(".codex-plugin/plugin.json"));
  const constants = await read("mcp/constants.mjs");
  const readme = await read("README.en.md");

  assert.equal(packageJson.version, "0.6.0");
  assert.equal(pluginJson.version, packageJson.version);
  assert.equal(packageJson.engines?.node, ">=20.19.0");
  assert.match(constants, /SERVER_VERSION = "0\.6\.0"/);
  assert.ok(readme.includes(`MCP server version: \`${packageJson.version}\``));
});

test("Given public docs When object-aware editing is documented Then README parity names the current version, tools, privacy, and limitations", async () => {
  const chinese = await read("README.md");
  const english = await read("README.en.md");

  assert.match(chinese, /MCP server 版本：`0\.6\.0`；当前公开工具数：`17`。/);
  for (const phrase of REQUIRED_README_PHRASES) assert.ok(english.includes(phrase), phrase);
  for (const toolName of TOOL_NAMES) {
    assert.ok(chinese.includes(toolName), `README.md missing ${toolName}`);
    assert.ok(english.includes(toolName), `README.en.md missing ${toolName}`);
  }

  const pairedConcepts = [
    ["对象选择", "Object Selection"],
    ["浏览器本机处理", "browser-local processing"],
    ["清除模型缓存", "Clear model cache"],
    ["源图不会被 Cowart 上传", "source image is never uploaded by Cowart"],
  ];
  for (const [zh, en] of pairedConcepts) {
    assert.ok(chinese.includes(zh), `README.md missing ${zh}`);
    assert.ok(english.includes(en), `README.en.md missing ${en}`);
  }
});

test("Given product docs When Phase 8 status is described Then object actions are delivered and sidecar work remains explicit", async () => {
  const improvement = await read("docs/product/cowart-improvement-plan.md");
  const plan = await read("docs/product/object-aware-editing-plan.md");

  assert.match(improvement, /Phase 8\.1-8\.2 已落地/);
  assert.match(plan, /状态：Phase 8\.1 core 与 Phase 8\.2 对象动作已落地/);
  for (const delivered of [
    "MediaPipe Interactive Segmenter",
    "Segment Store",
    "make_cowart_mask({ segmentId })",
    "extract_cowart_object",
    "create_cowart_variant_grid",
    "preserveOutside",
    "sharp@0.35.0",
  ]) {
    assert.ok(plan.includes(delivered), delivered);
  }
  for (const deferred of ["GPU sidecar", "text segmentation", "automatic agent segmentation", "full layer recovery", "C2PA", "video"]) {
    assert.match(plan, new RegExp(`${deferred}[^\\n]*(deferred|暂缓|后续)`, "i"), deferred);
  }
  assert.doesNotMatch(plan, /mock provider|mock-provider|模拟 provider/i);
  assert.doesNotMatch(plan, /benchmark.*(?:passed|通过|完成)/i);
});

test("Given repository docs When stale claims are searched Then old counts, latest URLs, fake success, TODOs, and strict-pixel promises are absent", async () => {
  const docs = Object.fromEntries(await Promise.all(DOCS.map(async (path) => [path, await read(path)])));
  const joined = Object.values(docs).join("\n");

  assert.doesNotMatch(joined, /0\.4\.0|0\.3\.0|12 个|12 tools|12-tool/);
  assert.doesNotMatch(joined, /@mediapipe\/tasks-vision@latest|\/latest\/wasm/i);
  assert.doesNotMatch(joined, /fake .*segment|mock .*success|placeholder|TODO/i);
  assert.doesNotMatch(joined, /pixel-perfect|strict pixel|像素级保证|绝对只改对象/i);
});

test("Given production object-edit code When review-only hooks are searched Then localStorage cannot override model checksum or unsupported capabilities", async () => {
  const production = [
    "src/objectEditController.js",
    "src/objectEditState.js",
    "src/objectEditWorkerRuntime.js",
    "src/objectEditWorker.js",
  ];
  const joined = (await Promise.all(production.map(read))).join("\n");

  assert.doesNotMatch(joined, /cowart-object-edit-model-sha256/);
  assert.doesNotMatch(joined, /cowart-object-edit-force-unsupported/);
  assert.doesNotMatch(joined, /expectedModelSha256/);
});
