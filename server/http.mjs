import { CowartPageAssetPathError } from '../shared/cowart-page-assets.mjs'
import { CowartSegmentMaskError } from '../shared/cowart-segment-mask.mjs'
import { CowartSegmentStoreError } from '../shared/cowart-segment-store.mjs'

export function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
}

export function readRequestBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let body = ''
    let byteLength = 0
    let tooLargeError = null
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (tooLargeError) return
      byteLength += Buffer.byteLength(chunk)
      if (byteLength > maxBytes) {
        tooLargeError = new Error('Request payload is too large.')
        tooLargeError.code = 'payload_too_large'
        tooLargeError.status = 413
        body = ''
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (tooLargeError) {
        rejectBody(tooLargeError)
        return
      }
      resolveBody(body)
    })
    req.on('error', rejectBody)
  })
}

export function isSnapshot(value) {
  return value && typeof value === 'object' && value.store && value.schema
}

export function isSelectionState(value) {
  return value && typeof value === 'object' && Array.isArray(value.selectedShapes)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isViewState(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.version === 1 &&
    (value.currentPageId === null || typeof value.currentPageId === 'string') &&
    value.camera &&
    typeof value.camera === 'object' &&
    isFiniteNumber(value.camera.x) &&
    isFiniteNumber(value.camera.y) &&
    isFiniteNumber(value.camera.z)
  )
}

export function sendError(res, error) {
  if (error instanceof CowartSegmentStoreError || error instanceof CowartSegmentMaskError) {
    sendJson(res, error.status ?? 400, { error: error.message, code: error.code, details: error.details ?? {} })
    return
  }
  if (error instanceof CowartPageAssetPathError) {
    sendJson(res, error.status ?? 400, { error: error.message, code: error.code, details: error.details ?? {} })
    return
  }
  if (error?.code === 'payload_too_large') {
    sendJson(res, error.status ?? 413, { error: error.message, code: error.code })
    return
  }
  if (error?.code === 'invalid_request') {
    sendJson(res, error.status ?? 400, { error: error.message, code: error.code })
    return
  }
  if (typeof error?.code === 'string' && Number.isInteger(error?.status)) {
    sendJson(res, error.status, { error: error.message, code: error.code, details: error.details ?? {} })
    return
  }
  if (error instanceof SyntaxError) {
    sendJson(res, 400, { error: 'Malformed JSON request body.', code: 'malformed_json' })
    return
  }
  sendJson(res, 500, { error: error.message })
}
