import { CANVAS_ENDPOINT, VIEW_STATE_ENDPOINT } from './cowartEndpoints.js'
import { diffRemoteSnapshot, isCanvasSnapshot } from '../canvasSync.js'

export function applyRemoteCanvasSnapshot(editor, snapshot, { preserveLocalChanges = false } = {}) {
  if (!isCanvasSnapshot(snapshot)) return { changed: 0, addedShapeIds: [] }

  const migratedSnapshot = editor.store.migrateSnapshot(snapshot)
  const { recordsToPut, idsToRemove, switchToPageId } = diffRemoteSnapshot(
    editor.store.getStoreSnapshot().store,
    migratedSnapshot.store,
    { preserveLocalChanges, currentPageId: editor.getCurrentPageId() }
  )

  if (recordsToPut.length === 0 && idsToRemove.length === 0) return { changed: 0, addedShapeIds: [] }

  const addedShapeIds = recordsToPut
    .filter((record) => record.typeName === 'shape' && !editor.store.get(record.id))
    .map((record) => record.id)

  if (recordsToPut.length > 0) {
    editor.store.mergeRemoteChanges(() => {
      editor.store.put(recordsToPut)
    })
  }

  if (idsToRemove.length > 0) {
    if (switchToPageId) editor.setCurrentPage(switchToPageId)
    editor.store.mergeRemoteChanges(() => {
      editor.store.remove(idsToRemove)
    })
  }

  return { changed: recordsToPut.length + idsToRemove.length, addedShapeIds }
}

export async function loadInitialCanvas(controller) {
  const [canvasResponse, viewStateResponse] = await Promise.all([
    fetch(CANVAS_ENDPOINT, { signal: controller.signal }),
    fetch(VIEW_STATE_ENDPOINT, { signal: controller.signal })
  ])
  if (!canvasResponse.ok) throw new Error(`Failed to load canvas: ${canvasResponse.status}`)
  if (!viewStateResponse.ok) throw new Error(`Failed to load canvas view state: ${viewStateResponse.status}`)

  const [canvasData, viewStateData] = await Promise.all([
    canvasResponse.json(),
    viewStateResponse.json()
  ])
  return { canvasData, viewStateData }
}
