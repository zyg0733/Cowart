import { createImageCoordinateMapper } from '../shared/cowart-image-coordinates.mjs'

export const OBJECT_EDIT_TOOL_ID = 'cowart-object-edit'
export const OBJECT_EDIT_TEST_IDS = {
  tool: 'object-edit.tool',
  overlay: 'object-edit.overlay',
  status: 'object-edit.status',
  loading: 'object-edit.loading',
  error: 'object-edit.error',
  accept: 'object-edit.accept',
  cancel: 'object-edit.cancel',
  retry: 'object-edit.retry',
  brushAdd: 'object-edit.brush-add',
  brushRemove: 'object-edit.brush-remove',
  brushSize: 'object-edit.brush-size',
  undo: 'object-edit.undo',
  redo: 'object-edit.redo',
  reset: 'object-edit.reset',
  previousCandidate: 'object-edit.previous-candidate',
  nextCandidate: 'object-edit.next-candidate',
  objectList: 'object-edit.object-list',
  lineage: 'object-edit.lineage',
  modify: 'object-edit.modify',
  replace: 'object-edit.replace',
  remove: 'object-edit.remove',
  variants: 'object-edit.variants'
}

export const OBJECT_EDIT_COPY = {
  ready: 'Click or drag on the selected image',
  idle: 'Select one filled image',
  unsupported_selection: 'Select exactly one filled image',
  source_not_local: 'Save and reload the image before object editing',
  missing_source_hash: 'Source hash is not ready yet',
  worker_unsupported: 'Object editing requires a browser with module Worker support',
  offscreen_canvas_unsupported: 'Object editing requires OffscreenCanvas',
  webgl2_unsupported: 'Object editing requires WebGL2',
  unsupported: 'Object editing is not supported in this browser',
  loading: 'Loading local segmenter',
  segmenting: 'Segmenting object locally',
  preview: 'Preview ready',
  confirmed: 'Segment confirmed',
  stale: 'Source image changed. Retry from the current image.',
  error: 'Object selection failed. Try again.',
  accept: 'Accept',
  cancel: 'Cancel',
  retry: 'Retry'
}

let fallbackSegmentCounter = 0

export function createSegmentId() {
  if (typeof crypto?.randomUUID === 'function') return `segment:${crypto.randomUUID()}`
  fallbackSegmentCounter += 1
  return `segment:${Date.now().toString(36)}-${fallbackSegmentCounter.toString(36)}`
}

export function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export function isLocalPageAssetUrl(src, baseUrl = globalThis.location?.href ?? 'http://127.0.0.1/') {
  if (typeof src !== 'string' || src.length === 0) return false
  const url = new URL(src, baseUrl)
  const base = new URL(baseUrl)
  return url.origin === base.origin && url.pathname.startsWith('/page-assets/')
}

export function selectedImage(editor) {
  const [shapeId] = editor.getSelectedShapeIds()
  const shape = shapeId ? editor.getShape(shapeId) : null
  const asset = shape?.props?.assetId ? editor.getAsset(shape.props.assetId) : null
  return shape && asset ? { shape, asset } : null
}

export function buildObjectEditSource(editor) {
  const picked = selectedImage(editor)
  const width = Number(picked?.asset?.props?.w)
  const height = Number(picked?.asset?.props?.h)
  const assetSha256 = picked?.asset?.meta?.cowartSha256
  if (!picked || typeof assetSha256 !== 'string' || !(width > 0 && height > 0)) return null
  return {
    pageId: editor.getCurrentPageId(),
    shapeId: picked.shape.id,
    assetId: picked.asset.id,
    assetSha256,
    width,
    height
  }
}

export function getObjectEditToolState(editor, toolId = editor.getCurrentToolId()) {
  const selected = editor.getSelectedShapeIds()
  if (selected.length === 0) return { kind: 'idle' }
  if (selected.length !== 1) return { kind: 'unsupported_selection' }
  const shape = editor.getShape(selected[0])
  if (shape?.type !== 'image' || !shape.props?.assetId) return { kind: 'unsupported_selection' }
  const asset = editor.getAsset(shape.props.assetId)
  if (!asset?.props?.src || !isLocalPageAssetUrl(asset.props.src)) return { kind: 'source_not_local' }
  if (typeof asset.meta?.cowartSha256 !== 'string') return { kind: 'missing_source_hash' }
  return { kind: toolId === OBJECT_EDIT_TOOL_ID ? 'ready' : 'available' }
}

export function ancestorsForShape(editor, shape) {
  const ancestors = []
  let parentId = shape.parentId
  for (let guard = 0; guard < 64; guard += 1) {
    const parent = parentId ? editor.getShape(parentId) : null
    if (!parent) break
    ancestors.push(parent)
    parentId = parent.parentId
  }
  return ancestors
}

export function mapperFor(editor, source) {
  const picked = selectedImage(editor)
  if (!picked || !source) return null
  return createImageCoordinateMapper({
    source,
    shape: picked.shape,
    ancestors: ancestorsForShape(editor, picked.shape)
  })
}

export function currentSourceMatches(editor, source) {
  const current = buildObjectEditSource(editor)
  return Boolean(
    current &&
    source &&
    current.shapeId === source.shapeId &&
    current.assetId === source.assetId &&
    current.assetSha256 === source.assetSha256
  )
}

export function workerSupport() {
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function') {
    return { ok: false, message: OBJECT_EDIT_COPY.unsupported }
  }
  const canvas = new OffscreenCanvas(1, 1)
  return canvas.getContext('webgl2') ? { ok: true } : { ok: false, message: OBJECT_EDIT_COPY.unsupported }
}

export async function fetchLocalImageBytes(src, signal) {
  if (!isLocalPageAssetUrl(src)) throw new Error(OBJECT_EDIT_COPY.source_not_local)
  const response = await fetch(src, { signal })
  if (!response.ok) throw new Error(`Failed to fetch local source image: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

export async function decodeSelectionMask(maskPng, width, height) {
  const bitmap = await createImageBitmap(new Blob([maskPng], { type: 'image/png' }))
  try {
    if (bitmap.width !== width || bitmap.height !== height) throw new Error('Segment mask dimensions changed.')
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(bitmap, 0, 0)
    const rgba = context.getImageData(0, 0, width, height).data
    const pixels = new Uint8Array(width * height)
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = rgba[index * 4]
    return pixels
  } finally {
    bitmap.close?.()
  }
}
