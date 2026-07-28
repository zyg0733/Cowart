export const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const idempotentWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const projectDirProperty = { type: "string", description: "Absolute Cowart project directory containing canvas/." };
export const canvasDirProperty = { type: "string", description: "Absolute canvas directory. Overrides projectDir." };
export const cowartUrlProperty = { type: "string", description: "Running Cowart URL." };
export const pageIdLimitProperty = { type: "string", description: "Limit to a single page id. Defaults to the current view-state page." };
export const allPagesProperty = { type: "boolean", description: "Include every page instead of just the current one. Defaults to false." };

export const imageInputProperties = {
  imagePath: { type: "string", description: "Absolute local bitmap path to insert. Provide this or imageBase64/imageDataUrl." },
  imageBase64: { type: "string", description: "Base64-encoded image bytes (e.g. a Codex image_generation_call.result), instead of a file path." },
  imageDataUrl: { type: "string", description: "A data: URL (data:image/png;base64,...) instead of a file path." },
  mimeType: { type: "string", description: "MIME type for imageBase64 (default image/png); also used to pick the saved file extension." },
};

export const preserveOutsideProperty = {
  oneOf: [
    { type: "boolean" },
    {
      type: "object",
      properties: {
        segmentId: { type: "string" },
      },
      additionalProperties: false,
    },
  ],
  description: "Deterministically preserve decoded source RGBA pixels outside a confirmed Segment Store mask. true infers segmentId from objectEdit.segmentId.",
};

export const holderStatuses = ["empty", "requested", "generating", "failed", "filled"];

export function objectSchema(properties, extra = {}) {
  return {
    type: "object",
    properties,
    ...extra,
    additionalProperties: false,
  };
}
