# Cowart

Cowart is a local infinite-canvas plugin for Codex. It brings a tldraw-powered canvas into Codex for visual thinking, annotation, image generation, Object Selection, and canvas-driven image edits. The canvas runs as a local web service, and its data is saved in the active user project under `canvas/` instead of inside the plugin repository.

中文说明: [README.md](README.md)

## Features

- Open a local tldraw infinite canvas from Codex.
- Persist canvas pages, image assets, and confirmed object segments in the active project directory.
- Create AI image holders on the canvas; clicking generate creates a current-page request queue that Codex processes sequentially, with queued / generating / failed / filled lifecycle states.
- Read selected annotations, selected target images, or confirmed object segments as structured edit intent, then let Codex generate clean revised images beside the original. Screenshots remain a fallback when structured canvas data is unavailable.
- Object Selection: select one local image, switch to the Object tool, then click or drag over the object. Cowart runs MediaPipe Interactive Segmenter with browser-local processing. Correct candidates with add/remove brushes, brush size, undo, redo, reset, and candidate switching; confirmed segments rehydrate and can publish immutable child revisions.
- Object actions: `sharp@0.35.0` extracts real transparent PNG layers locally. Modify, replace, and remove create segment-backed AI holder requests. Variant Grid defaults to four holders, caps at six, stays FIFO, and retains non-winners.
- Protected compositing: `insert_cowart_image` and `replace_cowart_image` support `preserveOutside`, keeping decoded RGBA bytes outside the mask identical to the source.
- Browser-local processing: the source image is fetched only from localhost. The source image is never uploaded by Cowart. First use downloads pinned model and WASM assets; the tldraw runtime may also load frontend assets from `cdn.tldraw.com`.
- Use Cowart MCP tools to perceive and act on the canvas: `get_cowart_selection`, `insert_cowart_image`, `get_cowart_canvas`, `get_cowart_annotations`, `create_cowart_image_holder`, `replace_cowart_image`, `export_cowart_view`, `add_cowart_shapes`, `make_cowart_mask`, `update_cowart_holder`, `get_cowart_references`, `get_cowart_requests`, `segment_cowart_image`, `refine_cowart_segment`, `extract_cowart_object`, `create_cowart_variant_grid`, `select_cowart_variant`, `create_cowart_decomposition`, `publish_cowart_decomposition_artifact`.
- MCP server version: `0.7.0`; current public tool count: `19`.

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
5. Keep Select active for more candidates, or use Add / Remove brushes with brush size, undo, redo, and reset.
6. Press Enter or click Accept to confirm; press Escape or click Cancel to cancel.
7. Ask Codex to use the confirmed segment:

```text
Use the confirmed Cowart object segment on the selected image to edit that object and place a revised version beside it.
```

The agent workflow is: discover `confirmedSegments` with `get_cowart_selection` or `get_cowart_canvas`; use `extract_cowart_object` for a source-derived transparent layer; queue generative work with `create_cowart_image_holder.objectAction` or `create_cowart_variant_grid`; write results through `preserveOutside`; and record a winner with `select_cowart_variant`. `get_cowart_canvas.lineageTimeline` is a read-only projection of sources, actions, variants, and winners. `segment_cowart_image` can call the loopback Sidecar, but only explicit `publish=true` writes Segment Store; without Sidecar configuration it returns `browser_interaction_required`.

### Local Sidecar

```bash
npm run sidecar:setup
npm run sidecar:start
npm run sidecar:smoke
```

`sidecar:setup` explicitly installs a Python 3.11 environment and downloads checksum-verified, revision-pinned Grounding DINO Tiny and SAM 2.1 Hiera Tiny models. The Sidecar binds only to `127.0.0.1`, requires a `0600` bearer-token file, runs one task with at most two waiting requests and four CPU threads, and unloads idle models after five minutes. It has no automatic model download, wildcard CORS, cloud access, or cloud fallback.
`sidecar:smoke` runs real point, text, and automatic inference against a locally generated image and reports the selected device, elapsed time, and peak memory.

Browser Text/Auto modes use the Sidecar through a local Node proxy, so the token never reaches page code. MCP returns candidates by default and requires `publish=true` to register a chosen candidate as a confirmed mask.

Resource targets: normal canvas use adds almost nothing; MediaPipe usually uses hundreds of MB briefly; Sidecar Tiny point/text stays below 6 GB and automatic mode below 8 GB; 4K `sharp` composition stays below 400 MB peak. Mac prefers MPS and Linux prefers CUDA, with one explicit CPU fallback after initialization or inference failure.

### Scene Decomposition

`create_cowart_decomposition` requires `confirmUpload=true` for every request and queues a FIFO `scene_decomposition` holder. Codex `image_gen` normally produces two inferred artifacts: a relative grayscale `depth_hint` and a foreground-removed `clean_plate`. Generated images first land on the canvas via `insert_cowart_image` or `replace_cowart_image`, then `publish_cowart_decomposition_artifact` registers them. `get_cowart_references({ decompositionId })` resolves the source, confirmed segments, and existing artifacts.

Cowart stores no OpenAI API key and does not call the Image API directly; the Codex platform manages the concrete image model and provenance is `codex-image_gen`. Visible object layers use source pixels and Segment Store masks and are marked `synthetic: false`. Depth hints, clean plates, and occlusion completion are marked as AI inference. A depth hint is not metric depth, AI output cannot become a confirmed mask directly, and occlusion completion is not original-image recovery.
Before publishing `completed_object`, the generated candidate must be segmented by the Sidecar SAM 2 path and transparently extracted; that confirmed mask is recorded as `generatedSegmentId`.

The mask remains guidance for the image model. With `preserveOutside`, Cowart locally decodes and deterministically composites source and candidate pixels, guaranteeing identical RGBA bytes wherever the selection mask is zero.

## Model, Cache, And Capability Requirements

- npm package: `@mediapipe/tasks-vision@0.10.35`.
- WASM URL: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm`.
- Model URL: `https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite`.
- Model SHA-256: `e24338a717c1b7ad8d159666677ef400babb7f33b8ad60c4d96db4ecf694cd25`.
- Sidecar Grounding DINO revision: `a2bb814dd30d776dcf7e30523b00659f4f141c71`; weight SHA-256: `1a2412ef99bd74bcd3c2a246fa1e48581f8889a1300c9051974741314fc042f3`.
- Sidecar SAM 2.1 revision: `de431c4043854a71d8101e17995dfe596bf101a5`; weight SHA-256: `48c14467e5cf9e51870511feb72c89688e82dd74523142c0538b663e193ac2a7`.
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
  manifest.json
```

`manifest.json` records the source shape, asset id, asset SHA-256, natural size, selection mode, provider, mask hash, bbox, area, and `parentSegmentId`. Refinement creates an immutable child segment. If source asset bytes change, the old segment becomes stale; mask generation and writeback reject it through source hash checks.

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
- `COWART_SIDECAR_URL`: Sidecar loopback URL, default `http://127.0.0.1:43219`.
- `COWART_SIDECAR_HOME`, `COWART_SIDECAR_DEVICE`: Sidecar data directory and `auto|mps|cuda|cpu` selection.

## Developer

ZHONG XIN  
zhongxin123456@gmail.com  
https://www.jiqiren.ai

## Acknowledgements

Cowart's canvas experience is built on top of [tldraw/tldraw](https://github.com/tldraw/tldraw).
