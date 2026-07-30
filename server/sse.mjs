const canvasEventClients = new Set()
let canvasEventVersion = 0
const pendingExports = new Map()
let exportRequestCounter = 0

function sendCanvasEvent(res, payload) {
  res.write(`event: canvas-changed\n`)
  res.write(`id: ${payload.version}\n`)
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function broadcastExportRequested(payload) {
  for (const client of canvasEventClients) {
    if (client.destroyed) {
      canvasEventClients.delete(client)
      continue
    }
    try {
      client.write(`event: export-requested\n`)
      client.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      canvasEventClients.delete(client)
    }
  }
}

export function broadcastCanvasChanged(result) {
  const payload = {
    version: ++canvasEventVersion,
    revision: result.revision ?? null,
    updatedAt: new Date().toISOString(),
    storage: result.storage,
    paths: result.paths
  }

  for (const client of canvasEventClients) {
    if (client.destroyed) {
      canvasEventClients.delete(client)
      continue
    }

    try {
      sendCanvasEvent(client, payload)
    } catch {
      canvasEventClients.delete(client)
    }
  }
}

export function broadcastSegmentChanged(segment, action) {
  const payload = {
    version: ++canvasEventVersion,
    action,
    segmentId: segment.segmentId,
    parentSegmentId: segment.parentSegmentId ?? null,
    source: segment.source,
    updatedAt: new Date().toISOString()
  }
  for (const client of canvasEventClients) {
    if (client.destroyed) {
      canvasEventClients.delete(client)
      continue
    }
    try {
      client.write(`event: segment-changed\n`)
      client.write(`id: ${payload.version}\n`)
      client.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      canvasEventClients.delete(client)
    }
  }
}

export function hasCanvasEventClients() {
  return canvasEventClients.size > 0
}

export function resolveCanvasExport(payload) {
  const pending = payload?.requestId ? pendingExports.get(payload.requestId) : null
  if (!pending) return
  pendingExports.delete(payload.requestId)
  clearTimeout(pending.timer)
  if (payload.error) {
    pending.reject(new Error(String(payload.error)))
    return
  }
  pending.resolve({ base64: payload.base64, width: payload.width, height: payload.height, format: payload.format })
}

export function requestCanvasExport(request) {
  const requestId = `${process.pid}-${++exportRequestCounter}-${Date.now()}`
  const timeoutMs = Number.isFinite(request?.timeoutMs) ? request.timeoutMs : 20000
  return new Promise((resolveExport, rejectExport) => {
    const timer = setTimeout(() => {
      pendingExports.delete(requestId)
      rejectExport(new Error('Timed out waiting for the Cowart browser to render the export.'))
    }, timeoutMs)
    pendingExports.set(requestId, { resolve: resolveExport, reject: rejectExport, timer })
    broadcastExportRequested({ requestId, ...request })
  })
}

export function registerCanvasEventsRoute(middlewares) {
  middlewares.use('/api/canvas-events', (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }

    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache, no-transform')
    res.setHeader('connection', 'keep-alive')
    res.setHeader('x-accel-buffering', 'no')
    res.write(`: connected\n\n`)

    canvasEventClients.add(res)
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat ${Date.now()}\n\n`)
    }, 25000)

    req.on('close', () => {
      clearInterval(heartbeat)
      canvasEventClients.delete(res)
    })
  })
}
