function isPointInsideImage(mapper, point) {
  const local = mapper.pagePointToLocalPoint(point)
  return local.x >= 0 && local.y >= 0 && local.x <= mapper.localSize.w && local.y <= mapper.localSize.h
}

export function normalizeObjectEditInput(detail, mapper, source) {
  if (detail.mode === 'scribble') {
    if (!isPointInsideImage(mapper, detail.points[0])) return null
    return {
      mode: 'scribble',
      points: detail.points.map((point) => {
        const natural = mapper.pagePointToNaturalPoint(point)
        return { x: natural.x / source.width, y: natural.y / source.height }
      })
    }
  }
  if (!isPointInsideImage(mapper, detail.point)) return null
  const point = mapper.pagePointToNaturalPoint(detail.point)
  return { mode: 'point', point: { x: point.x / source.width, y: point.y / source.height } }
}
