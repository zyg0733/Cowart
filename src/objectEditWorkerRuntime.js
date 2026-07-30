import { FilesetResolver, InteractiveSegmenter } from '@mediapipe/tasks-vision'
import {
  INTERACTIVE_SEGMENTER_MODEL_SHA256,
  INTERACTIVE_SEGMENTER_MODEL_URL,
  MEDIAPIPE_WASM_BASE_URL,
  assertModelChecksum,
  checkObjectEditWorkerSupport
} from './objectEditWorkerConfig.js'
import {
  encodeGrayscalePng,
  normalizeObjectEditRoi,
  selectForegroundMaskBytes,
  summarizeMask
} from './objectEditWorkerMask.js'

let segmenterPromise = null
let segmenter = null
let segmenterChecksum = null
let workQueue = Promise.resolve()

export function resetSegmenter() {
  segmenter?.close?.()
  segmenter = null
  segmenterPromise = null
  segmenterChecksum = null
}

async function getSegmenter() {
  if (segmenter && segmenterChecksum === INTERACTIVE_SEGMENTER_MODEL_SHA256) return segmenter
  if (segmenter && segmenterChecksum !== INTERACTIVE_SEGMENTER_MODEL_SHA256) resetSegmenter()
  segmenterPromise ??= (async () => {
    const support = checkObjectEditWorkerSupport({
      Worker: function Worker() {},
      OffscreenCanvas: globalThis.OffscreenCanvas
    })
    if (!support.ok) throw Object.assign(new Error(support.message), { code: support.code })
    const modelResponse = await fetch(INTERACTIVE_SEGMENTER_MODEL_URL)
    if (!modelResponse.ok) throw new Error(`Failed to download Interactive Segmenter model: ${modelResponse.status}`)
    const modelBytes = new Uint8Array(await modelResponse.arrayBuffer())
    segmenterChecksum = await assertModelChecksum(modelBytes)
    const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE_URL, true)
    const modelUrl = URL.createObjectURL(new Blob([modelBytes], { type: 'application/octet-stream' }))
    try {
      segmenter = await InteractiveSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
        canvas: new OffscreenCanvas(1, 1),
        outputCategoryMask: true,
        outputConfidenceMasks: false
      })
    } finally {
      URL.revokeObjectURL(modelUrl)
    }
    return segmenter
  })()
  return segmenterPromise
}

export async function segmentImage(message) {
  const task = await getSegmenter()
  const blob = new Blob([message.imageBytes], { type: message.mimeType || 'image/png' })
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    const roi = normalizeObjectEditRoi(message.selection)
    const result = task.segment(canvas, roi)
    const mask = selectForegroundMaskBytes(result, bitmap.width, bitmap.height, roi)
    const summary = summarizeMask(mask)
    if (summary.area === 0) throw new Error('Interactive Segmenter returned an empty mask.')
    return { ...summary, width: mask.width, height: mask.height, maskPixels: mask.pixels, maskPng: encodeGrayscalePng(mask) }
  } finally {
    bitmap.close?.()
  }
}

export function installObjectEditWorker(scope = globalThis.self) {
  if (typeof scope === 'undefined' || typeof scope.postMessage !== 'function') return
  scope.addEventListener('message', (event) => {
    const message = event.data
    if (message?.type === 'close') {
      workQueue = workQueue.finally(() => resetSegmenter())
      return
    }
    if (message?.type !== 'segment') return
    workQueue = workQueue.then(async () => {
      try {
        const result = await segmentImage(message)
        scope.postMessage(
          { type: 'segment-result', token: message.token, ...result },
          [result.maskPng.buffer, result.maskPixels.buffer]
        )
      } catch (error) {
        scope.postMessage({
          type: 'segment-error',
          token: message.token,
          code: error?.code ?? 'segment_failed',
          message: error instanceof Error ? error.message : String(error)
        })
      }
    })
  })
}
