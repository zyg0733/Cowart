# Cowart Phase 8：对象感知编辑、对象动作与自动分割方案

> 日期：2026-07-27。状态：Phase 8.1 core 与 Phase 8.2 对象动作已落地；Sidecar 和 AI 场景分解仍按阶段推进。

## 1. 当前交付边界

Phase 8.1-8.2 已交付“人在回路”的对象选择、校正、动作和 agent 消费流程：

1. 用户在画布中选择一张页面本地图片或 filled `cowart-ai-image` holder。
2. 用户打开“对象”工具，用点击或粗略 scribble 指向目标对象。
3. 浏览器本机 Worker 加载 `MediaPipe Interactive Segmenter`，生成候选蒙版。
4. 用户可切换候选，用添加/移除笔刷、画笔大小、撤销、重做和重置校正候选；这些操作只修改候选蒙版，不冒充模型重新推理。
5. 用户预览、取消或确认。只有确认后的记录写入 Segment Store；已确认对象可继续发布不可变 child segment。
6. Agent 通过 `get_cowart_selection` 或 `get_cowart_canvas` 发现 `confirmedSegments`。
7. `extract_cowart_object` 用 `sharp` 从源图提取真实透明 PNG；修改、替换、移除创建 AI holder 请求。
8. Variant Grid 默认四个、最多六个 holder，继续使用 FIFO 队列，winner 写入共享 metadata，非 winner 保留。
9. Agent 生成修订图，并用 `preserveOutside` 在本地保护性合成，写入 `meta.cowartObjectEdit` provenance。

当前版本不交付 GPU sidecar、text segmentation、automatic agent segmentation、AI scene decomposition、full layer recovery、生产级 C2PA 或 video。它们是 deferred work。

## 2. 实现事实

- MCP server：`0.6.0`。
- 公开 MCP 工具数：`17`。
- 对象相关工具：`segment_cowart_image`、`refine_cowart_segment`、`make_cowart_mask({ segmentId })`、`extract_cowart_object`、`create_cowart_variant_grid`、`select_cowart_variant`。
- 确定性图像处理：`sharp@0.35.0`。
- 浏览器模型：`MediaPipe Interactive Segmenter`，`@mediapipe/tasks-vision@0.10.35`。
- WASM URL：`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm`。
- 模型 URL：`https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite`。
- 模型 SHA-256：`e24338a717c1b7ad8d159666677ef400babb7f33b8ad60c4d96db4ecf694cd25`。
- MediaPipe 固定外部主机：`cdn.jsdelivr.net` 和 `storage.googleapis.com`；已观测的 tldraw 前端资源主机：`cdn.tldraw.com`。
- 测试 fixture：`test/fixtures/object-editing/primary-object.png`，CC0/project-generated，SHA-256 记录在 `test/fixtures/object-editing/SOURCE.json`。

## 3. Segment Store

Segment Store 是已确认对象蒙版的唯一真源。候选只在浏览器内存中存在，不写入 tldraw shape meta。

```text
canvas/pages/<page-id>/segments/<segment-id>/
  mask.png
  preview.png
  manifest.json
```

`manifest.json` 记录：

- source：page id、shape id、asset id、asset SHA-256、自然尺寸；
- mask：文件名、SHA-256、bbox、area；
- selection：point 或 scribble；
- provider：id、runtime、processing、model、version；
- `parentSegmentId`：校正产生子 segment 时指向父记录。

写入时先在临时目录解码和校验 mask，再在画布写锁内重读当前 source asset bytes。source hash、asset id 或尺寸不匹配时返回 stale/source error，不发布半成品。

## 4. MCP 工作流

### `segment_cowart_image`

当前没有配置真实服务端 provider 时返回 `browser_interaction_required`。它不会返回假的候选 id、假的 mask 或假的成功结果。Agent 应要求用户在浏览器画布中确认对象。

### `refine_cowart_segment`

对已确认 segment 执行本地 mask 形态学操作，支持 expand、contract、feather，并创建不可变子 segment。它重新校验 source hash，并保留 `parentSegmentId`。

### `make_cowart_mask`

接受且只接受 `region`、`regionShapeId`、`segmentId` 三者之一。`segmentId` 路径会读取 Segment Store，验证 source identity，把选择权重转换为图像编辑 alpha：`editAlpha = 255 - selectionWeight`。返回 source image、mask file、mask hash、source hash 和 segment id。

### 透明提取、保护性写回与 provenance

`extract_cowart_object` 只使用 Segment Store 权威蒙版和源图像素，输出标记为 `synthetic: false`。生成式对象动作标记为 synthetic；caller 只传安全字段。`preserveOutside` 从已验证 segment 推导 source identity，并保证 mask 值为 0 的解码 RGBA 字节与源图一致，不允许 caller 覆盖 source shape、asset、hash 或 mask hash。

## 5. 隐私、安全和限制

- 源图只从 Cowart localhost 页面资源读取。Cowart 不上传源图，也不会向外部主机发起源图 mutation。
- 首次分割需要下载固定 WASM 和模型；tldraw 运行时也可能从 `cdn.tldraw.com` 读取前端资源。离线时真实对象选择会失败；离线错误场景应显式测试。
- 浏览器必须支持 module Worker、OffscreenCanvas、WebGL2 和 Web Crypto；缺失时显示 unsupported。
- Segment Store 路径限制在页面目录内，并执行 child-path 检查。
- 模型和图像编辑 mask 是 guidance。只有后处理执行 `preserveOutside` 的结果才承诺蒙版外解码 RGBA 字节不变。
- 日志和 provenance 不保存源图字节、密钥或完整远端响应。

## 6. 真实证据和未跑事项

已记录证据覆盖固定 fixture 的真实浏览器点选、scribble、确认、reload rehydrate、keyboard accept/cancel、unsupported、checksum error、stale source，以及 crop/flip alignment。真实 model metrics 来自固定 CC0 fixture，不能外推为通用 benchmark。

没有声明完成的事项：

- GPU sidecar is deferred。
- text segmentation is deferred。
- automatic agent segmentation is deferred。
- full layer recovery is deferred。
- C2PA production signing is deferred。
- video object tracking is deferred。
- 全量质量 benchmark 未运行。

## 7. 后续阶段

### Phase 8.2：校正和对象动作（已落地）

已落地笔刷校正、候选切换、修改/移除/替换/提取、`preserveOutside`、Variant Grid 和只读 lineage 时间线。

### Phase 8.3：本地 provider

引入本地 sidecar，支持 text segmentation 和 automatic agent segmentation。Sidecar 默认绑定 `127.0.0.1`，禁止 wildcard CORS，并使用显式 allowlist。

### Phase 8.4：对象层和可信导出

评估对象 shape、provenance JSON、C2PA 可行性。full layer recovery、可编辑文字和 video 继续 deferred。

## 8. 外部依据

- [Google MediaPipe Interactive Segmenter Web 指南](https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter/web_js)
- [MediaPipe model storage](https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite)
- [OpenAI Image Generation 指南](https://developers.openai.com/api/docs/guides/image-generation)
