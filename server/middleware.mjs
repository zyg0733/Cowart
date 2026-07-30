import { createSegmentStore } from '../shared/cowart-segment-store.mjs'
import { serveCanvasAsset } from './asset-localization.mjs'
import {
  bumpCanvasRevision,
  loadCanvasRevision,
  loadCanvasSnapshot,
  readJsonFile,
  saveCanvasSnapshot,
  withCanvasWriteLock,
  writeJsonAtomic
} from './canvas-store.mjs'
import { canvasPagesDir, selectionFile, viewStateFile } from './config.mjs'
import { isSelectionState, isSnapshot, isViewState, readRequestBody, sendError, sendJson } from './http.mjs'
import { broadcastCanvasChanged, broadcastSegmentChanged, hasCanvasEventClients, registerCanvasEventsRoute, requestCanvasExport, resolveCanvasExport } from './sse.mjs'
import { createSegmentRouteHandler, validateRecordConditions } from './source-segment-routes.mjs'
import { createSidecarProxyHandler } from './sidecar-proxy-routes.mjs'

const segmentStore = createSegmentStore({ pagesDir: canvasPagesDir })
const handleSegmentRoute = createSegmentRouteHandler({
  segmentStore,
  loadCanvasSnapshot,
  withCanvasWriteLock,
  broadcastSegmentChanged
})
const handleSidecarProxy = createSidecarProxyHandler({ loadCanvasSnapshot })

