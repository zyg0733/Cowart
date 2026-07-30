import {
  addShapesTool,
  createDecompositionTool,
  createHolderTool,
  createVariantGridTool,
  publishDecompositionArtifactTool,
  selectVariantTool,
  updateHolderTool,
} from "./tool-schemas-author.mjs";
import { exportViewTool, insertImageTool, replaceImageTool } from "./tool-schemas-image.mjs";
import { extractObjectTool, makeMaskTool, refineSegmentTool, segmentImageTool } from "./tool-schemas-object.mjs";
import {
  getAnnotationsTool,
  getCanvasTool,
  getReferencesTool,
  getRequestsTool,
  getSelectionTool,
} from "./tool-schemas-read.mjs";

export function toolDefinitions() {
  return [
    getSelectionTool,
    insertImageTool,
    getCanvasTool,
    getAnnotationsTool,
    getRequestsTool,
    createHolderTool,
    replaceImageTool,
    exportViewTool,
    addShapesTool,
    makeMaskTool,
    segmentImageTool,
    refineSegmentTool,
    extractObjectTool,
    createVariantGridTool,
    selectVariantTool,
    createDecompositionTool,
    publishDecompositionArtifactTool,
    updateHolderTool,
    getReferencesTool,
  ];
}
