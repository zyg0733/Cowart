# Cowart 产品改进方案

> 视角：Codex 产品负责人。日期：2026-06-22。

## 1. 这是什么产品

Cowart 是 Codex 的**本地无限画布**：tldraw 画布 + 本地 Web 服务 + MCP 工具 + 三个 skill（开画布 / 生成图 / 标注改图）。它的独特定位不是"又一个白板"，而是 **agent 与人共享的视觉工作台**——人在画布上构思、标注，Codex 在同一块画布上生成与迭代。

## 2. 核心洞察：agent 是"半盲半残"的

Cowart 自称 agent-native，但今天的 agent 在画布上能力残缺，破坏了 **agent-native parity（人能做的，agent 也应能做）**：

| 能力 | 人（UI） | agent（MCP） | 差距 |
|------|----------|--------------|------|
| 看见画布内容 | ✅ | ✅ get_canvas（Phase 1） | — |
| 读懂标注（批注+箭头指向） | ✅ 肉眼 | ✅ get_annotations（Phase 1） | — |
| 放入图片 | ✅ | ✅ insert | — |
| 创建 AI 图片 holder | ✅ 工具栏 | ✅ create_holder（Phase 1） | — |
| 替换 holder 里的图 | ✅ | ✅ replace_image（Phase 1） | — |
| 导出区域/页为 PNG | ✅ | ✅ export_view（Phase 2） | — |

**结论**：最高杠杆的改进不是加画布功能，而是**补齐 agent 的感知与动作**，让旗舰"标注→改图"闭环从"截图猜意图"升级为"读结构化数据"。

## 3. 愿景与北极星

- **愿景**：Cowart 是一块 agent 作为一等公民的视觉工作台——它能**感知**（读板子、读标注）、**行动**（建/换/排）、**反馈**（导出），与人等价。
- **北极星指标**：每个任务中 agent 成功完成的画布操作数；标注改图闭环"无需截图"的成功率。

## 4. 路线图（分阶段、可独立交付）

### Phase 1 — agent 感知与核心动作（本次落地）
新增 MCP 工具，全部**加法式、向后兼容**，复用已有的合并端点/写锁（并发安全）：
- `get_cowart_canvas`：返回当前页（或指定/全部页）的结构化内容——每个 shape 的 id/类型/页面坐标/文本/资产/是否 holder/是否标注。让 agent 第一次"看见"板子。
- `get_cowart_annotations`：把批注箭头解析为 `{文本, 指向的目标 shape, 起止点}`。把旗舰流程从"截图"升级为"读数据"。
- `create_cowart_image_holder`：程序化创建 AI 图片 holder（与 UI 工具完全一致的 frame 记录）。
- `replace_cowart_image`：替换某图片 shape / holder 内图片的资产（"替换"流程），保留位置尺寸。

配套：升级 `cowart-image-gen` / `cowart-image-edit` skill，优先用上述工具而非手写记录/纯截图。

### Phase 2 — 导出与回带（已落地）
- `export_cowart_view`：把选区/页/单个 shape 导出为图片文件，agent 可在回答里引用或附带。两种策略：
  - **资产快路径**（无需浏览器）：单张图片（或 frame holder 内的图）直接从页面资产无损复制，覆盖"把生成图给我一个文件"的主场景。
  - **浏览器渲染**（页/选区/多 shape 含几何文本箭头）：MCP→服务端长轮询→SSE 指令→浏览器 `editor.toImage` 渲染→base64 回传→MCP 写文件；需画布在浏览器中打开。
- 验证边界：渲染通道的全链路（含模拟浏览器）已测；tldraw 自身的 `toImage` 栅格化为上游 API，未在无头环境复验。

### Phase 3 — agent 作图（已落地）
- `add_cowart_shapes`：让 agent 创建 text / geo（矩形/椭圆/菱形…）/ note（便签）/ line / arrow，输出流程图、注释、排版。
- 完全无头、无需浏览器：记录由服务端按 tldraw 5 prop 规格构建，对 agent 传入的样式枚举做白名单兜底；批量、`dryRun` 可预览。
- 验证：每条生成记录都用**真实 tldraw schema 校验**（`schema.types.shape.validator`），无委派边界。

