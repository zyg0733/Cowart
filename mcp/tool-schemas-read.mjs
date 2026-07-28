import {
  allPagesProperty,
  canvasDirProperty,
  cowartUrlProperty,
  holderStatuses,
  objectSchema,
  pageIdLimitProperty,
  projectDirProperty,
  readOnlyAnnotations,
} from "./tool-schema-common.mjs";

export const getSelectionTool = {
  name: "get_cowart_selection",
  title: "Get Cowart Selection",
  description: "Return the currently selected Cowart/tldraw shapes and image asset metadata from a project's canvas/cowart-selection.json state file.",
  inputSchema: objectSchema({
    projectDir: {
      type: "string",
      description: "Absolute Cowart project directory. The tool reads <projectDir>/canvas/cowart-selection.json.",
    },
    canvasDir: {
      type: "string",
      description: "Absolute canvas directory. If provided, this takes precedence over projectDir.",
    },
  }),
  annotations: readOnlyAnnotations,
};

export const getCanvasTool = {
  name: "get_cowart_canvas",
  title: "Get Cowart Canvas",
  description: "Return a structured summary of the Cowart canvas (current page by default) so the agent can reason about what is on the board: each shape's id, type, page-space bounds, text, asset, and whether it is an AI 图片 holder or an annotation.",
  inputSchema: objectSchema({
    projectDir: projectDirProperty,
    canvasDir: canvasDirProperty,
    cowartUrl: { type: "string", description: "Running Cowart URL, for example http://127.0.0.1:43217." },
    pageId: pageIdLimitProperty,
    allPages: allPagesProperty,
  }),
  annotations: readOnlyAnnotations,
};

export const getAnnotationsTool = {
  name: "get_cowart_annotations",
  title: "Get Cowart Annotations",
  description: "Return Cowart 批注 annotations as structured data: each annotation arrow's text label and the shape it points at (resolved from the arrow tip), so edit intent can be read without screenshotting the canvas.",
  inputSchema: objectSchema({
    projectDir: projectDirProperty,
    canvasDir: canvasDirProperty,
    cowartUrl: cowartUrlProperty,
    pageId: pageIdLimitProperty,
    allPages: { type: "boolean", description: "Include annotations on every page. Defaults to false." },
    targetShapeId: { type: "string", description: "Return only annotations whose resolved target is this shape id." },
    annotationIds: { type: "array", items: { type: "string" }, description: "Return only these annotation arrow shape ids." },
    selectedOnly: { type: "boolean", description: "Return selected annotation arrows and annotations whose resolved target is selected." },
  }),
  annotations: readOnlyAnnotations,
};

export const getRequestsTool = {
  name: "get_cowart_requests",
  title: "Get Cowart Requests",
  description: "List cowart-ai-image holder generation requests on the current page by default, sorted FIFO by request time and stable canvas order. Defaults to requested holders; pass statuses to include generating or failed.",
  inputSchema: objectSchema({
    projectDir: projectDirProperty,
    canvasDir: canvasDirProperty,
    cowartUrl: cowartUrlProperty,
    pageId: pageIdLimitProperty,
    allPages: { type: "boolean", description: "Include requests on every page. Defaults to false." },
    status: { type: "string", enum: holderStatuses, description: "Single holder status to list. Defaults to requested." },
    statuses: {
      type: "array",
      items: { type: "string", enum: holderStatuses },
      description: "Holder statuses to list. Defaults to [requested].",
    },
  }),
  annotations: readOnlyAnnotations,
};

export const getReferencesTool = {
  name: "get_cowart_references",
  title: "Get Cowart References",
  description: "Resolve holder references or a scene decomposition's source, confirmed segment masks, and existing artifacts into local files and optional base64 for Codex image generation.",
  inputSchema: objectSchema({
    projectDir: projectDirProperty,
    canvasDir: canvasDirProperty,
    cowartUrl: cowartUrlProperty,
    holderId: { type: "string", description: "Holder whose meta.cowartReferences / cowartStyleRef define the references." },
    decompositionId: { type: "string", description: "Resolve one scene decomposition source, confirmed segment masks, and existing artifacts." },
    decompositionRoles: { type: "array", items: { type: "string", enum: ["source", "segments", "artifacts"] }, description: "Subset of decomposition references to return. Defaults to all roles." },
    shapeIds: { type: "array", items: { type: "string" }, description: "Explicit reference image shape ids." },
    styleRef: { type: "string", description: "Explicit style-reference image shape id." },
    returnBase64: {
      type: "boolean",
      description: "Also return each reference's base64 bytes to feed image generation directly. Defaults to false.",
    },
  }),
  annotations: readOnlyAnnotations,
};
