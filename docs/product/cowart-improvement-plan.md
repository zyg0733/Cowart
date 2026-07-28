# Cowart 产品改进方案

> 视角：Codex 产品负责人。更新：2026-07-19。

## 1. 产品定位

Cowart 是 Codex 的本地无限画布：tldraw 画布、本地 Web 服务、MCP 工具和 skills 组成一块人和 agent 共享的视觉工作台。人可以在画布上构思、标注、选择对象；Codex 可以读取同一块画布，生成、修订、导出并留下来源记录。

## 2. 已落地能力

| 能力 | UI | MCP / agent |
| --- | --- | --- |
| 看见画布内容 | tldraw 画布 | `get_cowart_canvas` |
| 读取当前选择 | 选择图片、批注、holder | `get_cowart_selection` |
| 读懂批注 | 批注箭头与文本 | `get_cowart_annotations` |
| 创建和填充 holder | `cowart-ai-image` 自定义形状 | `create_cowart_image_holder`、`update_cowart_holder`、`replace_cowart_image` |
| 处理生成队列 | 点击生成 | `get_cowart_requests` |
| 插入和替换图片 | 页面本地资产 | `insert_cowart_image`、`replace_cowart_image` |
| 导出视图 | 浏览器渲染或资产快路径 | `export_cowart_view` |
| 创建图形 | 文本、便签、箭头、几何 | `add_cowart_shapes` |
| 参考图和风格锚点 | holder 引用 | `get_cowart_references` |
| 区域和对象蒙版 | 矩形、已确认 segment | `make_cowart_mask` |
| 对象 segment 校正 | 扩张、收缩、羽化 | `refine_cowart_segment` |
| 服务端分割入口 | 明确能力状态 | `segment_cowart_image` |
| 候选蒙版校正 | 添加/移除笔刷、历史、候选切换 | 不可变 child segment |
| 透明对象提取 | 对象列表与来源时间线 | `extract_cowart_object` |
| 保护性合成 | 对象动作 holder | `insert_cowart_image.preserveOutside`、`replace_cowart_image.preserveOutside` |
| Variant Grid | 四宫格、winner、结果保留 | `create_cowart_variant_grid`、`select_cowart_variant` |

当前 MCP server 版本是 `0.6.0`，公开工具数是 `17`。

## 3. 路线图状态

### Phase 1-7：agent-native 画布基础（已落地）

Phase 1 到 Phase 7 已完成结构化画布读取、批注解析、AI holder、导出、agent 作图、多图参考、当前页生成队列、holder 生命周期、选择态批注编辑和图像修订血缘。已落地能力保持加法式兼容；旧画布中的 legacy holder 仍可被读取和填充。

### Phase 8.1-8.2 已落地：对象感知编辑与对象动作

详见 [object-aware-editing-plan.md](object-aware-editing-plan.md)。当前交付：

- 共享图片坐标和 Segment Store 契约；
- 页面本地资产 SHA-256 身份与 source precondition；
- 浏览器本机 `MediaPipe Interactive Segmenter` 点选和粗略 scribble 分割；
- 确认、取消、错误、unsupported、reload rehydrate 状态；
- 已确认 segment 摘要加入 canvas / selection 输出；
- `make_cowart_mask({ segmentId })` 生成图像编辑蒙版；
- `refine_cowart_segment` 通过本地形态学操作创建不可变子 segment；
- `insert_cowart_image` / `replace_cowart_image` 支持对象编辑来源校验和旁路修订 provenance。
- Worker 保持到确认/取消，候选最多六个；添加/移除笔刷只校正候选蒙版，不描述为模型多点推理；
- 浏览器可重载已确认对象并发布不可变 child segment；
- 固定 `sharp@0.35.0`，本地提取真实透明 PNG，并实现蒙版外 RGBA 字节不变的 `preserveOutside`；
- 修改、替换、移除创建 object-action holder 请求；
- Variant Grid 默认四个、最多六个，FIFO 处理，winner 原子写入共享 metadata，其他结果保留；
- `get_cowart_canvas.lineageTimeline` 和画布面板提供只读来源时间线。

明确未交付：GPU sidecar、text segmentation、automatic agent segmentation、AI scene decomposition、full layer recovery、生产级 C2PA、video。它们仍是后续方向，不属于当前 `0.6.0` 的承诺。

## 4. 稳定落地原则

1. 加法不破坏：新增能力不破坏既有 MCP 契约。
2. 画布是状态真源：holder 请求保存在 shape meta；confirmed segment 保存在 Segment Store。
3. 源图字节是对象蒙版真源：确认、校正、蒙版生成和写回都用 asset SHA-256 拒绝 stale 结果。
4. 候选不持久化：浏览器内存中的候选预览不是 tldraw shape，也不是 Segment Store 记录。
5. 浏览器本机优先：Phase 8 core 不上传源图。MediaPipe 模型和 WASM 从 `cdn.jsdelivr.net`、`storage.googleapis.com` 下载；tldraw 前端资源可能从 `cdn.tldraw.com` 读取。源图字节仍只来自 localhost，且没有外部 mutation。
6. 明确限制：图像模型把 mask 当作 guidance。只有执行 `preserveOutside` 的结果才承诺蒙版值为 0 的解码 RGBA 字节不变。
7. 文档和 skills 与工具面同步：版本、工具数、错误语义和隐私说明必须随代码更新。

## 5. 当前低风险项

- 首次对象选择依赖网络下载 `@mediapipe/tasks-vision@0.10.35` WASM 和 Magic Touch 模型；离线时会失败并显示错误。
- MediaPipe 点选对清晰单主体效果可用；笔刷能校正候选蒙版，但复杂边缘、透明材质和重叠对象仍需要 SAM 2 sidecar 与更多质量基准。
- 目前没有记录完整模型质量 benchmark。现有证据只覆盖固定 CC0 fixture 的真实浏览器点选和 scribble。
- Segment Store 手动删除需要谨慎。被后续修订引用的 segment 应保留。

## 6. 后续方向

1. Phase 8.3：跨平台 SAM 2 / Grounding DINO sidecar、text segmentation 和 automatic agent segmentation。
2. Phase 8.4：Codex `image_gen` 混合场景分解与 Decomposition Stack。
3. Phase 8.5：基础 provenance export、C2PA 可行性评估。
4. P2/P3：full layer recovery、可编辑文字和 video object tracking。
