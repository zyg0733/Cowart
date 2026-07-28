import { localAssetBytesFromUrl, sha256 } from './asset-localization.mjs'
import { pageAssetsRoute, segmentBodyLimitBytes } from './config.mjs'
import { isSnapshot, readRequestBody, sendError, sendJson } from './http.mjs'
import { pageDirName } from './page-snapshots.mjs'

function sourceFailure(code, message, details = {}) {
  return { ok: false, failure: { error: message, code, details } }
}

function shapePageOwnership(snapshot, shape, pageId) {
  if (typeof pageId !== 'string' || snapshot.store[pageId]?.typeName !== 'page') {
    return { ok: false, reason: 'page_not_found' }
  }

  const visited = new Set([shape.id])
  let parentId = shape.parentId
  const maxDepth = Object.keys(snapshot.store).length + 1
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (parentId === pageId) return { ok: true }
    const parent = snapshot.store[parentId]
    if (!parent) return { ok: false, reason: 'missing_ancestor' }
    if (parent.typeName === 'page') return { ok: false, reason: 'different_page' }
    if (parent.typeName !== 'shape') return { ok: false, reason: 'invalid_ancestor' }
    if (visited.has(parent.id)) return { ok: false, reason: 'cyclic_ancestor' }
    visited.add(parent.id)
    parentId = parent.parentId
  }
  return { ok: false, reason: 'ancestry_too_deep' }
}

function pageLocalAssetUrlForSource(src, pageId) {
  return typeof src === 'string' && src.startsWith(`${pageAssetsRoute}${pageDirName(pageId)}/`)
}

export async function validateCurrentSource(snapshot, source) {
  const shape = source.shapeId ? snapshot.store[source.shapeId] : null
  if (shape?.typeName !== 'shape') return sourceFailure('source_shape_not_found', 'Source shape was not found.', { shapeId: source.shapeId })
  const ownership = shapePageOwnership(snapshot, shape, source.pageId)
  if (!ownership.ok) {
    return sourceFailure('source_shape_page_mismatch', 'Source shape does not belong to the declared page.', {
      pageId: source.pageId,
      shapeId: source.shapeId,
      reason: ownership.reason
    })
  }
  if (shape.props?.assetId !== source.assetId) {
    return sourceFailure('source_asset_mismatch', 'Source shape no longer references the expected asset.', { expected: source.assetId, actual: shape.props?.assetId ?? null })
  }
  const asset = snapshot.store[source.assetId]
  if (asset?.typeName !== 'asset') return sourceFailure('source_asset_not_found', 'Source asset was not found.', { assetId: source.assetId })
  if (Number(asset.props?.w) !== Number(source.width) || Number(asset.props?.h) !== Number(source.height)) {
    return sourceFailure('source_dimensions_changed', 'Source asset natural dimensions changed.', {
      expected: { width: Number(source.width), height: Number(source.height) },
      actual: { width: Number(asset.props?.w), height: Number(asset.props?.h) }
    })
  }
  if (!pageLocalAssetUrlForSource(asset.props?.src, source.pageId)) {
    return sourceFailure('source_asset_not_local', 'Source asset must be page-local before object segmentation.', { assetId: source.assetId, pageId: source.pageId })
  }
  const local = await localAssetBytesFromUrl(asset.props?.src ?? '')
  if (!local) return sourceFailure('source_asset_not_local', 'Source asset must be page-local before object segmentation.', { assetId: source.assetId })
  const currentSha256 = sha256(local.bytes)
  if (currentSha256 !== source.assetSha256) {
    return sourceFailure('source_asset_changed', 'Source asset bytes changed.', { expected: source.assetSha256, actual: currentSha256 })
  }
  return { ok: true, filePath: local.filePath, currentSha256, asset, shape }
}

async function validateSourceAssetCondition(snapshot, condition) {
  const source = condition.source ?? condition
  const pageId = typeof source.pageId === 'string' ? source.pageId : null
  const shapeId = typeof source.shapeId === 'string' ? source.shapeId : null
  const assetId = typeof source.assetId === 'string' ? source.assetId : null
  const expectedAssetSha256 = typeof source.expectedAssetSha256 === 'string' ? source.expectedAssetSha256 : source.assetSha256
  const expectedWidth = Number(source.width)
  const expectedHeight = Number(source.height)
  const validation = await validateCurrentSource(snapshot, { pageId, shapeId, assetId, assetSha256: expectedAssetSha256, width: expectedWidth, height: expectedHeight })
  return validation.ok ? null : validation.failure
}

function recordConditionValue(record, condition) {
  if (condition.field === 'meta.cowartRequest.id') return record?.meta?.cowartRequest?.id ?? null
  if (condition.field === 'meta.cowartDecomposition.revision') return record?.meta?.cowartDecomposition?.revision ?? null
  if (condition.field === 'props.status') return record?.props?.status ?? null
  return undefined
}

export async function validateRecordConditions(snapshot, conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return null
  for (const condition of conditions) {
    if (condition?.type === 'sourceAsset' || condition?.field === 'source.assetSha256') {
      const sourceFailure = await validateSourceAssetCondition(snapshot, condition)
      if (sourceFailure) return sourceFailure
      continue
    }
    const id = typeof condition?.id === 'string' ? condition.id : null
    const field = typeof condition?.field === 'string' ? condition.field : null
    if (!id || !field || !['meta.cowartRequest.id', 'meta.cowartDecomposition.revision', 'props.status'].includes(field)) {
      return { error: 'Unsupported canvas record precondition.' }
    }
    const actual = recordConditionValue(snapshot.store[id], condition)
    const expected = condition.equals ?? null
    if (actual !== expected) {
      return {
        error: 'Canvas record precondition failed.',
        id,
        field,
        expected,
        actual
      }
    }
  }
  return null
}

