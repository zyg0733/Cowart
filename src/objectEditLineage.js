function eventTime(value) {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

export function buildObjectEditLineage(shapes, sourceShapeId) {
  if (!sourceShapeId) return []
  const events = [{ kind: 'source', id: `source:${sourceShapeId}`, label: 'Source', shapeId: sourceShapeId, at: null }]
  const grids = new Set()
  const winners = new Set()
  for (const shape of shapes) {
    const action = shape.meta?.cowartObjectAction
    const result = shape.meta?.cowartObjectEdit
    const group = shape.meta?.cowartVariantGroup
    if (action?.sourceShapeId === sourceShapeId) {
      events.push({
        kind: 'object_action',
        id: `action:${shape.id}`,
        label: `${action.operation || 'edit'} · ${shape.props?.status || 'queued'}`,
        shapeId: shape.id,
        at: shape.meta?.cowartRequest?.requestedAt ?? action.requestedAt ?? null
      })
    } else if (result?.sourceShapeId === sourceShapeId) {
      events.push({
        kind: 'object_result',
        id: `result:${shape.id}`,
        label: result.operation === 'extract' ? 'Extracted layer' : `${result.operation || 'edit'} result`,
        shapeId: shape.id,
        at: result.timestamp ?? null
      })
    }
    if (group?.sourceShapeId === sourceShapeId && !grids.has(group.id)) {
      grids.add(group.id)
      events.push({
        kind: 'variant_grid',
        id: `grid:${group.id}`,
        label: `${group.count || 0} variants`,
        gridId: group.id,
        at: group.createdAt ?? null
      })
    }
    if (group?.sourceShapeId === sourceShapeId && group.winnerHolderId && !winners.has(group.id)) {
      winners.add(group.id)
      events.push({
        kind: 'variant_winner',
        id: `winner:${group.id}`,
        label: 'Winner selected',
        shapeId: group.winnerHolderId,
        at: group.selectedAt ?? null
      })
    }
  }
  return events.sort((left, right) => {
    if (left.kind === 'source') return -1
    if (right.kind === 'source') return 1
    return eventTime(left.at) - eventTime(right.at) || left.id.localeCompare(right.id)
  })
}
