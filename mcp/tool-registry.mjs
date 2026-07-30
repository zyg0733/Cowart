import { addShapesTool, createHolderTool, updateHolderTool } from "./tool-schemas-author.mjs";
import { exportViewTool, insertImageTool, replaceImageTool } from "./tool-schemas-image.mjs";
import { makeMaskTool, refineSegmentTool, segmentImageTool } from "./tool-schemas-object.mjs";
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
    updateHolderTool,
    getReferencesTool,
  ];
}
