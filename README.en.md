# Cowart

Cowart is a local infinite-canvas plugin for Codex. It brings a tldraw-powered canvas into Codex for visual thinking, annotation, image generation, and annotation-driven image edits. The canvas runs as a local web service, and its data is saved in the active user project under `canvas/` instead of inside the plugin repository.

中文说明: [README.md](README.md)

## Features

- Open a local tldraw infinite canvas from Codex.
- Persist canvas pages and image assets in the active project directory.
- Create AI image holders on the canvas; clicking generate creates a current-page request queue that Codex processes sequentially, with queued / generating / failed / filled lifecycle states.
- Read selected canvas annotations or selected target images as structured edit intent, then let Codex generate clean revised images beside the original. Annotation screenshots remain a fallback when structured canvas data is unavailable.
- Use Cowart MCP tools to perceive and act on the canvas: read selection state and structured canvas content, list current-page generation requests, parse annotations (text and target shape, with target / annotationIds / selectedOnly filters), insert images, create AI image holders, replace images, update holder request status, author shapes (text/sticky/arrow/geometry; arrows can bind to nodes for follow-on-move flowchart connectors), build inpainting masks for region-only edits, track image revision lineage (connectors between versions), suggest a generation size from the drawn box, resolve multi-image references and a style anchor to feed generation, export views to image files, and save page-local assets (the AI image holder is a custom stateful shape).
- Shared-canvas UX: a first-run empty-canvas guide, and a lightweight toast when Codex updates the canvas (one click to locate the new content).
- MCP server version: `0.4.0`; current public tool count: `12`.

## Installation

### Ask Codex To Install It

Send the following message to Codex:

```text
Please install the Cowart Codex plugin from https://github.com/zyg0733/Cowart.git.
Clone the repository into ~/plugins/cowart, verify that .codex-plugin/plugin.json exists,
add the plugin to the personal marketplace, run codex plugin marketplace add ~,
then run codex plugin add cowart@personal.
After installing, validate the plugin and tell me whether I should start a new conversation to load the new skills and MCP tools.
```

### Manual Install

Clone the plugin into the default location referenced by the Codex personal marketplace:

```bash
mkdir -p ~/plugins
git clone https://github.com/zyg0733/Cowart.git ~/plugins/cowart
cd ~/plugins/cowart
npm install
npm run build
```

Make sure `~/.agents/plugins/marketplace.json` contains a Cowart entry:

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

Then register the personal marketplace and install the plugin:

```bash
codex plugin marketplace add ~
codex plugin add cowart@personal
```

After installing, start a new Codex conversation so the new skills and MCP tools are loaded cleanly.

## Usage

### Open The Canvas

Ask Codex:

```text
Open the Cowart canvas for this project.
```

Cowart starts a local service at:

```text
http://127.0.0.1:43217/
```

Canvas data is saved in the active project:

```text
canvas/pages/<page-id>/cowart-canvas.json
canvas/pages/<page-id>/assets/
```

![Open Cowart canvas in Codex](assets/open-canvas.png)

### Generate A New Image

1. Open the Cowart canvas.
2. Create an AI image holder, enter a prompt, and click its generate button.
3. Ask Codex to process the current-page request queue, for example:

```text
Process the requested Cowart AI image holders on the current page.
```

Codex calls `get_cowart_requests`, claims each queued holder in FIFO order with
`expectedRequestId`, generates using the holder size and references, then fills
that same holder with the same request id. Failures are written back as a failed
state so the user can retry from the canvas. Cowart does not run a background
daemon, process requests in parallel, or scan every page automatically.

![Generate and insert a new image with Cowart](assets/generate-image.png)

### Generate From Canvas Annotations

1. Annotate an image on the Cowart canvas and select the target image or relevant annotation arrows.
2. Use this prompt:

```text
Use my selected Cowart annotations to generate a clean revised image beside the original.
```

Codex reads `get_cowart_selection`, then resolves annotations through
`get_cowart_annotations` using `targetShapeId`, `annotationIds`, or
`selectedOnly`. It keeps the original image and annotation shapes untouched,
places the revised image beside the original, and records lineage. If structured
canvas data is unavailable, you can still provide an annotation screenshot as a
fallback brief:

```text
Use my Cowart annotation screenshot as a fallback brief to generate a clean revised image beside the original.
```

![Generate a revised image from Cowart annotations](assets/annotation-edit.png)

### Generate From An Annotation Screenshot Fallback

1. Annotate an image on the Cowart canvas.
2. Take a screenshot of the annotated image and send it to Codex.
3. Use this prompt:

```text
Use my Cowart annotation screenshot to generate a clean revised image beside the original.
```

The screenshot path is fallback only; structured canvas annotations are the default.

## Skills

- `cowart:cowart-open-canvas`: open the local Cowart canvas.
- `cowart:cowart-image-gen`: sequentially process current-page AI image holder requests, or fill a selected holder.
- `cowart:cowart-image-edit`: generate revised images from selected structured Cowart annotations; screenshots are a fallback.
- `cowart:cowart-sketch-to-image`: turn a canvas sketch into a finished image (using it as a structure reference) placed beside the sketch.

## Local Development

```bash
npm install
npm run dev
npm run build
```

You can also start the canvas service directly and pass the active user project directory:

```bash
./scripts/start-canvas.sh /path/to/user/project
```

Useful environment variables:

- `COWART_PORT`: local service port, default `43217`.
- `COWART_PROJECT_DIR`: the user project directory that owns the canvas data.
- `COWART_CANVAS_DIR`: canvas data directory, default `$COWART_PROJECT_DIR/canvas`.

## Developer

ZHONG XIN  
zhongxin123456@gmail.com  
https://www.jiqiren.ai

## Acknowledgements

Cowart's canvas experience is built on top of [tldraw/tldraw](https://github.com/tldraw/tldraw).
