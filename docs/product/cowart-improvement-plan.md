# Cowart 产品改进方案

> 视角：Codex 产品负责人。日期：2026-06-22。

## 1. 这是什么产品

Cowart 是 Codex 的**本地无限画布**：tldraw 画布 + 本地 Web 服务 + MCP 工具 + 三个 skill（开画布 / 生成图 / 标注改图）。它的独特定位不是"又一个白板"，而是 **agent 与人共享的视觉工作台**——人在画布上构思、标注，Codex 在同一块画布上生成与迭代。

## 2. 核心洞察：agent 是"半盲半残"的

Cowart 自称 agent-native，但今天的 agent 在画布上能力残缺，破坏了 **agent-native parity（人能做的，agent 也应能做）**：

| 能力 | 人（UI） | agent（MCP） | 差距 |
|------|----------|--------------|------|
| 看见画布内容 | ✅ | ❌ 只能读"选中项" | agent 无法对整块板子推理 |
| 读懂标注（批注+箭头指向） | ✅ 肉眼 | ⚠️ 只能截图让模型 OCR | 旗舰流程不可靠、费 token |
| 放入图片 | ✅ | ✅ insert | — |
| 创建 AI 图片 holder | ✅ 工具栏 | ❌ | image-gen 要手写记录 |
| 替换 holder 里的图 | ✅ | ❌ | "替换"流程只能手写快照 |
| 导出区域/页为 PNG | ✅ | ❌ | agent 无法把画布结果带回答里 |

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

### Phase 2 — 导出与回带
- `export_cowart_view`：把选区/页/单个 shape 导出为 PNG 到文件，agent 可在回答里引用或附带。

### Phase 3 — agent 作图
- `add_cowart_shapes`：让 agent 创建文本/便签/箭头/几何，输出流程图、注释、排版。

### Phase 4 — 打磨
- 空画布首启引导；bundle 代码分割（当前 1.8MB 警告）；多页导航。

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
