# Cowart Phase 5 设计方案 — 更好地发挥 tldraw × 图像模型

> 视角：Codex 产品负责人。日期：2026-06-22。状态：方案（未开发）。
> 主题：把 tldraw 的能力（绑定/自定义形状/几何/导出）与图像模型能力
> （蒙版编辑/图生图/多图参考/对话式迭代）叠加，闭合「人 × agent 共享画布」。

四个方向已选定。下面每个给出：目标 / 数据模型与 API / 改动面 / 验证 / 风险。
最后是**构建顺序**（按风险递增、后者复用前者）。

---

## 5a. 流程图箭头绑定（arrow bindings）— 先做，无头可验证

**目标**：agent 画的箭头能绑定到节点，移动节点箭头自动跟随 → 活的流程图/关系图。

**数据模型（已对真实 schema 校验）**：一条绑定 = 一个 `binding` 记录：
```
{ id:"binding:..", typeName:"binding", type:"arrow",
  fromId:<arrowId>, toId:<targetShapeId>,
  props:{ terminal:"start"|"end", normalizedAnchor:{x,y}, isExact:false, isPrecise:false, snap:"none" }, meta:{} }
```
tldraw 已支持（`arrowBindingProps`），Cowart 持久化已保留 `binding` 记录
（[vite.config.js](../../vite.config.js) `isBindingForShapes`）——只是 agent 从没造过。

**API 改动（`mcp/server.mjs`）**：扩展 `add_cowart_shapes` 的 arrow spec，新增
`fromId` / `toId`。给出时：创建 arrow 记录 + 两条 binding 记录（start→fromId、
end→toId，`normalizedAnchor` 默认 {0.5,0.5}、`snap:"edge"`）。或单独工具
`connect_cowart_shapes({ fromId, toId, text? })`。经合并端点写入。

**验证**：无头 —— 用 `schema.types.binding.validator` 校验每条 binding；集成：
建两个 geo 节点 + 连接箭头，GET 断言 binding 记录 from/to 正确。浏览器（可选）：
移动节点确认箭头跟随。

**风险**：低。一次性确认 `createBindingId` 形式与 `snap` 默认值即可。

---

## 5b. 草图 → 图（sketch → image）— 复用最多，低风险

**目标**：用户用 draw/几何画草图 → agent 用其作为结构参考生成精修图。

**复用**：`export_cowart_view`（Phase 2，mode `shapes`/`selection` → PNG）已能把草图区
导出；`insert_cowart_image` 已能把结果放旁边。**几乎不需要新底层代码**。

**改动**：新增 skill `cowart-sketch-to-image`（或扩 image-gen）编排：
1. 用户选中草图 → `export_cowart_view` 导出该区域 PNG。
2. 调用图像模型，把草图作为 **structure/img2img 参考** + 文本 prompt。
3. 可选：`get_cowart_canvas` 取草图里的文本标签并入 prompt。
4. `insert_cowart_image` 把结果放在草图旁（或 `fillAnchor` 填 holder）。

**验证**：export/insert 已测；模型调用为委派。主要验证 skill 流程与「选区导出
含 draw 形状」（tldraw `toImage` 支持 draw）。

**风险**：低（组合既有工具 + skill）。

---

## 5c. 区域感知编辑（蒙版 / inpainting）— 最大产品价值，中高风险

**目标**：标注改图从「整图重生成」升级为「只改标注区域、其余像素保留」。

**复用**：`get_cowart_annotations`（Phase 1，给出箭头尖端坐标 + 目标 shape）、
`export_cowart_view`（Phase 2 浏览器渲染通道）、`replace_cowart_image`（Phase 1 回填）。

**关键：坐标空间映射（最易错处）**。标注在**页面坐标**；目标 image shape 有页面
bounds；asset 有**自然像素尺寸**。蒙版必须在**图片像素空间**：
`region_page → 相对 image shape bounds → 按 (naturalW/shapeW, naturalH/shapeH) 缩放`。

**蒙版生成**：在**浏览器**用 canvas 2D 画（黑底 + 白色编辑区）经导出指令通道回传
PNG（复用 Phase 2 的 SSE 通道，新增一个 `mask-requested` 指令；浏览器 canvas 2D
画矩形/区域极简）。避免在 Node 里手写 PNG 编码器。

**区域来源**（两档）：
- (a) 无需 UI：从 `get_annotations` 的目标 bbox 或箭头尖端推一个矩形蒙版。先做这档。
- (b) 增强：扩 批注 工具支持画「区域」（新 StateNode，产出带 `meta.cowartAnnotationRegion`
  的矩形）→ 精确蒙版。

**流程（skill `cowart-image-edit` 升级）**：识别目标图 + 区域 → 生成蒙版 →
调**支持蒙版的图像编辑模型**（原图 + 蒙版 + prompt）→ `replace_cowart_image` 回填。

**验证**：区域→蒙版的坐标数学（无头单测）；蒙版浏览器渲染（模拟浏览器测通道）；
replace 已测。模型蒙版输出为委派；端到端需浏览器 + 真实模型。

**风险**：中高——依赖模型支持蒙版；坐标空间对齐必须精确。建议先 (a) 档跑通闭环。

---

## 5d. 活的 holder + 迭代血缘（custom ShapeUtil）— 最高价值密度，最高风险，最后做

**目标**：holder 从「带 meta 的 frame」升级为**自定义形状**，显示
空/生成中/已填 状态、prompt 标签、重生成入口；图片版本形成可追溯血缘。

**数据模型**：自定义 `ShapeUtil` `cowart-ai-image`，props
`{ w, h, prompt, status:"empty"|"generating"|"filled", assetId|null }`，在
`<Tldraw shapeUtils={[CowartAiImageShapeUtil]}>` 注册。

**血缘**：每次修订 = 新图放旁边 + **绑定箭头**（复用 5a）prev→new + 版本标签 +
`meta.cowartLineage = { parentShapeId, prompt, version, createdAt }`。

**重生成入口**：自定义 shape 上的按钮 → 写入意图（选中 + meta 标志，或一个请求
文件）→ agent 读取后重生成（agent-native：UI 动作 = agent 可读的状态）。

**一次性门 / 迁移（最大风险）**：引入新 shape 类型后，**所有客户端必须注册该
ShapeUtil** 才能加载含该记录的画布。需：
- 兼容存量 frame-holder（继续识别 legacy），新建用自定义形状；
- `create_cowart_image_holder` / `get_canvas` / selection 检测同时认两者；
- 自定义形状的 props 需要自定义 schema 迁移（不在 `@tldraw/tlschema` 内，
  无头校验受限 → 验证更依赖浏览器）。

**验证**：渲染/状态/按钮需真实浏览器（Claude Preview 截图 + DOM 断言）；
持久化往返需在注册了 util 的浏览器里验证。

**风险**：高。建议拆成 5d-1（自定义形状 + 状态渲染 + 兼容 legacy）与
5d-2（血缘连接 + 重生成入口）。

---

## 构建顺序与复用关系

1. **5a 箭头绑定**（无头、低险、是 5d 血缘连接的基础）
2. **5b 草图→图**（复用 export+insert，最少新代码）
3. **5c 区域蒙版编辑**（最大价值；复用 annotations+export 通道+replace）
4. **5d 活的 holder + 血缘**（最高风险；复用 5a 绑定；拆两步）

横切原则不变：加法不破坏、写操作走合并端点、镜像 UI 记录、能无头就无头验证、
必须浏览器的（5c 蒙版渲染、5d 自定义形状）用 Claude Preview 截图 + DOM 断言验证、
代码逻辑变更同步 skill/README/产品文档。
