import {
  CANVAS_ENDPOINT,
  CANVAS_EVENTS_ENDPOINT,
  SELECTION_STATE_ELEMENT_ID
} from './cowartEndpoints.js'
import { handleCowartExportRequest } from './canvasExport.js'
import { applyRemoteCanvasSnapshot } from './canvasRemote.js'
import {
  getCowartSelection,
  getCowartViewState,
  restoreCowartViewState
} from './canvasState.js'
import {
  restoreAnnotationToolAfterEditing,
  syncAnnotationShapeProps
} from './annotationSync.js'
import { createSyncState } from './canvasPeriodicSync.js'
import { storeDiffersFromBaseline } from '../canvasSync.js'

export function setupCowartCanvasSession(editor, options) {
  const { viewState, revisionRef, editorRef, setAgentActivity, setIsCanvasEmpty } = options
  window.__cowartEditor = editor
  window.__cowartSelection = () => getCowartSelection(editor)
  window.__cowartViewState = () => getCowartViewState(editor)
  editorRef.current = editor

  const syncState = createSyncState(editor, setIsCanvasEmpty)
  const persistence = createCanvasPersistence(editor, revisionRef, setAgentActivity)
  const isSyncingAnnotationShapeRef = { current: false }

  editor.timers.requestAnimationFrame(() => restoreCowartViewState(editor, viewState))
  syncState.selection()
  const selectionStateTimer = window.setInterval(syncState.selection, 250)
  const viewStateTimer = window.setInterval(syncState.view, 500)
  editor.timers.setTimeout(syncState.view, 100)

  const unsubscribeDocumentSave = editor.store.listen(persistence.scheduleSave, {
    source: 'user',
    scope: 'document'
  })
  const canvasEvents = createCanvasEvents(editor, revisionRef, persistence.loadRemote)
  const unsubscribeAnnotationEditingToolLock = editor.store.listen(
    ({ changes }) => restoreAnnotationToolAfterEditing(editor, changes),
    { source: 'all', scope: 'session' }
  )
  const unsubscribeAnnotationShapeSync = editor.store.listen(
    ({ changes }) => syncAnnotationShapeProps(editor, changes, isSyncingAnnotationShapeRef),
    { source: 'all', scope: 'document' }
  )

  return () => {
    window.clearTimeout(persistence.saveTimer())
    window.clearInterval(selectionStateTimer)
    window.clearInterval(viewStateTimer)
    persistence.abortRemoteLoad()
    canvasEvents?.remove()
    if (window.__cowartEditor === editor) {
      delete window.__cowartEditor
      delete window.__cowartSelection
      delete window.__cowartViewState
    }
    if (editorRef.current === editor) editorRef.current = null
    document.getElementById(SELECTION_STATE_ELEMENT_ID)?.remove()
    unsubscribeDocumentSave()
    unsubscribeAnnotationEditingToolLock()
    unsubscribeAnnotationShapeSync()
    syncState.view()
    persistence.save()
  }
}

function createCanvasEvents(editor, revisionRef, loadRemoteCanvasSnapshot) {
  if (!('EventSource' in window)) return null
  const canvasEvents = new EventSource(CANVAS_EVENTS_ENDPOINT)
  const handleCanvasChanged = (event) => {
    let payloadRevision = null
    try {
      payloadRevision = JSON.parse(event.data)?.revision ?? null
    } catch {
      payloadRevision = null
    }
    if (payloadRevision !== null && payloadRevision === revisionRef.current) return
    loadRemoteCanvasSnapshot()
  }
  const handleExportRequested = (event) => handleCowartExportRequest(editor, event)
  const handleCanvasEventsError = (error) => console.warn('Cowart canvas live refresh disconnected.', error)

  canvasEvents.addEventListener('canvas-changed', handleCanvasChanged)
  canvasEvents.addEventListener('export-requested', handleExportRequested)
  canvasEvents.addEventListener('error', handleCanvasEventsError)

  return {
    remove() {
      canvasEvents.removeEventListener('canvas-changed', handleCanvasChanged)
      canvasEvents.removeEventListener('export-requested', handleExportRequested)
      canvasEvents.removeEventListener('error', handleCanvasEventsError)
      canvasEvents.close()
    }
  }
}

function createCanvasPersistence(editor, revisionRef, setAgentActivity) {
  let saveTimer = null
  let isSaving = false
  let hasPendingSave = false
  let hasUnsavedChanges = false
  let remoteLoadController = null

  async function saveCanvas() {
    if (!hasUnsavedChanges) return
    if (isSaving) {
      hasPendingSave = true
      return
    }

    isSaving = true
    try {
      const response = await fetch(CANVAS_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          snapshot: editor.store.getStoreSnapshot(),
          baseRevision: revisionRef.current
        })
      })
      if (response.status === 409) {
        const conflict = await response.json()
        revisionRef.current = conflict.revision ?? revisionRef.current
        applyRemoteCanvasSnapshot(editor, conflict.snapshot, { preserveLocalChanges: true })
        hasPendingSave = true
        return
      }
      if (!response.ok) throw new Error(`Failed to save canvas: ${response.status}`)

      const result = await response.json()
      revisionRef.current = result.revision ?? revisionRef.current
      hasUnsavedChanges = false
    } catch (error) {
      console.error(error)
    } finally {
      isSaving = false
      if (hasPendingSave) {
        hasPendingSave = false
        scheduleSave()
      }
    }
  }

  function scheduleSave() {
    hasUnsavedChanges = true
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(saveCanvas, 500)
  }

  async function loadRemoteCanvasSnapshot() {
    remoteLoadController?.abort()
    const controller = new AbortController()
    remoteLoadController = controller

    const preserveLocalChanges = hasUnsavedChanges || isSaving
    const preFetchStore = preserveLocalChanges ? null : editor.store.getStoreSnapshot().store

    try {
      const response = await fetch(CANVAS_ENDPOINT, { signal: controller.signal })
      if (!response.ok) throw new Error(`Failed to refresh canvas: ${response.status}`)

      const canvasData = await response.json()
      const effectivePreserve =
        preserveLocalChanges ||
        (preFetchStore && storeDiffersFromBaseline(editor.store.getStoreSnapshot().store, preFetchStore))
      const { changed, addedShapeIds } = applyRemoteCanvasSnapshot(editor, canvasData.snapshot, {
        preserveLocalChanges: effectivePreserve
      })
      revisionRef.current = canvasData.revision ?? revisionRef.current

      if (addedShapeIds.length > 0) {
        setAgentActivity({ count: addedShapeIds.length, shapeIds: addedShapeIds, at: Date.now() })
      }

      if (changed > 0 && effectivePreserve) {
        hasUnsavedChanges = true
        if (isSaving) {
          hasPendingSave = true
        } else {
          scheduleSave()
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') return
      console.error(error)
    } finally {
      if (remoteLoadController === controller) remoteLoadController = null
    }
  }

  return {
    abortRemoteLoad: () => remoteLoadController?.abort(),
    loadRemote: loadRemoteCanvasSnapshot,
    save: saveCanvas,
    saveTimer: () => saveTimer,
    scheduleSave
  }
}
