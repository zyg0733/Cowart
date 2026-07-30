---
name: cowart-image-edit
description: Generate revised AI images from Cowart 批注 annotations. Use when the user selects an annotated image or annotation arrows on the Cowart canvas, or provides a fallback screenshot, and wants Codex to apply the requested changes while leaving the original image and annotations intact.
---

# Cowart Image Edit

Use this skill to turn Cowart 批注 annotations into revised AI-generated
bitmaps. The default path is canvas-native: read the current selection, resolve
structured annotations, generate a clean revision, and place the result beside
the original. Screenshots remain a fallback when the canvas service or
structured data is unavailable.

## Preconditions

The Cowart service should be running for the active project, usually at:

```text
http://127.0.0.1:43217
```

Do not scan all pages to infer edit requests. Start from the current selection.
If nothing is selected, read only the current page's structured annotations and
ask one focused clarification question when multiple targets could be edited.

## Workflow

1. Read the canvas selection first.

   Call `get_cowart_selection`. The selected shapes determine the default edit
   scope:

   - selected annotation arrows: collect their ids and call
     `get_cowart_annotations({ annotationIds: [...] })`
   - selected target image/frame/filled `cowart-ai-image` holder: call
     `get_cowart_annotations({ targetShapeId: "<selected target id>" })`
   - mixed selection or uncertain selection: call
     `get_cowart_annotations({ selectedOnly: true })` and use only selected
     arrows plus annotations whose resolved target is selected

   These are the three supported structured filters: `annotationIds`,
   `targetShapeId`, and `selectedOnly`.

2. Handle no selection conservatively.

   If no shapes are selected, call `get_cowart_annotations` with no `allPages`
   flag. This reads the current page only and preserves the existing unfiltered
   current-page contract. If every returned annotation resolves to the same
   target, proceed. If there are multiple target images, ask one focused
   question such as:

   ```text
   Which annotated target should I revise: <id/label A> or <id/label B>?
   ```

   Do not ask a broad multi-part questionnaire, and do not switch to all-pages
   discovery unless the user explicitly asks.

3. Choose the source image.

   The target may be a normal image, a legacy frame holder containing an image,
   or a filled current `cowart-ai-image` holder. Export the clean source with
   `export_cowart_view` or use `make_cowart_mask`, which can resolve filled
   current holders to their owned asset. Empty, requested, generating, or failed
   holders are not valid image sources.

   If structured data is unavailable but the user supplied a screenshot, use the
   screenshot as the visual brief. Ignore editor chrome such as toolbars,
   selection outlines, resize handles, cursors, and unrelated neighboring images.

4. Prepare the edit prompt.

   Combine the structured annotation labels and target/arrow positions into one
   concise instruction set. The prompt should:

   - apply the 批注 text as edit instructions
   - preserve the original image's subject, composition, aspect ratio, and style unless an annotation asks otherwise
   - remove all annotation artifacts from the output, including red arrows, labels, blue selection outlines, handles, and tool UI
   - output only the revised clean image

5. Choose full-image or masked editing.

   Use a full-image edit when the annotations describe global style, layout, or
   subject changes.

   Use a masked edit when the change is localized. Prefer confirmed object
   segments when the selected source exposes `confirmedSegments` from
   `get_cowart_selection` or `get_cowart_canvas`. Segment Store records are the
   source of truth; ignore candidate shape/meta records.

  For object-aware edits, use this exact sequence:

  - choose the confirmed segment that matches the intended object
  - optionally call `refine_cowart_segment` with `expandPixels`,
     `contractPixels`, or `featherPixels` when the user asks for a broader,
     tighter, or softer mask
  - call `make_cowart_mask({ segmentId, returnBase64: true })` to materialize
     the edit mask
  - pass the source image, edit mask, and prompt to image generation
  - insert the result as a neighboring revision with `insert_cowart_image`
     instead of replacing the source unless the user explicitly asks

   If no confirmed segment exists, ask the user to use the canvas object tool to
   select and confirm the object. `segment_cowart_image` may return
   `browser_interaction_required` when no real server provider is configured; do
   not treat that as a failed generation or invent a segment.

   For rectangle-only edits, build the mask with `make_cowart_mask`:

   - pass `targetShapeId` for the image or filled holder
   - use `region` around the annotation tip/target area, or `regionShapeId` when
     the user drew a rectangle over the exact region
   - set `returnBase64: true` when you want source image and mask bytes directly

   The mask uses transparent pixels for the editable region and opaque pixels for
   areas to preserve, but it is guidance for the image model. Do not promise
   unchanged outside pixels unless a separate `preserveOutside` compositing step
   is performed after generation.

