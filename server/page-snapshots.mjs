import { join } from 'node:path'
import { cowartPageDirName } from '../shared/cowart-page-assets.mjs'
import { canvasFileName, canvasPagesDir, pageAssetsRoute, pageIdPrefix } from './config.mjs'

export function pageDirName(pageId) {
  return cowartPageDirName(pageId, pageIdPrefix)
}

export function pageFilePath(pageId) {
  return join(canvasPagesDir, pageDirName(pageId), canvasFileName)
}

export function pageAssetsDir(pageId) {
  return join(canvasPagesDir, pageDirName(pageId), 'assets')
}

export function pageAssetUrl(pageId, fileName) {
  return `${pageAssetsRoute}${pageDirName(pageId)}/${encodeURIComponent(fileName)}`
}

export function getPageRecords(snapshot) {
  return Object.values(snapshot.store)
    .filter((record) => record?.typeName === 'page')
    .sort((a, b) => String(a.index ?? '').localeCompare(String(b.index ?? '')))
}

function getAssetIdsForShapes(shapes) {
  return new Set(
    shapes
      .map((shape) => shape?.props?.assetId)
      .filter((assetId) => typeof assetId === 'string')
  )
}

function getShapeRecordsForPage(snapshot, pageId) {
  const shapesByParent = new Map()
  for (const record of Object.values(snapshot.store)) {
    if (record?.typeName !== 'shape') continue
    const siblings = shapesByParent.get(record.parentId) ?? []
    siblings.push(record)
    shapesByParent.set(record.parentId, siblings)
  }

  const shapes = []
  const queue = [...(shapesByParent.get(pageId) ?? [])]
  while (queue.length > 0) {
    const shape = queue.shift()
    shapes.push(shape)
    queue.push(...(shapesByParent.get(shape.id) ?? []))
  }
  return shapes
}

function isBindingForShapes(record, shapeIds) {
  if (record?.typeName !== 'binding') return false
  const fromId = record.fromId ?? record.props?.fromId
  const toId = record.toId ?? record.props?.toId
  return shapeIds.has(fromId) || shapeIds.has(toId)
}

export function snapshotForPage(snapshot, page) {
  const pageId = page.id
  const pageShapes = getShapeRecordsForPage(snapshot, pageId)
  const shapeIds = new Set(pageShapes.map((shape) => shape.id))
  const assetIds = getAssetIdsForShapes(pageShapes)
  const store = {}

  for (const record of Object.values(snapshot.store)) {
    if (!record?.id) continue
    if (record.typeName === 'page') {
      if (record.id === pageId) store[record.id] = record
      continue
    }
    if (record.typeName === 'shape') {
      if (shapeIds.has(record.id)) store[record.id] = record
      continue
    }
    if (record.typeName === 'asset') {
      if (assetIds.has(record.id)) store[record.id] = record
      continue
    }
    if (record.typeName === 'binding') {
      if (isBindingForShapes(record, shapeIds)) store[record.id] = record
      continue
    }
    store[record.id] = record
  }

  return {
    schema: snapshot.schema,
    store
  }
}
