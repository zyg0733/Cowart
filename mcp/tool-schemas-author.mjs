import { canvasDirProperty, cowartUrlProperty, idempotentWriteAnnotations, objectSchema, projectDirProperty, writeAnnotations } from "./tool-schema-common.mjs";

export const createHolderTool = {
  name: "create_cowart_image_holder",
  title: "Create Cowart Image Holder",
  description: "Create an AI 图片 holder (a custom cowart-ai-image shape that owns its image via props.assetId and tracks props.status/props.prompt) on the canvas, matching the holder the UI tool creates, placed beside an anchor or in a clear page area. Use to set up a slot before generating an image into it; fill it later with replace_cowart_image.",
  inputSchema: objectSchema({
    projectDir: projectDirProperty,
    canvasDir: canvasDirProperty,
    cowartUrl: cowartUrlProperty,
    pageId: { type: "string", description: "Target page id. Optional when an anchor or view-state page is available." },
    anchorShapeId: { type: "string", description: "Existing shape id to place the holder beside." },
    placement: { type: "string", enum: ["right", "left", "below"], description: "Placement direction from the anchor. Defaults to right." },
    margin: { type: "number", description: "Canvas units between the holder and nearby shapes. Defaults to 40." },
    width: { type: "number", description: "Holder width in canvas units. Defaults to 320." },
    height: { type: "number", description: "Holder height in canvas units. Defaults to 220." },
    name: { type: "string", description: "Holder label. Defaults to AI 图片." },
    prompt: { type: "string", description: "Optional prompt shown on the holder describing what to generate into it." },
    shapeMeta: { type: "object", description: "Additional tldraw shape metadata." },
    dryRun: { type: "boolean", description: "Calculate placement without saving." },
  }),
  annotations: writeAnnotations,
};

export const addShapesTool = {
  name: "add_cowart_shapes",
  title: "Add Cowart Shapes",
  description: "Create tldraw shapes on the canvas so the agent can author diagrams, labels, and layouts (flowcharts, callouts, sticky notes). Supported types: text, geo (rectangle/ellipse/diamond/etc.), note (sticky), line, arrow. An arrow with fromId/toId becomes a bound connector between those node shapes — it is auto-positioned to their centers and follows them when moved. Records are built and validated against the tldraw schema, so no browser is required.",
  inputSchema: objectSchema({
    projectDir: projectDirProperty,
    canvasDir: canvasDirProperty,
    cowartUrl: cowartUrlProperty,
    pageId: { type: "string", description: "Target page id. Defaults to the current view-state page." },
    parentId: { type: "string", description: "Default parent for all shapes (page or frame id). Defaults to the page." },
    shapes: {
      type: "array",
      description: "Shapes to create. Each item: { type, x, y, rotation?, parentId?, meta?, text?, color?, size?, font? } plus type-specific fields. geo: { geo, w, h, fill, dash, align, verticalAlign, labelColor }. text: { w, textAlign, autoSize }. note: sticky (fixed size). line: { points:[{x,y},...], spline, dash }. arrow: { start:{x,y}, end:{x,y}, bend, arrowheadStart, arrowheadEnd, kind } OR { fromId, toId } to bind the arrow between two existing node shapes (auto-positioned, follows on move). Coordinates are page-space; arrow/line start/end/points are relative to the shape's x,y. Unknown style values fall back to defaults.",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["text", "geo", "note", "line", "arrow"] },
          x: { type: "number" },
          y: { type: "number" },
          text: { type: "string" },
          color: { type: "string" },
          size: { type: "string", enum: ["s", "m", "l", "xl"] },
          geo: { type: "string" },
          w: { type: "number" },
          h: { type: "number" },
        },
        required: ["type"],
        additionalProperties: true,
      },
    },
    dryRun: { type: "boolean", description: "Build and return the records without saving." },
  }, { required: ["shapes"] }),
  annotations: writeAnnotations,
};

export const updateHolderTool = {
  name: "update_cowart_holder",
  title: "Update Cowart Image Holder",
  description: "Update a cowart-ai-image holder's status and/or prompt without changing its image. Set status to 'generating' before you start generating (the holder shows a spinner the user sees via live refresh), then fill it with replace_cowart_image (which marks it 'filled'). Also use to set/clear the holder's prompt.",
  inputSchema: objectSchema({
    projectDir: projectDirProperty,
    canvasDir: canvasDirProperty,
    cowartUrl: cowartUrlProperty,
    holderId: { type: "string", description: "The cowart-ai-image holder shape id. Falls back to targetShapeId/shapeId or the current selection." },
    targetShapeId: { type: "string", description: "Alias for holderId." },
    shapeId: { type: "string", description: "Alias for holderId." },
    status: { type: "string", enum: ["empty", "requested", "generating", "failed", "filled"], description: "New holder status." },
    prompt: { type: "string", description: "New prompt text shown on the holder (empty string clears it)." },
    requestId: { type: "string", description: "Optional id for a newly requested generation. Generated when omitted." },
    requestedAt: { type: "string", description: "Optional ISO timestamp for a newly requested generation. Defaults to now." },
    expectedRequestId: { type: "string", description: "Require the active meta.cowartRequest.id to match before claiming, failing, cancelling, or filling." },
    error: { type: "string", description: "Failure text when status is failed. Redacted and capped at 240 characters." },
    errorMessage: { type: "string", description: "Alias for error when status is failed." },
    references: { type: "array", items: { type: "string" }, description: "Shape ids of canvas images to use as input_image references for this holder's generation (stored in meta.cowartReferences)." },
    styleRef: { type: "string", description: "Shape id of a style-reference image (style_match); stored in meta.cowartStyleRef. Empty string clears it." },
    genParams: { type: "object", description: "Full generation call (prompt, refs, size, model, seed, …) to record for reproducibility (stored in meta.cowartGen)." },
    dryRun: { type: "boolean", description: "Resolve the update without saving." },
  }),
  annotations: idempotentWriteAnnotations,
};
