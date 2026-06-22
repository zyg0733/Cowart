---
name: cowart-image-gen
description: Generate a final AI bitmap for the Cowart canvas, including any requested in-image text by default. Use when the user asks Codex to create, fill, replace, or place an AI-generated image on a Cowart canvas. If an AI 图片 holder is selected, fill that holder; otherwise generate the image and insert it into the current Cowart page.
---

# Cowart Image Gen

Use this skill when the user wants an AI-generated image placed onto the Cowart canvas. A selected `AI 图片` holder gives a precise size and placement target, but it is not required.

## Preconditions

The Cowart service should be running for the user's active project, usually at:

```text
http://127.0.0.1:43217
```

New holders are a custom `cowart-ai-image` shape that **owns its image** via
`props.assetId` and tracks `props.status` (`empty` / `requested` / `generating` /
`filled`) and an optional `props.prompt`:

```json
{
  "type": "cowart-ai-image",
  "props": { "status": "empty", "prompt": "", "assetId": null },
  "meta": { "cowartAiImageHolder": true }
}
```

To **fill** a `cowart-ai-image` holder, use the Cowart MCP `replace_cowart_image`
tool with the holder id — it sets the holder's own `assetId` and marks it `filled`.
Do **not** add a child image or use `insert_cowart_image` `fillAnchor` on it.

A holder may be flagged `status: "requested"` (the user clicked its 生成/重生成
button). Read pending requests via `get_cowart_canvas` (holders with
`status: "requested"` plus their `prompt`) and fill them.

Older canvases may still contain legacy `frame` or `geo` rectangle holders with the
same `meta.cowartAiImageHolder` flag — those are filled the legacy way (a child image
via `insert_cowart_image` `fillAnchor`). Support all of them.

## Workflow

1. Read the selected shape from Cowart:

   ```bash
   curl -s http://127.0.0.1:43217/api/selection
   ```

   You can also use the Cowart MCP `get_cowart_selection` tool if it is available.

2. Check whether exactly one selected shape is an AI image holder. A holder is any selected shape with either:

   ```text
   isAiImageHolder: true
   ```

   or:

   ```text
   meta.cowartAiImageHolder: true
   ```

   If yes, use the holder workflow below. If not, do not ask the user to select a holder; use the standalone workflow below and insert the generated image into the current Cowart page.

3. Choose the placement workflow.

   Holder workflow: use the selected holder's `props.w` and `props.h` as the size contract. The generated image should match the holder aspect ratio as closely as possible.

   If the holder `type` is `cowart-ai-image` (the current holder):

   - **Size**: use the holder's `suggestedGenSize` from `get_cowart_canvas` as the
     generation size — it is already a valid gpt-image size (multiple of 16, aspect
     1:3–3:1) matching the box the user drew, so the result fits without cropping.
   - **References / style**: if the holder has reference images, resolve them with
     `get_cowart_references` (it reads the holder's `meta.cowartReferences` /
     `meta.cowartStyleRef`, or pass explicit `shapeIds`) and pass their base64 to
     image generation as `input_image` — the one tagged `role: "style"` is the style
     reference (style_match), the rest are content/composition references.
   - **Busy state**: before generating, mark it busy with `update_cowart_holder`
     `status: "generating"` (the holder shows a spinner the user sees via live refresh).
   - Read its `props.prompt` (the user may have typed it directly on the holder).
   - **Fill**: `replace_cowart_image` (holder id + generated `imageBase64`) sets the
     holder's own image and marks it `filled`; do not create a separate image shape.
     Pass `genParams` (prompt, references, size, model, seed) to record the call on the
     shape (`meta.cowartGen`) so it can be reproduced or forked later.

   If the holder `type` is `frame` (legacy), insert the generated image as a child of the frame:

   - `parentId`: holder shape id
   - `x`: `0`
   - `y`: `0`
   - `rotation`: `0`
   - `props.w`, `props.h`: same as holder

   This makes the generated image move with the frame.

   If the holder is a legacy `geo` rectangle, keep using the legacy placement contract: same `x`, `y`, `rotation`, `parentId`, `props.w`, and `props.h` as the holder.

   Standalone workflow: when no AI holder is selected, generate the image anyway and insert it as a normal image shape on the current page. Prefer the current page from Cowart view state; if there is a selected non-holder shape and it is useful as context, place the image beside it, otherwise place it in a clear page area. Use the generated bitmap's aspect ratio and a practical display width such as 512 canvas units unless the user requested a different size or aspect ratio.

