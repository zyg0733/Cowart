# Cowart

Cowart is a local infinite-canvas plugin for Codex. It brings a tldraw-powered canvas into Codex for visual thinking, annotation, image generation, Object Selection, and canvas-driven image edits. The canvas runs as a local web service, and its data is saved in the active user project under `canvas/` instead of inside the plugin repository.

中文说明: [README.md](README.md)

## Features

- Open a local tldraw infinite canvas from Codex.
- Persist canvas pages, image assets, and confirmed object segments in the active project directory.
- Create AI image holders on the canvas; clicking generate creates a current-page request queue that Codex processes sequentially, with queued / generating / failed / filled lifecycle states.
- Read selected annotations, selected target images, or confirmed object segments as structured edit intent, then let Codex generate clean revised images beside the original. Screenshots remain a fallback when structured canvas data is unavailable.
- Object Selection: select one local image, switch to the Object tool, then click or drag over the object. Cowart runs MediaPipe Interactive Segmenter with browser-local processing, previews the mask, accepts with Enter, and cancels with Escape. Confirmed segments rehydrate after reload.
- Browser-local processing: the source image is fetched only from localhost. The source image is never uploaded by Cowart. First use downloads pinned model and WASM assets; the tldraw runtime may also load frontend assets from `cdn.tldraw.com`.
- Use Cowart MCP tools to perceive and act on the canvas: `get_cowart_selection`, `insert_cowart_image`, `get_cowart_canvas`, `get_cowart_annotations`, `create_cowart_image_holder`, `replace_cowart_image`, `export_cowart_view`, `add_cowart_shapes`, `make_cowart_mask`, `update_cowart_holder`, `get_cowart_references`, `get_cowart_requests`, `segment_cowart_image`, `refine_cowart_segment`.
- MCP server version: `0.5.0`; current public tool count: `14`.

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

```bash
mkdir -p ~/plugins
git clone https://github.com/zyg0733/Cowart.git ~/plugins/cowart
cd ~/plugins/cowart
npm install
npm run build
```

Then register and install the plugin:

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

Cowart starts at:

```text
http://127.0.0.1:43217/
```

Canvas data is saved in the active project:

```text
canvas/pages/<page-id>/cowart-canvas.json
canvas/pages/<page-id>/assets/
canvas/pages/<page-id>/segments/<segment-id>/
```

### Generate A New Image

1. Open Cowart.
2. Create an AI image holder, enter a prompt, and click generate.
3. Ask Codex:

```text
Process the requested Cowart AI image holders on the current page.
```

Codex calls `get_cowart_requests`, claims each queued holder in FIFO order with `expectedRequestId`, then fills that same holder with `replace_cowart_image`. Cowart does not run a background daemon or process every page automatically.

### Generate From Canvas Annotations

1. Annotate an image on the Cowart canvas and select the target image or relevant annotation arrows.
2. Use this prompt:

```text
Use my selected Cowart annotations to generate a clean revised image beside the original.
```

Codex reads `get_cowart_selection`, then resolves annotations through `get_cowart_annotations` using `targetShapeId`, `annotationIds`, or `selectedOnly`. It keeps the original image and annotations untouched, places the revised image beside the original, and records lineage.

### Object Selection And Object Editing

1. Select one normal image or filled `cowart-ai-image` holder.
2. Click the Object tool in the bottom toolbar.
3. Click the object, or drag a rough scribble over it.
4. Wait for the browser-local mask preview.
5. Press Enter or click Accept to confirm; press Escape or click Cancel to cancel.
6. Ask Codex to use the confirmed segment:

```text
Use the confirmed Cowart object segment on the selected image to edit that object and place a revised version beside it.
```

The agent workflow is: discover `confirmedSegments` with `get_cowart_selection` or `get_cowart_canvas`, optionally call `refine_cowart_segment` to expand, contract, or feather the segment, call `make_cowart_mask({ segmentId })` to materialize the edit mask, then use `insert_cowart_image` to place a neighboring revision with `meta.cowartObjectEdit` provenance. `segment_cowart_image` returns `browser_interaction_required` when no real server provider is configured; it does not synthesize segment success.

The mask is guidance for the image model, not a pixel lock. Only a separate `preserveOutside` compositing step can promise unchanged pixels outside the mask.

## Model, Cache, And Capability Requirements

- npm package: `@mediapipe/tasks-vision@0.10.35`.
- WASM URL: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm`.
- Model URL: `https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite`.
- Model SHA-256: `e24338a717c1b7ad8d159666677ef400babb7f33b8ad60c4d96db4ecf694cd25`.
- MediaPipe pinned hosts: `cdn.jsdelivr.net` and `storage.googleapis.com`; observed tldraw frontend asset host: `cdn.tldraw.com`. Real Object Selection fails honestly offline unless the test is an explicit offline error scenario. Cowart still fetches source image bytes only from localhost and does not send source images or external mutations to those hosts.
- Browser requirements: module Worker, OffscreenCanvas, WebGL2, and Web Crypto. If a capability is missing, the UI shows unsupported instead of a synthetic preview.
- Clear model cache: clear site data in browser DevTools, or clear the browser HTTP cache entries for the MediaPipe pinned hosts above.
- Clear Segment Store: remove the page directory under `canvas/pages/<page-id>/segments/`. Do not manually remove a segment that later revisions reference.

## Segment Store

Segment Store is the source of truth for confirmed object masks. Candidate previews stay in browser memory and are not written to tldraw shape meta.

```text
canvas/pages/<page-id>/segments/<segment-id>/
  mask.png
  preview.png
  segment.json
```

`segment.json` records the source shape, asset id, asset SHA-256, natural size, selection mode, provider, mask hash, bbox, area, and `parentSegmentId`. Refinement creates an immutable child segment. If source asset bytes change, the old segment becomes stale; mask generation and writeback reject it through source hash checks.

## Local Development

```bash
npm install
npm test
npm run build
npm run test:e2e
npm run dev
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
