export {
  INTERACTIVE_SEGMENTER_MODEL_SHA256,
  INTERACTIVE_SEGMENTER_MODEL_URL,
  MEDIAPIPE_WASM_BASE_URL,
  ObjectEditWorkerError,
  assertModelChecksum,
  checkObjectEditWorkerSupport
} from './objectEditWorkerConfig.js'
export {
  encodeGrayscalePng,
  normalizeObjectEditRoi,
  selectForegroundMaskBytes,
  summarizeMask,
  validateMaskDimensions
} from './objectEditWorkerMask.js'
export { installObjectEditWorker, resetSegmenter, segmentImage } from './objectEditWorkerRuntime.js'

import { installObjectEditWorker } from './objectEditWorkerRuntime.js'

installObjectEditWorker()