### Phase 4 — 打磨（已落地，含重新定范围）
原计划三项，落地前用证据复核后重排：
- ✅ **空画布首启引导**：空画布时显示可关闭的引导卡（按 A 建 AI 图片框 / 按 C 批注 / 让 Codex 作图·导出），本地化 + localStorage 记忆关闭。
- ✅ **Agent 活动提示**：MCP 写入落地经实时刷新后，底部弹出「Codex 更新了画布 · N 个新图形」轻提示，带「查看」可选中并缩放到新图形，强化人机协作主循环。
- ❌ **bundle 代码分割（砍）**：经核实运行时始终走 vite dev（`start-canvas.sh` exec `npm run dev`），`dist/` 不在热路径，拆包属伪优化；如需仅消除构建告警可后续按需做。
- ❌ **多页导航（砍）**：tldraw 默认 PageMenu 已提供人类多页导航，叠加 per-page 持久化 + 删除同步即满足；剩余「agent 建/选页」属作图扩展，按需再做。
- 验证：前端项用真实浏览器（Claude Preview）截图与 DOM 断言验证——空态卡渲染/隐藏、toast 文案与「查看」缩放、无 console 报错。

### Phase 5 — tldraw × 图像模型深度结合（已落地）
详见 [phase5-plan.md](phase5-plan.md)：5.0 base64 直收 / 5a 箭头绑定 / 5b 草图→图 /
5c 区域蒙版编辑 / 5d 迭代血缘 + 活的 AI 图片 holder（自定义 ShapeUtil，含可编辑 prompt、
生成中态）。

### Phase 6 — 让 Codex image gen 紧密结合（已落地）
主题：**image_gen 的每个输入都变成一个画布手势**（"摆出来，别只描述"）。
- ✅ **参考板 / 多图合成（input_image）**：holder 的 `meta.cowartReferences` 记录参考图；
  `get_cowart_references` 把它们（含 base64）解析出来喂给 `input_image`。
- ✅ **风格锚点（style_match）**：`meta.cowartStyleRef` 标记风格参考图，`get_cowart_references`
  以 `role:"style"` 区分 → 成套产出风格一致。
- ✅ **画尺寸即定尺寸**：`get_cowart_canvas` 为每个 shape 返回 `suggestedGenSize`（÷16、
  1:3–3:1、≤3840 的最近合法 gpt-image 尺寸）——画多大生成多大。
- ✅ **调用可复现**：`replace_cowart_image` / `update_cowart_holder` 接受 `genParams`，
  存入 `meta.cowartGen`（prompt+参考+尺寸+model+seed）→ 可按原设置重生成/分叉。
- 验证：无头 13 项（含 `nearestGenSize` 极值裁剪、引用解析角色/base64、provenance 持久化）。

## 5. 稳定落地原则

1. **加法不破坏**：只新增 MCP 工具，不改既有契约；旧 skill/curl 兜底仍可用。
2. **复用已固化的并发模型**：所有写操作走 `/api/canvas/records` 合并端点 + 写锁 + revision（见 canvas 并发契约），插入旧服务端回退全量 PUT。
3. **镜像 UI 记录**：MCP 创建的 holder/图片记录与 UI 完全一致，浏览器实时刷新即同步，**零 UI 偏差**。
4. **可测**：每个工具配集成测试（变更类支持 `dryRun`）。
5. **与 UI/skill 文档同步**：代码逻辑变更，对应 skill 文档同步更新。

## 6. 验收（Phase 1）

- 四个工具的 `tools/list` 暴露正确、`dryRun` 可计算不落盘。
- `get_cowart_annotations` 能正确把箭头文本与目标 shape 对应。
- `create_holder` / `replace_image` 写入与 UI 一致、并发安全、浏览器实时可见。
- 全部经集成测试通过；`npm run build` 通过；skill 文档同步。
