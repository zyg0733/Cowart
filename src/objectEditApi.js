const SEGMENTS_ENDPOINT = '/api/canvas/segments'
const SIDECAR_ENDPOINT = '/api/canvas/sidecar/segment'

export class ObjectEditApiError extends Error {
  constructor(message, { status = 0, code = 'object_edit_api_error', details = {} } = {}) {
    super(message)
    this.name = 'ObjectEditApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function apiBase(baseUrl = '') {
  return baseUrl ? baseUrl.replace(/\/$/, '') : ''
}

function encodeSegmentId(segmentId) {
  if (typeof segmentId !== 'string' || segmentId.length === 0) {
    throw new ObjectEditApiError('Segment id is required.', { code: 'missing_segment_id' })
  }
  return encodeURIComponent(segmentId)
}

async function parseJsonResponse(response) {
  const text = await response.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch (error) {
      if (response.ok) throw error
      throw new ObjectEditApiError(
        response.statusText || `Object edit API failed with ${response.status}.`,
        {
          status: response.status,
          code: 'object_edit_api_error',
          details: { contentType: response.headers.get('content-type') ?? '', bodyPreview: text.slice(0, 200) }
        }
      )
    }
  }
  if (response.ok) return body
  throw new ObjectEditApiError(body?.error ?? `Object edit API failed with ${response.status}.`, {
    status: response.status,
    code: body?.code ?? 'object_edit_api_error',
    details: body?.details ?? {}
  })
}

async function requestJson(api, path, { method = 'GET', body } = {}) {
  const fetchImpl = api?.fetchImpl ?? fetch
  const response = await fetchImpl(`${apiBase(api?.baseUrl)}${path}`, {
    method,
    signal: api?.signal,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return parseJsonResponse(response)
}

async function requestBytes(api, path) {
  const fetchImpl = api?.fetchImpl ?? fetch
  const response = await fetchImpl(`${apiBase(api?.baseUrl)}${path}`, {
    method: 'GET',
    signal: api?.signal
  })
  if (!response.ok) await parseJsonResponse(response)
  return new Uint8Array(await response.arrayBuffer())
}

export async function confirmObjectSegment(api, payload) {
  return requestJson(api, `${SEGMENTS_ENDPOINT}/confirm`, { method: 'POST', body: payload })
}

export async function listObjectSegments(api, filters = {}) {
  const params = new URLSearchParams()
  if (filters.shapeId) params.set('shapeId', filters.shapeId)
  if (filters.assetId) params.set('assetId', filters.assetId)
  const suffix = params.size > 0 ? `?${params}` : ''
  return requestJson(api, `${SEGMENTS_ENDPOINT}${suffix}`)
}

export async function getObjectSegment(api, segmentId) {
  return requestJson(api, `${SEGMENTS_ENDPOINT}/${encodeSegmentId(segmentId)}`)
}

export async function fetchObjectSegmentMask(api, segmentId) {
  return requestBytes(api, `${SEGMENTS_ENDPOINT}/${encodeSegmentId(segmentId)}/mask`)
}

export async function fetchObjectSegmentPreview(api, segmentId) {
  return requestBytes(api, `${SEGMENTS_ENDPOINT}/${encodeSegmentId(segmentId)}/preview`)
}

export async function refineObjectSegment(api, segmentId, payload) {
  return requestJson(api, `${SEGMENTS_ENDPOINT}/${encodeSegmentId(segmentId)}/refine`, {
    method: 'POST',
    body: payload
  })
}

export async function deleteObjectSegment(api, segmentId) {
  return requestJson(api, `${SEGMENTS_ENDPOINT}/${encodeSegmentId(segmentId)}`, { method: 'DELETE' })
}

export async function segmentObjectWithSidecar(api, payload) {
  return requestJson(api, SIDECAR_ENDPOINT, { method: 'POST', body: payload })
}
