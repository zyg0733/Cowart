export const MEDIAPIPE_WASM_BASE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
export const INTERACTIVE_SEGMENTER_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite'
export const INTERACTIVE_SEGMENTER_MODEL_SHA256 = 'e24338a717c1b7ad8d159666677ef400babb7f33b8ad60c4d96db4ecf694cd25'

export class ObjectEditWorkerError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ObjectEditWorkerError'
    this.code = code
    this.details = details
  }
}

export function checkObjectEditWorkerSupport(env = globalThis) {
  if (typeof env.Worker !== 'function') {
    return { ok: false, code: 'worker_unsupported', message: 'Object editing requires a browser with module Worker support.' }
  }
  if (typeof env.OffscreenCanvas !== 'function') {
    return { ok: false, code: 'offscreen_canvas_unsupported', message: 'Object editing requires OffscreenCanvas in a Worker-capable browser.' }
  }
  const canvas = new env.OffscreenCanvas(1, 1)
  const gl = canvas.getContext('webgl2')
  if (!gl) {
    return { ok: false, code: 'webgl2_unsupported', message: 'Object editing requires WebGL2 for local segmentation.' }
  }
  gl.getExtension?.('WEBGL_lose_context')?.loseContext?.()
  return { ok: true }
}

export async function assertModelChecksum(bytes, expectedSha256 = INTERACTIVE_SEGMENTER_MODEL_SHA256) {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (!globalThis.crypto?.subtle) {
    throw new ObjectEditWorkerError('checksum_unavailable', 'Model checksum verification requires Web Crypto.')
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer)
  const actual = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
  if (actual !== expectedSha256) {
    throw new ObjectEditWorkerError(
      'model_checksum_mismatch',
      `Interactive Segmenter model checksum mismatch: expected ${expectedSha256}, got ${actual}.`
    )
  }
  return actual
}