6. Generate a new bitmap.

   Use the built-in image generation flow available in the current environment.
   Do not overwrite the source image file. Prefer base64 from
   `image_generation_call.result`; pass it to Cowart via `imageBase64` or
   `imageDataUrl`. Only resolve a local file when the tool returned one for this
   generation.

7. Insert the revised image beside the original.

   Prefer the Cowart MCP `insert_cowart_image` tool. Do not hand-write
   tldraw `asset` / `shape` records or fractional `index` keys unless the MCP
   tool is unavailable. The tool copies the bitmap into the page-local assets
   folder, creates the tldraw image asset and image shape, generates a valid
   tldraw fractional index, places the image beside the anchor while avoiding
   overlaps, and saves through the running Cowart service.

   Add a new tldraw image asset and a new image shape. Do not update, remove,
   hide, reparent, or reorder the original image, original holder, or annotation
   shapes.

   Prefer a clear placement anchor when one is already available:

   - If the user selected the original image, legacy frame, or filled current
     holder, use it as the anchor.
   - If selected annotation arrows resolve to one target, use that target as the
     anchor.
   - If multiple outputs have non-unique anchors, ask one focused question to map
     targets to outputs.
   - If no anchor is clear and the user has not required a specific side-by-side comparison, place the result in a nearby clear area on the current page where it does not cover, move, hide, or delete the original image or annotations.

   Placement rules:

   - If the source image is inside a legacy `AI 图片` frame, use the frame's page-level bounds as the anchor and place the new image as a sibling of that frame.
   - If the source is a filled current `cowart-ai-image` holder, use the holder bounds as the anchor and place the revision as a sibling, not inside the holder.
   - Otherwise use the source image's own bounds and parent.
   - When the annotated source appears to have earlier revision images nearby, prefer placing the new revised image to the right of the currently annotated/source image, because older annotation outputs may already live on the left.
   - To keep an auditable trail, pass `lineageOf` (the source image shape id) plus
     `prompt` and `version` to `insert_cowart_image`. It records lineage metadata and
     draws a dotted connector from the previous version to the new one, so the
     original → v2 → v3 progression is visible and tracks moves.
  - For object-aware edits, pass `expectedSourceAssetHash` plus only the
     caller-safe `objectEdit` fields: `segmentId`, `editMaskSha256`,
     `operation`, `prompt`, `provider`, `model`, and an ISO timestamp. Cowart
     derives protected source identity (`sourceShapeId`, `sourceAssetId`,
     `sourceSha256`) and the segment selection mask hash from the validated
     Segment Store source, so agents must not invent or override those fields.
     This provenance is for the neighboring revision and should not expose
     protected fields as caller-controlled arguments.
   - Place the new image to the right of the anchor with a margin of about `40` canvas units.
   - Match the displayed width and height of the anchor unless the user asks for a different size.
   - If that position would overlap existing content, keep moving right by `anchor width + 40` until the new image is clear.
   - If using a clear-area fallback with no anchor, keep the generated image near the annotated source page, match the likely source image size when known, and choose a position that does not overlap existing shapes.

   Recommended shape metadata:

   ```json
   {
     "cowartGeneratedFromAnnotationEdit": true,
     "cowartAnnotationSourceShapeId": "<selected source image or frame id>",
     "cowartAnnotationScreenshot": "<source screenshot file name when available>"
   }
   ```

