import { EXPORT_RESULT_ENDPOINT } from './cowartEndpoints.js'

function resolveExportShapeIds(editor, request) {
  if (request.mode === 'shapes' && Array.isArray(request.shapeIds)) return request.shapeIds
  if (request.mode === 'selection') return editor.getSelectedShapeIds()
  if (request.mode === 'page' && request.pageId) return [...editor.getPageShapeIds(request.pageId)]
  return [...editor.getCurrentPageShapeIds()]
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read export blob.'))
    reader.readAsDataURL(blob)
  })
}

function postExportResult(payload) {
  return fetch(EXPORT_RESULT_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch((error) => console.error(error))
}

export async function handleCowartExportRequest(editor, event) {
  let request = null
  try {
    request = JSON.parse(event.data)
  } catch {
    return
  }
  if (!request?.requestId) return

  try {
    const shapeIds = resolveExportShapeIds(editor, request)
    if (!shapeIds || shapeIds.length === 0) {
      throw new Error('Nothing to export for the requested target.')
    }
    const format = ['png', 'jpeg', 'svg', 'webp'].includes(request.format) ? request.format : 'png'
    const options = { format }
    if (Number.isFinite(request.scale)) options.scale = request.scale
    if (Number.isFinite(request.padding)) options.padding = request.padding
    if (typeof request.background === 'boolean') options.background = request.background

    const image = await editor.toImage(shapeIds, options)
    const base64 = await blobToBase64(image.blob)
    await postExportResult({ requestId: request.requestId, base64, width: image.width, height: image.height, format })
  } catch (error) {
    await postExportResult({ requestId: request.requestId, error: String(error?.message ?? error) })
  }
}
