# Cowart

Cowart 是一个面向 Codex 的本地无限画布插件。它基于 tldraw 提供可视化画布，用于构思、标注、生成图片和根据标注图迭代图片。画布运行在本地网页服务中，数据默认保存到当前用户项目的 `canvas/` 目录，而不是保存到插件仓库里。

English README: [README.en.md](README.en.md)

## 功能

- 在 Codex 中打开一个本地 tldraw 无限画布。
- 在当前项目目录中持久化画布页面和图片资源。
- 在画布中创建 AI image holder；点击生成后形成当前页请求队列，Codex 顺序认领、生成、填回对应 holder，并显示 queued / generating / failed / filled 生命周期。
- 直接从画布选择的批注或目标图读取结构化编辑意图，让 Codex 生成干净的新图并放到原图旁边；截图仍可作为结构化画布不可用时的 fallback。
- 通过 Cowart MCP 工具感知与操作画布：读取选择状态与结构化画布内容、列出当前页生成请求、解析批注（文本与指向目标，支持 target / annotationIds / selectedOnly 过滤）、插入图片、创建 AI image holder、替换图片、更新 holder 请求状态、创建图形（文本/便签/箭头/几何，箭头可绑定到节点形成可跟随的流程图连接）、为局部重绘生成蒙版、记录图片修订血缘（版本间连接）、按画布尺寸推荐生成尺寸、解析多图参考与风格锚点喂给生成、导出视图为图片文件，并保存到页面本地资源目录（AI 图片 holder 是自带状态的自定义形状）。
- 共享画布体验：空画布首启引导，以及 Codex 更新画布时的轻量提示（可一键定位到新内容）。
- MCP server 版本：`0.4.0`；当前公开工具数：`12`。

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

推荐把插件 clone 到 Codex personal marketplace 默认会引用的位置：

```bash
mkdir -p ~/plugins
git clone https://github.com/zyg0733/Cowart.git ~/plugins/cowart
cd ~/plugins/cowart
npm install
npm run build
```

确保 `~/.agents/plugins/marketplace.json` 中有 Cowart 条目：

```json
{
  "name": "personal",
  "interface": {
    "displayName": "Personal"
  },
  "plugins": [
    {
      "name": "cowart",
      "source": {
        "source": "local",
        "path": "./plugins/cowart"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

然后先注册 personal marketplace，再安装插件：

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

Cowart 会启动本地服务，默认地址是：

```text
http://127.0.0.1:43217/
```

画布数据会保存在当前项目目录下：

```text
canvas/pages/<page-id>/cowart-canvas.json
canvas/pages/<page-id>/assets/
```

![在 Codex 中打开 Cowart 画布](assets/open-canvas.png)

### 生成新图

1. 打开 Cowart 画布。
2. 在画布里创建 AI image holder，输入 prompt，并点击生成按钮。
3. 在 Codex 中让它处理当前页请求，例如：

```text
Process the requested Cowart AI image holders on the current page.
```

Codex 会调用 `get_cowart_requests` 读取当前页 queued holder，按 FIFO 顺序逐个用
`expectedRequestId` 认领，按 holder 的尺寸/参考图生成图片，再用同一个 request id
填回对应 holder。生成失败会写入 failed 状态，用户可以在画布上重试；这不是后台
daemon，也不会自动并行处理所有页面。

![使用 Cowart 生成并插入新图](assets/generate-image.png)

### 根据画布批注生成新图

1. 在 Cowart 画布中对图片做批注，并选中目标图片或相关批注箭头。
2. 使用提示：

```text
Use my selected Cowart annotations to generate a clean revised image beside the original.
```

Codex 会先读取 `get_cowart_selection`，再用 `get_cowart_annotations` 的
`targetShapeId`、`annotationIds` 或 `selectedOnly` 过滤器解析批注。原图和批注不会
被删除或移动，结果会作为新图放在原图旁边并记录血缘。若结构化画布数据不可用，
仍可提供标注截图作为 fallback：

```text
Use my Cowart annotation screenshot as a fallback brief to generate a clean revised image beside the original.
```

![根据 Cowart 批注生成修订图](assets/annotation-edit.png)

### 根据标注截图 fallback 生成新图

1. 在 Cowart 画布中对图片做批注。
2. 截图并把标注截图发给 Codex。
3. 使用提示：

```text
Use my Cowart annotation screenshot to generate a clean revised image beside the original.
```

截图流程只作为 fallback；优先使用画布结构化批注。

## 技能

- `cowart:cowart-open-canvas`：打开 Cowart 本地画布。
- `cowart:cowart-image-gen`：顺序处理当前页 AI image holder 生成请求，或把生成图片填入选中的 holder。
- `cowart:cowart-image-edit`：根据选中的 Cowart 结构化批注生成修订图；截图是 fallback。
- `cowart:cowart-sketch-to-image`：把画布上的草图作为结构参考生成成品图，并放在草图旁。

## 本地开发

```bash
npm install
npm run dev
npm run build
```

也可以直接启动画布服务，并指定用户项目目录：

```bash
./scripts/start-canvas.sh /path/to/user/project
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
