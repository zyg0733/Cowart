import { SELECTION_ENDPOINT, VIEW_STATE_ENDPOINT } from './cowartEndpoints.js'
import {
  getCowartSelectionSnapshot,
  getCowartViewState,
  writeCowartSelectionState
} from './canvasState.js'

export function createSyncState(editor, setIsCanvasEmpty) {
  let lastSyncedSelectionState = ''
  let isSelectionStateSaving = false
  let hasPendingSelectionState = false
  let lastSyncedViewState = ''
  let isViewStateSaving = false
  let hasPendingViewState = false

  async function syncSelectionState() {
    setIsCanvasEmpty(editor.getCurrentPageShapeIds().size === 0)
    const selectionSnapshot = getCowartSelectionSnapshot(editor)
    writeCowartSelectionState(selectionSnapshot)

    const selectionState = JSON.stringify(selectionSnapshot)
    if (selectionState === lastSyncedSelectionState) return
    lastSyncedSelectionState = selectionState
    if (isSelectionStateSaving) {
      hasPendingSelectionState = true
      return
    }

    isSelectionStateSaving = true
    try {
      const response = await fetch(SELECTION_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...selectionSnapshot, updatedAt: new Date().toISOString() })
      })
      if (!response.ok) throw new Error(`Failed to save selection: ${response.status}`)
    } catch (error) {
      console.error(error)
    } finally {
      isSelectionStateSaving = false
      if (hasPendingSelectionState) {
        hasPendingSelectionState = false
        syncSelectionState()
      }
    }
  }

  async function syncViewState() {
    const viewStateSnapshot = { ...getCowartViewState(editor), updatedAt: new Date().toISOString() }
    const nextViewState = JSON.stringify(viewStateSnapshot)
    if (nextViewState === lastSyncedViewState) return
    lastSyncedViewState = nextViewState
    if (isViewStateSaving) {
      hasPendingViewState = true
      return
    }

    isViewStateSaving = true
    try {
      const response = await fetch(VIEW_STATE_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: nextViewState
      })
      if (!response.ok) throw new Error(`Failed to save view state: ${response.status}`)
    } catch (error) {
      console.error(error)
    } finally {
      isViewStateSaving = false
      if (hasPendingViewState) {
        hasPendingViewState = false
        syncViewState()
      }
    }
  }

  return { selection: syncSelectionState, view: syncViewState }
}