function referencedSegmentIds(snapshot) {
  const ids = new Set()
  for (const record of Object.values(snapshot.store ?? {})) {
    const objectEdit = record?.meta?.cowartObjectEdit
    if (typeof objectEdit?.segmentId === 'string') ids.add(objectEdit.segmentId)
    if (typeof objectEdit?.parentSegmentId === 'string') ids.add(objectEdit.parentSegmentId)
  }
  return [...ids]
}

function bodyBufferFromBase64(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    const error = new Error(`Expected ${field} base64 PNG bytes.`)
    error.code = 'invalid_request'
    error.status = 400
    throw error
  }
  return Buffer.from(value.replace(/^data:image\/png;base64,/i, ''), 'base64')
}

async function readSegmentJson(req) {
  return JSON.parse(await readRequestBody(req, segmentBodyLimitBytes))
}

function segmentIdFromPath(pathname) {
  const [encoded] = pathname.replace(/^\/+/, '').split('/')
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

export function createSegmentRouteHandler({ segmentStore, loadCanvasSnapshot, withCanvasWriteLock, broadcastSegmentChanged }) {
  return async function handleSegmentRoute(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean)
    try {
      if (req.method === 'GET' && parts.length === 0) {
        sendJson(res, 200, { segments: await segmentStore.list({ shapeId: url.searchParams.get('shapeId'), assetId: url.searchParams.get('assetId') }) })
        return
      }
      if (req.method === 'POST' && parts.length === 1 && parts[0] === 'confirm') {
        const body = await readSegmentJson(req)
        const source = body?.source ?? {}
        const outcome = await withCanvasWriteLock(async () => {
          const loaded = await loadCanvasSnapshot()
          if (!isSnapshot(loaded.snapshot)) return { status: 409, body: { error: 'No canvas to validate against.', code: 'canvas_missing' } }
          const validation = await validateCurrentSource(loaded.snapshot, source)
          if (!validation.ok) return { status: 409, body: validation.failure }
          const segment = await segmentStore.confirm({
            segmentId: body.segmentId,
            pageId: source.pageId,
            source,
            maskPng: bodyBufferFromBase64(body.maskBase64, 'maskBase64'),
            previewPng: bodyBufferFromBase64(body.previewBase64 ?? body.maskBase64, 'previewBase64'),
            selection: body.selection ?? null,
            provider: body.provider ?? null
          })
          return { status: 201, body: { ok: true, segment }, segment, action: 'confirm' }
        })
        sendJson(res, outcome.status, outcome.body)
        if (outcome.segment) broadcastSegmentChanged(outcome.segment, outcome.action)
        return
      }
      const segmentId = segmentIdFromPath(url.pathname)
      if (!segmentId || parts.length > 2) {
        sendJson(res, 400, { error: 'Invalid segment route.', code: 'invalid_segment_route' })
        return
      }
      if (req.method === 'GET' && parts.length === 1) {
        sendJson(res, 200, { segment: await segmentStore.get(segmentId) })
        return
      }
      if (req.method === 'GET' && parts[1] === 'mask') {
        const bytes = await segmentStore.binary(segmentId, 'mask.png')
        res.statusCode = 200
        res.setHeader('content-type', 'image/png')
        res.setHeader('content-length', String(bytes.length))
        res.end(bytes)
        return
      }
      if (req.method === 'GET' && parts[1] === 'preview') {
        const bytes = await segmentStore.binary(segmentId, 'preview.png')
        res.statusCode = 200
        res.setHeader('content-type', 'image/png')
        res.setHeader('content-length', String(bytes.length))
        res.end(bytes)
        return
      }
      if (req.method === 'POST' && parts[1] === 'refine') {
        const body = await readSegmentJson(req)
        const parent = await segmentStore.get(segmentId)
        const outcome = await withCanvasWriteLock(async () => {
          const loaded = await loadCanvasSnapshot()
          if (!isSnapshot(loaded.snapshot)) return { status: 409, body: { error: 'No canvas to validate against.', code: 'canvas_missing' } }
          const validation = await validateCurrentSource(loaded.snapshot, parent.source)
          if (!validation.ok) return { status: 409, body: validation.failure }
          const child = await segmentStore.refine(segmentId, {
            segmentId: body.segmentId,
            maskPng: bodyBufferFromBase64(body.maskBase64, 'maskBase64'),
            previewPng: bodyBufferFromBase64(body.previewBase64 ?? body.maskBase64, 'previewBase64'),
            selection: body.selection ?? null,
            provider: body.provider ?? parent.provider ?? null
          })
          return { status: 201, body: { ok: true, segment: child }, segment: child, action: 'refine' }
        })
        sendJson(res, outcome.status, outcome.body)
        if (outcome.segment) broadcastSegmentChanged(outcome.segment, outcome.action)
        return
      }
      if (req.method === 'DELETE' && parts.length === 1) {
        const outcome = await withCanvasWriteLock(async () => {
          const loaded = await loadCanvasSnapshot()
          const references = isSnapshot(loaded.snapshot) ? referencedSegmentIds(loaded.snapshot) : []
          const deleted = await segmentStore.delete(segmentId, references)
          return { status: 200, body: deleted, segment: { segmentId }, action: 'delete' }
        })
        sendJson(res, outcome.status, outcome.body)
        if (outcome.segment) broadcastSegmentChanged(outcome.segment, outcome.action)
        return
      }
      res.statusCode = 405
      res.setHeader('allow', 'GET, POST, DELETE')
      res.end()
    } catch (error) {
      sendError(res, error)
    }
  }
}
