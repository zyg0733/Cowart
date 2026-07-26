# Cowart

Cowart 是一个面向 Codex 的本地无限画布插件。它基于 tldraw 提供可视化画布，用于构思、标注、生成图片、对象选择和根据画布内容迭代图片。画布运行在本地网页服务中，数据默认保存到当前用户项目的 `canvas/` 目录，而不是保存到插件仓库里。

English README: [README.en.md](README.en.md)

## 功能

- 在 Codex 中打开一个本地 tldraw 无限画布。
- 在当前项目目录中持久化画布页面、图片资源和已确认的对象 segment。
- 创建 AI image holder；点击生成后形成当前页请求队列，Codex 顺序认领、生成、填回对应 holder，并显示 queued / generating / failed / filled 生命周期。
- 读取选中的批注、目标图或已确认对象 segment，让 Codex 生成干净的新图并放到原图旁边；截图只作为结构化画布不可用时的 fallback。
- 对象选择：选中一张本地图片，切到“对象”工具，点击或拖画目标对象。Cowart 在浏览器本机用 MediaPipe Interactive Segmenter 生成蒙版预览；按 Enter 接受，按 Escape 取消。确认后的 segment 会在刷新后重新加载。
- 浏览器本机处理：源图只从 `127.0.0.1` 的 Cowart 页面资源读取。源图不会被 Cowart 上传。首次对象选择需要下载固定版本的模型和 WASM；tldraw 运行时也可能从 `cdn.tldraw.com` 读取前端资源。
- 通过 Cowart MCP 工具感知与操作画布：`get_cowart_selection`、`insert_cowart_image`、`get_cowart_canvas`、`get_cowart_annotations`、`create_cowart_image_holder`、`replace_cowart_image`、`export_cowart_view`、`add_cowart_shapes`、`make_cowart_mask`、`update_cowart_holder`、`get_cowart_references`、`get_cowart_requests`、`segment_cowart_image`、`refine_cowart_segment`。
- MCP server 版本：`0.5.0`；当前公开工具数：`14`。

## 安装

### 让 Codex 自动安装

把下面这段发给 Codex：

```text
请从 https://github.com/zyg0733/Cowart.git 安装 Cowart Codex 插件。
请 clone 仓库到 ~/plugins/cowart，确认 .codex-plugin/plugin.json 存在，
把插件加入 personal marketplace，先运行 codex plugin marketplace add ~，
再运行 codex plugin add cowart@personal。
安装后请校验插件，并告诉我是否需要开启一个新对话来加载新技能和 MCP 工具。
```

### 手动安装

```bash
mkdir -p ~/plugins
git clone https://github.com/zyg0733/Cowart.git ~/plugins/cowart
cd ~/plugins/cowart
npm install
npm run build
```

然后注册并安装插件：

```bash
codex plugin marketplace add ~
codex plugin add cowart@personal
```

安装后建议开启一个新的 Codex 对话，让新的 skill 和 MCP 工具完整加载。

## 使用

### 打开画布

在 Codex 中说：

```text
Open the Cowart canvas for this project.
```

Cowart 默认启动在：

```text
http://127.0.0.1:43217/
```

画布数据保存在当前项目目录：

```text
canvas/pages/<page-id>/cowart-canvas.json
canvas/pages/<page-id>/assets/
canvas/pages/<page-id>/segments/<segment-id>/
```

### 生成新图

1. 打开 Cowart 画布。
2. 创建 AI image holder，输入 prompt，并点击生成。
3. 在 Codex 中说：

```text
Process the requested Cowart AI image holders on the current page.
```

Codex 会调用 `get_cowart_requests` 读取当前页 queued holder，按 FIFO 顺序逐个用 `expectedRequestId` 认领，再用 `replace_cowart_image` 填回同一个 holder。Cowart 不运行后台 daemon，也不会自动并行处理所有页面。

### 根据批注生成新图

1. 在 Cowart 画布中对图片做批注，并选中目标图片或相关批注箭头。
2. 使用提示：

