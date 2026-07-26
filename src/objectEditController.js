import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, useValue } from 'tldraw'
import { confirmObjectSegment, listObjectSegments } from './objectEditApi.js'
import {
  getObjectEditAvoidRects,
  getObjectEditPanelAnchor,
  getObjectEditPanelDock,
  getPreviewLayout,
  createPreviewUrlStore
} from './objectEditGeometry.js'
import { focusObjectEditControl } from './objectEditFocus.js'
import { normalizeObjectEditInput } from './objectEditInput.js'
import {
  OBJECT_EDIT_COPY,
  OBJECT_EDIT_TEST_IDS,
  OBJECT_EDIT_TOOL_ID,
  buildObjectEditSource,
  bytesToBase64,
  createSegmentId,
  currentSourceMatches,
  fetchLocalImageBytes,
  getObjectEditToolState,
  mapperFor,
  selectedImage,
  workerSupport
} from './objectEditState.js'

export function useCowartObjectEditController() {
  const editor = useEditor()
  const workerRef = useRef(null)
  const tokenRef = useRef(0)
  const abortRef = useRef(null)
  const urlStoreRef = useRef(null)
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState('')
  const [candidate, setCandidate] = useState(null)
  const [segments, setSegments] = useState([])
  const toolState = useValue('object edit state', () => getObjectEditToolState(editor), [editor])
  const currentTool = useValue('object edit active tool', () => editor.getCurrentToolId(), [editor])
  const selectionKey = useValue('object edit selection key', () => editor.getSelectedShapeIds().join('|'), [editor])
  const picked = useValue('object edit selected image', () => selectedImage(editor), [editor, selectionKey])
  const source = useValue('object edit source', () => buildObjectEditSource(editor), [editor, selectionKey, picked?.asset?.meta?.cowartSha256])
  const mapper = useValue('object edit mapper', () => mapperFor(editor, source), [editor, source, selectionKey])
  const support = useMemo(() => workerSupport(), [])
  const active = currentTool === OBJECT_EDIT_TOOL_ID

  const resetWorker = useCallback(() => {
    tokenRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    workerRef.current?.terminate()
    workerRef.current = null
  }, [])

  const clearCandidate = useCallback(() => {
    urlStoreRef.current?.clear()
    setCandidate(null)
  }, [])

  const cancel = useCallback(() => {
    resetWorker()
    clearCandidate()
    setError('')
    setPhase('idle')
    focusObjectEditControl(OBJECT_EDIT_TEST_IDS.tool)
  }, [clearCandidate, resetWorker])

  const refreshSegments = useCallback(async () => {
    if (!source) {
      setSegments([])
      return
    }
    try {
      const result = await listObjectSegments({}, { shapeId: source.shapeId, assetId: source.assetId })
      setSegments(result.segments ?? [])
    } catch (segmentError) {
      void segmentError
      setSegments([])
    }
  }, [source])

  useEffect(() => {
    refreshSegments()
  }, [refreshSegments])

  useEffect(() => {
    if (active) return
    resetWorker()
    clearCandidate()
    setError('')
    setPhase('idle')
  }, [active, clearCandidate, resetWorker])

  useEffect(() => {
    if (!candidate || currentSourceMatches(editor, candidate.source)) return
    clearCandidate()
    setPhase('stale')
    setError(OBJECT_EDIT_COPY.stale)
  }, [candidate, clearCandidate, editor, selectionKey])

  useEffect(() => {
    if (!active || !support.ok) return
    const onInput = async (event) => {
      if (!source || !picked || !mapper) return
      const imageSelection = normalizeObjectEditInput(event.detail, mapper, source)
      if (!imageSelection) return
      resetWorker()
      clearCandidate()
      setError('')
      setPhase('loading')
      const token = tokenRef.current
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const imageBytes = await fetchLocalImageBytes(picked.asset.props.src, controller.signal)
        const worker = new Worker(new URL('./objectEditWorker.js', import.meta.url), { type: 'module' })
        workerRef.current = worker
        setPhase('segmenting')
        worker.onerror = (workerError) => {
          if (token !== tokenRef.current) return
          setError(workerError.message || OBJECT_EDIT_COPY.error)
          setPhase('error')
          resetWorker()
        }
        worker.onmessageerror = () => {
          if (token !== tokenRef.current) return
          setError(OBJECT_EDIT_COPY.error)
          setPhase('error')
          resetWorker()
        }
        worker.onmessage = (messageEvent) => {
          const message = messageEvent.data
          if (message.token !== tokenRef.current) return
          if (message.type === 'segment-error') {
            clearCandidate()
            setError(message.message || OBJECT_EDIT_COPY.error)
            setPhase('error')
            resetWorker()
            return
          }
          if (message.type !== 'segment-result' || !(message.maskPng instanceof Uint8Array) || message.area <= 0) return
          if (!currentSourceMatches(editor, source)) {
            clearCandidate()
            setError(OBJECT_EDIT_COPY.stale)
            setPhase('stale')
            resetWorker()
            return
          }
          urlStoreRef.current ??= createPreviewUrlStore(URL)
          const maskUrl = urlStoreRef.current.replace(message.maskPng)
          setCandidate({ source, selection: imageSelection, maskPng: message.maskPng, maskUrl, bbox: message.bbox, area: message.area })
          setPhase('preview')
          resetWorker()
        }
        worker.postMessage({
          type: 'segment',
          token,
          source,
          selection: imageSelection,
          imageBytes,
          mimeType: picked.asset.props.mimeType
        }, [imageBytes.buffer])
      } catch (inputError) {
        if (inputError?.name === 'AbortError') return
        clearCandidate()
        setError(inputError.message || OBJECT_EDIT_COPY.error)
        setPhase('error')
        resetWorker()
      }
    }
    const onCancel = () => cancel()
    window.addEventListener('cowart-object-edit-input', onInput)
    window.addEventListener('cowart-object-edit-cancel', onCancel)
    return () => {
      window.removeEventListener('cowart-object-edit-input', onInput)
      window.removeEventListener('cowart-object-edit-cancel', onCancel)
    }
  }, [active, cancel, clearCandidate, editor, mapper, picked, resetWorker, source, support.ok])

  useEffect(() => () => {
    resetWorker()
    clearCandidate()
  }, [clearCandidate, resetWorker])

  useEffect(() => {
    if (!active) return
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      }
      if (event.key === 'Enter' && phase === 'preview') {
        event.preventDefault()
        document.querySelector(`[data-testid="${OBJECT_EDIT_TEST_IDS.accept}"]`)?.click()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, cancel, phase])

  useEffect(() => {
    if (!active) return
    if (phase === 'preview') focusObjectEditControl(OBJECT_EDIT_TEST_IDS.accept)
    if (phase === 'error' || phase === 'stale' || !support.ok) focusObjectEditControl(OBJECT_EDIT_TEST_IDS.retry)
  }, [active, phase, support.ok])

  useEffect(() => {
    if (!('EventSource' in window)) return
    const events = new EventSource('/api/canvas-events')
    const onSegmentChanged = () => refreshSegments()
    events.addEventListener('segment-changed', onSegmentChanged)
    return () => {
      events.removeEventListener('segment-changed', onSegmentChanged)
      events.close()
    }
  }, [refreshSegments])

  const accept = useCallback(async () => {
    if (!candidate) return
    if (!currentSourceMatches(editor, candidate.source)) {
      clearCandidate()
      setPhase('stale')
      setError(OBJECT_EDIT_COPY.stale)
      return
    }
    setPhase('loading')
    try {
      await confirmObjectSegment({}, {
        segmentId: createSegmentId(),
        source: candidate.source,
        maskBase64: bytesToBase64(candidate.maskPng),
        previewBase64: bytesToBase64(candidate.maskPng),
        selection: candidate.selection,
        provider: { id: 'mediapipe-interactive', runtime: 'browser', processing: 'local', model: 'magic_touch', version: 'float32/1' }
      })
      clearCandidate()
      setPhase('confirmed')
      focusObjectEditControl(OBJECT_EDIT_TEST_IDS.tool)
      await refreshSegments()
    } catch (acceptError) {
      setError(acceptError.message || OBJECT_EDIT_COPY.error)
      setPhase(acceptError.code === 'source_asset_changed' ? 'stale' : 'error')
    }
  }, [candidate, clearCandidate, editor, refreshSegments])

  const status = !support.ok ? support.message : phase === 'idle' ? (OBJECT_EDIT_COPY[toolState.kind] ?? OBJECT_EDIT_COPY.ready) : (OBJECT_EDIT_COPY[phase] ?? OBJECT_EDIT_COPY.ready)
  const previewLayout = candidate && mapper ? getPreviewLayout({ editor, mapper, source: candidate.source }) : null
  const dock = getObjectEditPanelDock({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    anchor: getObjectEditPanelAnchor(editor, picked),
    avoidRects: getObjectEditAvoidRects()
  })

  return { accept, active, cancel, candidate, dock, error, phase, previewLayout, segments, status, support }
}