export function registerCowartMiddlewares(middlewares) {
  middlewares.use(serveCanvasAsset)
  registerCanvasEventsRoute(middlewares)

  middlewares.use('/api/selection', async (req, res) => {
    try {
      if (req.method === 'GET') {
        try {
          sendJson(res, 200, {
            selection: await readJsonFile(selectionFile),
            path: selectionFile
          })
        } catch (error) {
          if (error.code === 'ENOENT') {
            sendJson(res, 200, {
              selection: { selectedShapes: [], updatedAt: null },
              path: selectionFile
            })
            return
          }
          throw error
        }
        return
      }

      if (req.method === 'PUT') {
        const body = await readRequestBody(req)
        const selection = JSON.parse(body)
        if (!isSelectionState(selection)) {
          sendJson(res, 400, { error: 'Expected a Cowart selection state.' })
          return
        }

        await writeJsonAtomic(selectionFile, selection)
        sendJson(res, 200, { ok: true, path: selectionFile })
        return
      }

      res.statusCode = 405
      res.setHeader('allow', 'GET, PUT')
      res.end()
    } catch (error) {
      sendJson(res, 500, { error: error.message })
    }
  })

  middlewares.use('/api/view-state', async (req, res) => {
    try {
      if (req.method === 'GET') {
        try {
          sendJson(res, 200, {
            viewState: await readJsonFile(viewStateFile),
            path: viewStateFile
          })
        } catch (error) {
          if (error.code === 'ENOENT') {
            sendJson(res, 200, {
              viewState: {
                version: 1,
                currentPageId: null,
                camera: { x: 0, y: 0, z: 1 },
                updatedAt: null
              },
              path: viewStateFile
            })
            return
          }
          throw error
        }
        return
      }

      if (req.method === 'PUT') {
        const body = await readRequestBody(req)
        const viewState = JSON.parse(body)
        if (!isViewState(viewState)) {
          sendJson(res, 400, { error: 'Expected a Cowart view state.' })
          return
        }

        await writeJsonAtomic(viewStateFile, viewState)
        sendJson(res, 200, { ok: true, path: viewStateFile })
        return
      }

      res.statusCode = 405
      res.setHeader('allow', 'GET, PUT')
      res.end()
    } catch (error) {
      sendJson(res, 500, { error: error.message })
    }
  })

  middlewares.use('/api/canvas/export-result', async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const payload = JSON.parse(await readRequestBody(req))
      resolveCanvasExport(payload)
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendJson(res, 500, { error: error.message })
    }
  })

  middlewares.use('/api/canvas/export', async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const request = JSON.parse(await readRequestBody(req))
      if (!hasCanvasEventClients()) {
        sendJson(res, 503, { error: 'No Cowart browser is connected to render the export. Open the canvas in a browser.' })
        return
      }
      const result = await requestCanvasExport(request)
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(res, 504, { error: error.message })
    }
  })

  middlewares.use('/api/canvas/segments', handleSegmentRoute)
  middlewares.use('/api/canvas/sidecar/segment', handleSidecarProxy)

  middlewares.use('/api/canvas/records', async (req, res) => {
    try {
      if (req.method !== 'PUT' && req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'PUT, POST')
        res.end()
        return
      }

      const body = await readRequestBody(req)
      const patch = JSON.parse(body)
      const putRecords = Array.isArray(patch?.put) ? patch.put.filter((record) => record?.id) : []
      const removeIds = Array.isArray(patch?.remove) ? patch.remove.filter((id) => typeof id === 'string') : []
      const conditions = Array.isArray(patch?.conditions) ? patch.conditions : []
      if (putRecords.length === 0 && removeIds.length === 0) {
        sendJson(res, 400, { error: 'Expected { put: [...records], remove: [...ids] }.' })
        return
      }

      const outcome = await withCanvasWriteLock(async () => {
        const loaded = await loadCanvasSnapshot()
        if (!isSnapshot(loaded.snapshot)) {
          return { status: 409, body: { error: 'No canvas to merge into yet. Save a snapshot first.' } }
        }
        const snapshot = loaded.snapshot
        const conditionFailure = await validateRecordConditions(snapshot, conditions)
        if (conditionFailure) {
          return { status: 409, body: conditionFailure }
        }
        for (const id of removeIds) delete snapshot.store[id]
        for (const record of putRecords) snapshot.store[record.id] = record

        const result = await saveCanvasSnapshot(snapshot)
        const revision = await bumpCanvasRevision()
        return {
          status: 200,
          body: { ok: true, revision, put: putRecords.length, remove: removeIds.length, ...result },
          broadcast: { ...result, revision }
        }
      })

      sendJson(res, outcome.status, outcome.body)
      if (outcome.broadcast) broadcastCanvasChanged(outcome.broadcast)
    } catch (error) {
      sendError(res, error)
    }
  })

  middlewares.use('/api/canvas', async (req, res) => {
    try {
      if (req.method === 'GET') {
        const result = await loadCanvasSnapshot()
        const revision = await loadCanvasRevision()
        sendJson(res, 200, { ...result, revision })
        return
      }

      if (req.method === 'PUT') {
        const body = await readRequestBody(req)
        const payload = JSON.parse(body)
        const snapshot = isSnapshot(payload) ? payload : payload?.snapshot
        const baseRevision = isSnapshot(payload) ? undefined : payload?.baseRevision
        if (!isSnapshot(snapshot)) {
          sendJson(res, 400, { error: 'Expected a tldraw store snapshot.' })
          return
        }

        const outcome = await withCanvasWriteLock(async () => {
          const current = await loadCanvasRevision()
          if (baseRevision !== undefined && Number(baseRevision) !== current) {
            const loaded = await loadCanvasSnapshot()
            return {
              status: 409,
              body: {
                error: 'Canvas revision conflict.',
                revision: current,
                snapshot: loaded.snapshot,
                storage: loaded.storage
              }
            }
          }
          const result = await saveCanvasSnapshot(snapshot)
          const revision = await bumpCanvasRevision()
          return {
            status: 200,
            body: { ok: true, revision, ...result },
            broadcast: { ...result, revision }
          }
        })

        sendJson(res, outcome.status, outcome.body)
        if (outcome.broadcast) broadcastCanvasChanged(outcome.broadcast)
        return
      }

      res.statusCode = 405
      res.setHeader('allow', 'GET, PUT')
      res.end()
    } catch (error) {
      sendError(res, error)
    }
  })
}

export function canvasStoragePlugin() {
  return {
    name: 'cowart-canvas-storage',
    configureServer(server) {
      registerCowartMiddlewares(server.middlewares)
    },
    configurePreviewServer(server) {
      registerCowartMiddlewares(server.middlewares)
    }
  }
}
