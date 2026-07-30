---
name: cowart-image-gen
description: Generate final AI bitmaps for Cowart, including queued AI 图片 holder requests. Use when the user asks Codex to process Cowart generation requests, fill a selected holder, replace a holder image, or place a standalone generated image on the current canvas page.
---

# Cowart Image Gen

Use this skill when the user wants AI-generated imagery placed onto the Cowart
canvas. The primary agent-native path is the current-page holder queue:
`get_cowart_requests` returns requested `cowart-ai-image` holders, Codex claims
one request, generates, and fills that same request. A selected holder or
standalone insertion is still supported for direct one-off requests.

## Preconditions

The Cowart service should be running for the user's active project, usually at:

```text
http://127.0.0.1:43217
```

Current holders are custom `cowart-ai-image` shapes that **own their image** via
`props.assetId` and track `props.status` (`empty` / `requested` / `generating` /
`failed` / `filled`), `props.prompt`, and request metadata:

```json
{
  "type": "cowart-ai-image",
  "props": { "status": "requested", "prompt": "..." },
  "meta": {
    "cowartAiImageHolder": true,
    "cowartRequest": {
      "id": "cowart-request-...",
      "requestedAt": "2026-07-11T00:00:00.000Z",
      "attempt": 1
    }
  }
}
```

To **fill** a current `cowart-ai-image` holder, use `replace_cowart_image` with
the holder id. It sets the holder's own `assetId`, archives
`meta.cowartRequest` to `meta.cowartLastRequest`, and marks it `filled`. Do not
add a child image or use `insert_cowart_image` `fillAnchor` on a current holder.

Older canvases may still contain legacy `frame` or `geo` rectangle holders with the
same `meta.cowartAiImageHolder` flag — those are filled the legacy way (a child image
via `insert_cowart_image` with `fillAnchor` enabled). Support all of them.

There is no background generation daemon. Process requests only when invoked, one
at a time, and leave the canvas as the source of truth.

## Workflow

1. Look for queued current-page requests.

   Call `get_cowart_requests` with no `allPages` flag. It defaults to the current
   page and `requested` status, sorted FIFO by request time and stable canvas
   order:

   ```json
   {}
   ```

   Each item contains `holderId`, `requestId`, `request`, `prompt`,
   `suggestedGenSize`, `legacy`, and status fields. Process the returned list
   sequentially. Do not claim multiple holders in parallel.

2. Claim the next requested holder.

   For a current holder with a non-null `requestId`, claim it atomically before
   generating:

   ```json
   {
     "holderId": "<holderId>",
     "status": "generating",
     "expectedRequestId": "<requestId>"
   }
   ```

   This is the canonical claim shape:
   `update_cowart_holder({ status: "generating", expectedRequestId })`. If it
   fails with a request mismatch or status precondition error, treat the request
   as cancelled/stale/already claimed, skip generation for that item, and read
   `get_cowart_requests` again before continuing.

   Legacy requested holders have `legacy: true` and `requestId: null`. They are
   claimable only without `expectedRequestId`; do not invent an expected id for
   them. Their next retry will create correlated request metadata.

3. Branch scene-decomposition requests.

   When `request.kind` is `scene_decomposition`, do not use the one-image holder
   flow below. The request already contains a user-confirmed upload record.
   Claim it with the same `expectedRequestId`, then call
   `get_cowart_references({ decompositionId, returnBase64: true })`.

   Build a compact scene graph whose objects record name, front/back ordering,
   relations, visible fraction, and the matching confirmed `segmentId`. By
   default make exactly two `image_gen` calls:

   - `depth_hint`: a relative grayscale depth-order reference. It is inferred,
     not metric depth and not a mask.
   - `clean_plate`: the source-sized background with the selected foreground
     objects plausibly removed. It is synthetic, not recovered source content.

   Insert each generated bitmap at the source natural aspect ratio and register
   it with `publish_cowart_decomposition_artifact`. Include the scene graph on
   either publish call. Use provider provenance `codex-image_gen`; never claim a
   fixed GPT Image version when the Codex platform does not expose it.

   A `visible_object_layer` must come from `extract_cowart_object`, not image
   generation. A `completed_object` is an explicit per-object request: generate
   the complete object, insert it, run SAM 2 segmentation on that generated
   image with `segment_cowart_image({ publish: true })`, extract that generated
   segment, then publish the transparent result with `generatedSegmentId`.
   Do not create these extra cloud calls automatically.