8. Save through Cowart.

   Use Cowart state to insert the new image beside the anchor or in a nearby
   clear area, not to mutate the original or annotations.

   Preferred MCP call shape:

   ```json
   {
     "imagePath": "/absolute/path/to/annotation-edit-20260620-153012.png",
     "projectDir": "/absolute/path/to/user/codex-project",
     "cowartUrl": "http://127.0.0.1:43217",
     "anchorShapeId": "<selected source image or frame id>",
     "placement": "right",
     "margin": 40,
     "matchAnchor": true,
     "fileName": "annotation-edit-20260620-153012.png",
     "annotationScreenshot": "<source screenshot file name when available>",
     "shapeMeta": {
       "cowartGeneratedFromAnnotationEdit": true
     },
     "altText": "Revised image generated from Cowart annotations"
   }
   ```

   If the running Cowart service uses a Vite fallback port, pass the actual
   browser URL such as `http://127.0.0.1:43218` as `cowartUrl`.

   The MCP tool must return the new `assetId`, `shapeId`, saved asset path,
   page id, bounds, and generated `index`. Confirm that the returned `index` is
   a valid tldraw fractional index and not a custom descriptive string.

   Fallback only when MCP is unavailable: update the required store snapshot and
   save through:

   ```bash
   curl -s -X PUT http://127.0.0.1:43217/api/canvas \
     -H 'content-type: application/json' \
     --data-binary @<updated-snapshot.json>
   ```

   In fallback mode, use page-local image asset URLs:

   ```text
   /page-assets/<page-dir>/<filename>
   ```

   The Cowart server will preserve per-page snapshots under:

   ```text
   canvas/pages/<page-id-without-page-prefix>/cowart-canvas.json
   ```

9. Verify visually.

   Refresh the Cowart tab or let Vite hot-reload, then confirm:

   - the original image is still in the same place
   - the original 批注 arrows and labels are still visible and unmodified
   - the new revised image appears beside the original
   - the new image does not include annotation arrows, labels, selections, or UI chrome

## Region-only edits (masked / inpainting)

When the change is confined to a marked area, prefer a masked edit over
regenerating the whole image:

1. Determine the edit region from selected structured annotations. Use
   `get_cowart_annotations` with `annotationIds`, `targetShapeId`, or
   `selectedOnly` to get the annotation target and arrow tip, or have the user
   draw a rectangle over the area.
2. Build a mask with the Cowart MCP `make_cowart_mask` tool: pass the target image
   shape plus the region as `region` (page coords `{x,y,w,h}`, e.g. a box around the
   annotation tip) or `regionShapeId` (a rectangle marking the area), with
   `returnBase64: true`. It returns the source image + a PNG mask in the image's pixel
   space (transparent = edit, opaque = keep).
3. Call `image_gen` with the source image, the mask, and a prompt describing only the
   change. The mask is guidance for the model: transparent pixels mark the edit
   area and opaque pixels mark the area to preserve. Do not claim pixel-identical
   outside-mask preservation unless a separate `preserveOutside` compositing
   step is actually performed after generation.
4. Write the result back:
   - to revise in place (only when the user wants to edit the original), use
     `replace_cowart_image` with the result `imageBase64` and the target shape id;
   - otherwise place the edited copy beside the original with `insert_cowart_image`.

Use `padding` to give the model a little context around the region. `invert: true`
flips polarity if the model you call treats opaque as the editable area.

## Screenshot fallback

Use a screenshot only when structured canvas access is unavailable, the user
explicitly provides one, or a visual artifact is needed to disambiguate the edit.
Treat each screenshot as a fallback brief for one output image unless the user
says multiple screenshots belong to the same target. Keep screenshot-derived
outputs separate and still preserve the original image and annotations.

## Guardrails

- Never replace the original image unless the user explicitly asks for replacement.
- Never delete or move annotation shapes; they are the visible edit brief.
- Never put the revised image inside the original holder, because that can cover the old image and make the before/after comparison harder.
- Never auto-capture screenshots or scan all pages for edit intent.
- If the annotations contradict each other, generate the most literal combined interpretation and mention the ambiguity.
- If a supplied screenshot shows selected-state outlines or toolbar UI, treat them as context only, not as content to generate.