```text
Use my selected Cowart annotations to generate a clean revised image beside the original.
```

Codex 会先读取 `get_cowart_selection`，再用 `get_cowart_annotations` 的 `targetShapeId`、`annotationIds` 或 `selectedOnly` 过滤器解析批注。原图和批注不会被删除或移动，结果会作为新图放在原图旁边并记录血缘。

### 对象选择与对象编辑

1. 选中一张普通图片或 filled `cowart-ai-image` holder。
2. 点击底部工具栏的“对象”。
3. 在对象上点击，或拖画一条粗略笔画。
4. 等待“浏览器本机处理”的蒙版预览。
5. 按 Enter 或点击 Accept 确认；按 Escape 或点击 Cancel 取消。
6. 让 Codex 使用已确认 segment：

```text
Use the confirmed Cowart object segment on the selected image to edit that object and place a revised version beside it.
```

Agent 工作流是：`get_cowart_selection` 或 `get_cowart_canvas` 发现 `confirmedSegments`，可选 `refine_cowart_segment` 扩张、收缩或羽化，调用 `make_cowart_mask({ segmentId })` 生成图像编辑蒙版，再用 `insert_cowart_image` 在源图旁放入新版本并写入 `meta.cowartObjectEdit` 来源信息。`segment_cowart_image` 在没有真实服务端 provider 时会返回 `browser_interaction_required`，不会合成成功结果。

蒙版是给图像模型的指导，不是严格像素保护。只有单独的 `preserveOutside` 合成步骤才能承诺蒙版外逐像素不变。

## 模型、缓存和能力要求

- npm 包：`@mediapipe/tasks-vision@0.10.35`。
- WASM URL：`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm`。
- 模型 URL：`https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite`。
- 模型 SHA-256：`e24338a717c1b7ad8d159666677ef400babb7f33b8ad60c4d96db4ecf694cd25`。
- MediaPipe 固定主机：`cdn.jsdelivr.net` 和 `storage.googleapis.com`；已观测的 tldraw 前端资源主机：`cdn.tldraw.com`。如果网络离线，真实对象选择会失败；离线只用于显式错误场景。Cowart 仍只从 localhost 读取源图字节，不向这些外部主机发起源图上传或外部 mutation。
- 浏览器要求：module Worker、OffscreenCanvas、WebGL2、Web Crypto。缺失时 UI 会显示 unsupported，不会展示假的蒙版。
- 清除模型缓存：在浏览器 DevTools 的 Application 面板清理站点数据，或清理浏览器对上述 MediaPipe 主机的 HTTP cache。
- 清除 Segment Store：删除对应页面目录下的 `canvas/pages/<page-id>/segments/`。被后续修订引用的 segment 不应手动删除。

## Segment Store

Segment Store 是已确认对象蒙版的唯一真源。候选预览只存在于浏览器内存中，不写入 tldraw shape meta。

```text
canvas/pages/<page-id>/segments/<segment-id>/
  mask.png
  preview.png
  segment.json
```

`segment.json` 记录 source shape、asset id、asset SHA-256、自然尺寸、选择方式、provider、mask hash、bbox、area 和 `parentSegmentId`。校正会创建不可变子 segment。源图资产变化后旧 segment 会变 stale，写回和蒙版生成会用 source hash 拒绝过期结果。

## 本地开发

```bash
npm install
npm test
npm run build
npm run test:e2e
npm run dev
```

常用环境变量：

- `COWART_PORT`：本地服务端口，默认 `43217`。
- `COWART_PROJECT_DIR`：画布数据所属的用户项目目录。
- `COWART_CANVAS_DIR`：画布数据目录，默认是 `$COWART_PROJECT_DIR/canvas`。

## 开发者

ZHONG XIN  
zhongxin123456@gmail.com  
https://www.jiqiren.ai

## 致谢

Cowart 的画布能力基于 [tldraw/tldraw](https://github.com/tldraw/tldraw) 实现。
