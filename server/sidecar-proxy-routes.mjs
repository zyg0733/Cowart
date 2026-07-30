import { readFile } from 'node:fs/promises'

import { callSegmentationSidecar } from '../mcp/sidecar-client.mjs'
import { segmentBodyLimitBytes } from './config.mjs'
import { isSnapshot, readRequestBody, sendError, sendJson } from './http.mjs'
import { validateCurrentSource } from './source-segment-routes.mjs'

export function createSidecarProxyHandler({ loadCanvasSnapshot }) {
  return async function handleSidecarProxy(req, res) {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    const controller = new AbortController()
    const cancel = () => controller.abort(new Error('Browser cancelled Sidecar segmentation.'))
    req.once('aborted', cancel)
    res.once('close', () => {
      if (!res.writableEnded) cancel()
    })
    try {
      const payload = JSON.parse(await readRequestBody(req, segmentBodyLimitBytes))
      const loaded = await loadCanvasSnapshot()
      if (!isSnapshot(loaded.snapshot)) {
        sendJson(res, 409, { error: 'No canvas to validate against.', code: 'canvas_missing' })
        return
      }
      const validation = await validateCurrentSource(loaded.snapshot, payload?.source ?? {})
      if (!validation.ok) {
        sendJson(res, 409, validation.failure)
        return
      }
      const source = {
        pageId: payload.source.pageId,
        shapeId: payload.source.shapeId,
        assetId: payload.source.assetId,
        assetSha256: validation.currentSha256,
        width: Number(payload.source.width),
        height: Number(payload.source.height)
      }
      const bytes = await readFile(validation.filePath)
      const sidecar = await callSegmentationSidecar({
        provider: 'sidecar',
        mode: payload.mode,
        points: payload.points,
        box: payload.box,
        prompt: payload.prompt,
        maxCandidates: payload.maxCandidates,
        returnBase64: true,
        signal: controller.signal
      }, bytes, source)
      if (!res.writableEnded) {
        sendJson(res, 200, {
          source,
          provider: sidecar.provider,
          candidates: sidecar.publicCandidates
        })
      }
    } catch (error) {
      if (!res.writableEnded) sendError(res, error)
    } finally {
      req.removeListener('aborted', cancel)
    }
  }
}