4. Generate the bitmap with the built-in `imagegen` skill unless the user explicitly requests another image path. If the requested asset needs visible copy, labels, poster text, ad text, UI text, or typography, include that text directly in the image generation prompt and let the image model produce the final bitmap. Do not default to generating a text-free background and then adding text locally unless the user explicitly asks for local typography, deterministic text overlay, SVG/vector output, or another non-imagegen layout step.

   Preferred handoff: pass the generated image to Cowart **as base64** rather than
   hunting for a file. The built-in `image_gen` tool returns base64 in the
   `image_generation_call.result`; pass that straight to `insert_cowart_image`
   (or `replace_cowart_image`) via `imageBase64` (or `imageDataUrl`). Cowart decodes
   it, reads dimensions from the bytes, and saves it into the page assets folder.
   This avoids depending on `$CODEX_HOME/generated_images` (which may not be written).

   Only if you already have a real file path (and no base64) fall back to resolving it:

   Do not assume the built-in image generation flow always writes a fresh file under `$CODEX_HOME/generated_images`.

   Preferred resolution order:

   - Use the exact local image path returned by the current image generation tool call when one is available.
   - If no new file path is returned, inspect the current Codex session JSONL for the current request and extract the PNG/base64 payload from the latest `image_generation_call.result`, then write it to a timestamped output filename.
   - Use `$CODEX_HOME/generated_images` only when you can prove the file was created by the current request, for example by matching its timestamp after this generation step. Never pick an older image merely because it is the newest file in a stale generated_images directory.

   Before inserting the resolved file into Cowart, visually inspect the local bitmap and confirm it is the newly generated image for this request, not a stale generated asset.

   For project-bound output, copy the resolved generated image into the selected page's asset folder:

   ```text
   canvas/pages/<page-id-without-page-prefix>/assets/
   ```

5. Insert the generated image as a new tldraw image shape.

   Prefer the Cowart MCP `insert_cowart_image` tool over hand-writing tldraw
   records and fractional `index` keys. The tool copies the bitmap into the
   page-local assets folder, builds the asset and shape, and saves through the
   running Cowart service:

   - Holder workflow: pass the holder as `anchorShapeId` with `fillAnchor: true`.
     For a `frame` holder the image is added as a child at `0,0` sized to the
     frame; for a legacy `geo` holder it overlays the holder's position, size,
     and rotation. The tool sets `meta.cowartGeneratedForAiImageHolder` to the
     holder id automatically.
   - Standalone workflow: omit `fillAnchor`. Pass a non-holder `anchorShapeId`
     (or `placement`) to place the image beside that shape, or only `pageId` to
     drop it into a clear area on the current page.

   If the MCP tool is unavailable, fall back to writing records by hand using
   the contracts below.

   For the holder workflow, place it exactly over the holder:

   - `type`: `image`
   - `parentId`: holder id for frame holders, same as holder parent for legacy geo holders
   - `x`, `y`, `rotation`: `0`, `0`, `0` for frame holders, same as holder for legacy geo holders
   - `props.w`, `props.h`: same as holder
   - `props.assetId`: the new image asset id
   - `meta.cowartGeneratedForAiImageHolder`: holder shape id

   For the standalone workflow, insert it into the current page as a normal image:

   - `type`: `image`
   - `parentId`: current page id, unless placing beside a selected non-holder shape requires the same parent
   - `x`, `y`: a clear page area or beside the selected non-holder shape
   - `rotation`: `0`
   - `props.w`, `props.h`: display size matching the generated bitmap aspect ratio
   - `props.assetId`: the new image asset id
   - `meta.cowartGeneratedStandalone`: `true`

6. Do not delete the holder unless the user explicitly asks for replacement. Keeping the holder lets Codex identify the intended slot again later. In the standalone workflow, do not create a holder first unless the user explicitly asks for one.

7. Save through Cowart's API or edit the page snapshot carefully:

   ```bash
   curl -s http://127.0.0.1:43217/api/canvas
   ```

   Prefer page-local asset URLs in the image asset:

   ```text
   /page-assets/<page-id-without-page-prefix>/<filename>
   ```

8. Refresh or let the browser hot-reload, then confirm the inserted shape id, final dimensions, and saved asset path. Include the holder id only when the holder workflow was used.

## Notes

- If the holder is a legacy rotated `geo` rectangle, preserve the same `rotation` on the image. For `frame` holders, the frame owns placement and the child image should stay unrotated inside it.
- To create a holder on demand (only when the user asks for one), prefer the Cowart MCP `create_cowart_image_holder` tool instead of hand-writing a `frame` record. It mirrors the UI's AI 图片 holder exactly and places it beside an anchor or in a clear area.
- If there is already a generated image for the same holder and the user says "替换", prefer the Cowart MCP `replace_cowart_image` tool (pass the existing image shape id, or the frame holder whose image should be swapped) instead of piling another copy on top. It swaps the bitmap in place, keeps position and size, and removes the now-unreferenced old asset.
- Do not refuse generation solely because no `AI 图片` holder is selected. Generate the bitmap and insert it into the current Cowart page.
- Never overwrite an existing asset file without an explicit replace request; use a timestamped filename.
