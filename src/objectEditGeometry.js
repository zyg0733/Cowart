const PANEL_MARGIN = 8
const MOBILE_PANEL_LEFT = 12
const MOBILE_PANEL_TOP = 76
const MOBILE_MAX_WIDTH = 480
const DEFAULT_PANEL = { width: 268, height: 112 }

function cssMatrix(values) {
  return `matrix(${values.map((value) => Number(value.toFixed(6))).join(', ')})`
}

function screenFrame(editor, mapper) {
  const width = mapper.localSize.w
  const height = mapper.localSize.h
  const origin = editor.pageToScreen(mapper.localPointToPagePoint({ x: 0, y: 0 }))
  const xAxis = editor.pageToScreen(mapper.localPointToPagePoint({ x: width, y: 0 }))
  const yAxis = editor.pageToScreen(mapper.localPointToPagePoint({ x: 0, y: height }))
  const matrix = [
    (xAxis.x - origin.x) / width,
    (xAxis.y - origin.y) / width,
    (yAxis.x - origin.x) / height,
    (yAxis.y - origin.y) / height,
    origin.x,
    origin.y
  ]
  return { width, height, matrix, style: { width, height, transform: cssMatrix(matrix) } }
}

function naturalImageFrame(mapper, source) {
  const origin = mapper.naturalPointToLocalPoint({ x: 0, y: 0 })
  const xAxis = mapper.naturalPointToLocalPoint({ x: source.width, y: 0 })
  const yAxis = mapper.naturalPointToLocalPoint({ x: 0, y: source.height })
  const matrix = [
    (xAxis.x - origin.x) / source.width,
    (xAxis.y - origin.y) / source.width,
    (yAxis.x - origin.x) / source.height,
    (yAxis.y - origin.y) / source.height,
    origin.x,
    origin.y
  ]
  return {
    matrix,
    style: {
      width: `${source.width}px`,
      height: `${source.height}px`,
      transform: cssMatrix(matrix)
    }
  }
}

export function getPreviewLayout({ editor, mapper, source }) {
  const frame = screenFrame(editor, mapper)
  const image = naturalImageFrame(mapper, source)
  return {
    frameMatrix: frame.matrix,
    imageMatrix: image.matrix,
    frameStyle: frame.style,
    imageStyle: image.style
  }
}

function rectTop(rect) {
  return Number.isFinite(rect?.y) ? rect.y : Infinity
}

export function getObjectEditPanelDock({
  viewport,
  anchor,
  panel = DEFAULT_PANEL,
  avoidRects = [],
  margin = PANEL_MARGIN
}) {
  const panelWidth = Math.min(panel.width, viewport.width - margin * 2)
  const maxLeft = Math.max(margin, viewport.width - panelWidth - margin)
  const preferredLeft = viewport.width <= MOBILE_MAX_WIDTH ? MOBILE_PANEL_LEFT : anchor.x + 12
  const left = Math.min(maxLeft, Math.max(margin, preferredLeft))
  const avoidTop = Math.min(...avoidRects.map(rectTop), viewport.height)
  const maxTop = Math.max(MOBILE_PANEL_TOP, avoidTop - margin - panel.height)
  const preferredTop = viewport.width <= MOBILE_MAX_WIDTH ? Math.min(anchor.y, maxTop) : anchor.y
  return {
    left,
    top: Math.min(maxTop, Math.max(MOBILE_PANEL_TOP, preferredTop))
  }
}

export function getObjectEditAvoidRects() {
  const rects = []
  for (const element of document.querySelectorAll('.tlui-toolbar, .tlui-quick-actions, [aria-label="操作"], [aria-label="Actions"]')) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) rects.push(rect)
  }
  return rects
}

export function getObjectEditPanelAnchor(editor, picked) {
  const bounds = picked ? editor.getShapePageBounds(picked.shape) : null
  if (!bounds) return { x: 16, y: 76 }
  const point = editor.pageToScreen({ x: bounds.x + bounds.w, y: bounds.y })
  return { x: point.x, y: Math.max(76, point.y) }
}

export function createPreviewUrlStore(urls = URL) {
  let activeUrl = null
  return {
    replace(bytes, mimeType = 'image/png') {
      const nextUrl = urls.createObjectURL(new Blob([bytes], { type: mimeType }))
      if (activeUrl) urls.revokeObjectURL(activeUrl)
      activeUrl = nextUrl
      return nextUrl
    },
    clear() {
      if (!activeUrl) return
      urls.revokeObjectURL(activeUrl)
      activeUrl = null
    },
    current() {
      return activeUrl
    }
  }
}