4. Resolve prompt, size, and references.

   Use the queue item prompt first, then the holder's `props.prompt` from
   `get_cowart_canvas` / `get_cowart_selection` if needed. Use
   `suggestedGenSize` from `get_cowart_requests` or `get_cowart_canvas`; it is
   already a valid gpt-image size for the drawn box.

   Resolve holder references with `get_cowart_references` and `returnBase64:
   true`. Pass items tagged `role: "reference"` as content/composition
   `input_image` references and the item tagged `role: "style"` as the style
   reference when the image model supports style matching.

5. Generate the bitmap.

   Use the built-in `imagegen` skill unless the user explicitly requests another
   image path. Include requested visible copy, labels, poster text, UI text, or
   typography directly in the generation prompt unless the user asks for local
   deterministic text overlay or vector output.

   Preferred handoff is base64 from `image_generation_call.result`; pass it
   directly to Cowart as `imageBase64` or `imageDataUrl`. Only resolve a local
   file when the image tool actually returns one for this generation.

6. Fill the claimed holder.

   For a current `cowart-ai-image` holder, call `replace_cowart_image` with the
   same request id used for the claim:

   ```json
   {
     "targetShapeId": "<holderId>",
     "imageBase64": "<image_generation_call.result>",
     "expectedRequestId": "<requestId>",
     "genParams": {
       "prompt": "<final prompt>",
       "references": ["<shape ids>"],
       "size": "<suggestedGenSize>",
       "model": "<model>",
       "seed": "<seed when available>"
     }
   }
   ```

   If `replace_cowart_image({ expectedRequestId })` returns a mismatch, the user
   cancelled, retried, or another agent changed the holder. Do not retry the fill
   with no expected id. Discard that generated result or insert it elsewhere only
   if the user explicitly asks.

7. Mark failed requests explicitly.

   If generation fails after a successful claim, call:

   ```json
   {
     "holderId": "<holderId>",
     "status": "failed",
     "expectedRequestId": "<requestId>",
     "error": "<short recoverable reason>"
   }
   ```

   Keep the message short and actionable. The server redacts and caps it. If the
   failure update mismatches, another action already superseded the request; do
   not overwrite it.

8. Direct selected-holder and standalone workflows.

   If the user directly asks to fill the selected holder and no queue item is
   pending, read `get_cowart_selection` and `get_cowart_canvas`. For current
   holders, first create/refresh the active request with `update_cowart_holder`
   `status: "requested"` when needed, then follow the claim/fill flow above. For
   legacy frame/geo holders, generate and use `insert_cowart_image` with
   `fillAnchor` enabled.

   If no AI holder is selected and no queue item exists, generate the image and
   insert it as a normal image on the current page with `insert_cowart_image`.
   Use a selected non-holder as an anchor if it is useful context; otherwise place
   the image in a clear current-page area.

9. Verify the result.

   Refresh or let the browser hot-reload, then confirm the holder id, final
   status, request archive, inserted asset path, and final dimensions. For a
   queue run, call `get_cowart_requests` again before moving to the next request.

## Notes

- To create a holder on demand (only when the user asks for one), prefer the Cowart MCP `create_cowart_image_holder` tool instead of hand-writing a `frame` record. It mirrors the UI's AI 图片 holder exactly and places it beside an anchor or in a clear area.
- If a current holder is cancelled or retried while you are generating, the stale `expectedRequestId` will protect the canvas. Respect that rejection.
- If the holder is a legacy rotated `geo` rectangle, preserve the same `rotation` on the image. For `frame` holders, the frame owns placement and the child image should stay unrotated inside it.
- Do not refuse generation solely because no `AI 图片` holder is selected. Generate the bitmap and insert it into the current Cowart page when that matches the user's request.
- Never overwrite an existing asset file without an explicit replace request; use a timestamped filename.
- Do not promise background, parallel, or automatic all-pages generation. Current-page sequential processing is the contract.
