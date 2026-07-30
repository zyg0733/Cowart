const HISTORY_LIMIT = 12

function copyPixels(pixels) {
  return new Uint8Array(pixels)
}

function samePixels(left, right) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function createMaskHistory({ width, height, pixels }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('Mask history requires positive integer dimensions.')
  }
  if (!(pixels instanceof Uint8Array) || pixels.length !== width * height) {
    throw new Error('Mask history pixels do not match its dimensions.')
  }
  const original = copyPixels(pixels)
  return { width, height, original, present: copyPixels(pixels), past: [], future: [] }
}

function paintDisk(pixels, width, height, x, y, radius, value) {
  const minX = Math.max(0, Math.floor(x - radius))
  const maxX = Math.min(width - 1, Math.ceil(x + radius))
  const minY = Math.max(0, Math.floor(y - radius))
  const maxY = Math.min(height - 1, Math.ceil(y + radius))
  const radiusSquared = radius * radius
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const dx = px + 0.5 - x
      const dy = py + 0.5 - y
      if (dx * dx + dy * dy <= radiusSquared) pixels[py * width + px] = value
    }
  }
}

function paintSegment(pixels, width, height, from, to, radius, value) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  const step = Math.max(1, radius / 2)
  const count = Math.max(1, Math.ceil(distance / step))
  for (let index = 0; index <= count; index += 1) {
    const ratio = index / count
    paintDisk(
      pixels,
      width,
      height,
      from.x + (to.x - from.x) * ratio,
      from.y + (to.y - from.y) * ratio,
      radius,
      value
    )
  }
}

export function applyMaskBrush(history, { mode, points, size }) {
  if (!history || !Array.isArray(points) || points.length === 0) return history
  if (mode !== 'add' && mode !== 'remove') throw new Error('Brush mode must be add or remove.')
  const radius = Math.max(0.5, Number(size) / 2)
  const next = copyPixels(history.present)
  const value = mode === 'add' ? 255 : 0
  if (points.length === 1) {
    paintDisk(next, history.width, history.height, points[0].x, points[0].y, radius, value)
  } else {
    for (let index = 1; index < points.length; index += 1) {
      paintSegment(next, history.width, history.height, points[index - 1], points[index], radius, value)
    }
  }
  if (samePixels(next, history.present)) return history
  return {
    ...history,
    present: next,
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    future: []
  }
}

export function undoMaskHistory(history) {
  if (!history || history.past.length === 0) return history
  const present = history.past.at(-1)
  return {
    ...history,
    present,
    past: history.past.slice(0, -1),
    future: [history.present, ...history.future].slice(0, HISTORY_LIMIT)
  }
}

export function redoMaskHistory(history) {
  if (!history || history.future.length === 0) return history
  const [present, ...future] = history.future
  return {
    ...history,
    present,
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    future
  }
}

export function resetMaskHistory(history) {
  if (!history || samePixels(history.present, history.original)) return history
  return {
    ...history,
    present: copyPixels(history.original),
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    future: []
  }
}
