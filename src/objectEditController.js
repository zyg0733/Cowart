import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createShapeId, useEditor, useValue } from 'tldraw'
import {
  confirmObjectSegment,
  fetchObjectSegmentMask,
  getObjectSegment,
  listObjectSegments,
  refineObjectSegment,
  segmentObjectWithSidecar
} from './objectEditApi.js'
import {
  getObjectEditAvoidRects,
  getObjectEditPanelAnchor,
  getObjectEditPanelDock,
  getPreviewLayout,
  createPreviewUrlStore
} from './objectEditGeometry.js'
import { focusObjectEditControl } from './objectEditFocus.js'
import { normalizeObjectEditInput } from './objectEditInput.js'
import { createAiImageHolderShape } from './app/aiImageHolder.js'
import { buildObjectEditLineage } from './objectEditLineage.js'
import {
  applyMaskBrush,
  createMaskHistory,
  redoMaskHistory,
  resetMaskHistory,
  undoMaskHistory
} from './objectEditMaskHistory.js'
import { encodeGrayscalePng, summarizeMask } from './objectEditWorkerMask.js'
import {
  OBJECT_EDIT_COPY,
  OBJECT_EDIT_TEST_IDS,
  OBJECT_EDIT_TOOL_ID,
  base64ToBytes,
  buildObjectEditSource,
  bytesToBase64,
  createSegmentId,
  currentSourceMatches,
  decodeSelectionMask,
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
  const [candidates, setCandidates] = useState([])
  const [candidateIndex, setCandidateIndex] = useState(0)
  const [maskUrl, setMaskUrl] = useState(null)
  const [interactionMode, setInteractionMode] = useState('select')
  const [brushSize, setBrushSize] = useState(32)
  const [selectedSegmentId, setSelectedSegmentId] = useState(null)
  const [segments, setSegments] = useState([])
  const [segmentationMode, setSegmentationMode] = useState('point')
  const [sidecarPrompt, setSidecarPrompt] = useState('')
  const [showDecompositionConfirm, setShowDecompositionConfirm] = useState(false)
  const toolState = useValue('object edit state', () => getObjectEditToolState(editor), [editor])
  const currentTool = useValue('object edit active tool', () => editor.getCurrentToolId(), [editor])
  const selectionKey = useValue('object edit selection key', () => editor.getSelectedShapeIds().join('|'), [editor])
  const picked = useValue('object edit selected image', () => selectedImage(editor), [editor, selectionKey])
  const source = useValue('object edit source', () => buildObjectEditSource(editor), [editor, selectionKey, picked?.asset?.meta?.cowartSha256])
  const mapper = useValue('object edit mapper', () => mapperFor(editor, source), [editor, source, selectionKey])
  const support = useMemo(() => workerSupport(), [])
  const active = currentTool === OBJECT_EDIT_TOOL_ID
  const candidate = candidates[candidateIndex] ?? null
  const lineage = useValue('object edit lineage', () => {
    const ids = editor.getCurrentPageShapeIds?.() ?? []
    const shapes = Array.from(ids, (id) => editor.getShape(id)).filter(Boolean)
    return buildObjectEditLineage(shapes, source?.shapeId)
  }, [editor, source?.shapeId])
  const decomposition = useValue('scene decomposition stack', () => {
    if (!source?.shapeId) return null
    const ids = editor.getCurrentPageShapeIds?.() ?? []
    const shapes = Array.from(ids, (id) => editor.getShape(id)).filter(Boolean)
    const holder = shapes
      .filter((shape) => shape.meta?.cowartDecomposition?.sourceShapeId === source.shapeId)
      .sort((left, right) => String(left.meta.cowartDecomposition.createdAt).localeCompare(String(right.meta.cowartDecomposition.createdAt)))
      .at(-1)
    if (!holder) return null
    const manifest = holder.meta.cowartDecomposition
    return {
      holderId: holder.id,
      manifest,
      artifacts: (Array.isArray(manifest.artifacts) ? manifest.artifacts : []).map((artifact) => {
        const shape = editor.getShape(artifact.imageShapeId)
        return { ...artifact, visible: Boolean(shape && shape.opacity !== 0) }
      })
    }
  }, [editor, source?.shapeId])

  const resetWorker = useCallback(() => {
    tokenRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    workerRef.current?.terminate()
    workerRef.current = null
  }, [])

  const clearCandidate = useCallback(() => {
    urlStoreRef.current?.clear()
    setMaskUrl(null)
    setCandidates([])
    setCandidateIndex(0)
    setInteractionMode('select')
  }, [])

  useEffect(() => {
    if (!candidate?.maskPng) {
      urlStoreRef.current?.clear()
      setMaskUrl(null)
      return
    }
    urlStoreRef.current ??= createPreviewUrlStore(URL)
    setMaskUrl(urlStoreRef.current.replace(candidate.maskPng))
  }, [candidate])

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
      const nextSegments = result.segments ?? []
      setSegments(nextSegments)
      setSelectedSegmentId((current) => (
        nextSegments.some((segment) => segment.segmentId === current)
          ? current
          : nextSegments.at(-1)?.segmentId ?? null
      ))
    } catch (segmentError) {
      void segmentError
      setSegments([])
    }
  }, [source])

  useEffect(() => {
    refreshSegments()
  }, [refreshSegments])

  useEffect(() => {
    setShowDecompositionConfirm(false)
  }, [source?.shapeId])

  const runSidecarSegmentation = useCallback(async () => {
    if (!source || !['text', 'automatic'].includes(segmentationMode)) return
    if (segmentationMode === 'text' && !sidecarPrompt.trim()) return
    tokenRef.current += 1
    abortRef.current?.abort()
    const token = tokenRef.current
    const controller = new AbortController()
    abortRef.current = controller
    clearCandidate()
    setError('')
    setPhase('sidecar')
    try {
      const result = await segmentObjectWithSidecar({ signal: controller.signal }, {
        source,
        mode: segmentationMode,
        prompt: segmentationMode === 'text' ? sidecarPrompt.trim() : undefined,
        maxCandidates: 8
      })
      if (token !== tokenRef.current || !currentSourceMatches(editor, source)) return
      const nextCandidates = []
      for (const item of result.candidates ?? []) {
        const maskPng = base64ToBytes(item.maskBase64)
        const pixels = await decodeSelectionMask(maskPng, source.width, source.height)
        nextCandidates.push({
          source,
          selection: {
            mode: segmentationMode,
            prompt: segmentationMode === 'text' ? sidecarPrompt.trim() : undefined,
            candidateId: item.candidateId,
            score: item.score
          },
          provider: result.provider,
          maskPng,
          bbox: item.bbox,
          area: item.area,
          history: createMaskHistory({ width: source.width, height: source.height, pixels }),
          corrections: []
        })
      }
      if (nextCandidates.length === 0) throw new Error('Sidecar returned no object candidates.')
      setCandidates(nextCandidates.slice(0, 8))
      setCandidateIndex(0)
      setInteractionMode('select')
      setPhase('preview')
    } catch (sidecarError) {
      if (sidecarError?.name === 'AbortError' || sidecarError?.code === 'sidecar_cancelled') return
      setError(sidecarError.message || OBJECT_EDIT_COPY.error)
      setPhase(sidecarError.code === 'source_asset_changed' ? 'stale' : 'error')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [clearCandidate, editor, segmentationMode, sidecarPrompt, source])

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
    if (!active || !support.ok || segmentationMode !== 'point') return
    const onInput = async (event) => {
      if (!source || !picked || !mapper) return
      const imageSelection = normalizeObjectEditInput(event.detail, mapper, source)
      if (!imageSelection) return
      tokenRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
      setError('')
      setPhase('loading')
      const token = tokenRef.current
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const imageBytes = await fetchLocalImageBytes(picked.asset.props.src, controller.signal)
        const worker = workerRef.current ?? new Worker(new URL('./objectEditWorker.js', import.meta.url), { type: 'module' })
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
          if (
            message.type !== 'segment-result' ||
            !(message.maskPng instanceof Uint8Array) ||
            !(message.maskPixels instanceof Uint8Array) ||
            message.maskPixels.length !== message.width * message.height ||
            message.area <= 0
          ) return
          if (!currentSourceMatches(editor, source)) {
            clearCandidate()
            setError(OBJECT_EDIT_COPY.stale)
            setPhase('stale')
            resetWorker()
            return
          }
          const nextCandidate = {
            source,
            selection: imageSelection,
            maskPng: message.maskPng,
            bbox: message.bbox,
            area: message.area,
            history: createMaskHistory({ width: message.width, height: message.height, pixels: message.maskPixels }),
            corrections: []
          }
          setCandidates((current) => {
            const next = [...current, nextCandidate].slice(-6)
            setCandidateIndex(next.length - 1)
            return next
          })
          setPhase('preview')
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
  }, [active, cancel, clearCandidate, editor, mapper, picked, resetWorker, segmentationMode, source, support.ok])

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
      const payload = {
        segmentId: createSegmentId(),
        source: candidate.source,
        maskBase64: bytesToBase64(candidate.maskPng),
        previewBase64: bytesToBase64(candidate.maskPng),
        selection: {
          ...candidate.selection,
          corrections: candidate.corrections.length > 0
            ? {
                mode: 'candidate_mask_brush',
                operations: candidate.corrections,
                note: 'Local candidate-mask correction; not additional model inference.'
              }
            : null
        },
        provider: candidate.provider ?? { id: 'mediapipe-interactive', runtime: 'browser', processing: 'local', model: 'magic_touch', version: 'float32/1' }
      }
      if (candidate.corrections.length > 0 && !candidate.parentSegmentId) {
        payload.selection.corrections.upstreamProvider = payload.provider
        payload.provider = {
          id: 'cowart-browser-mask-brush',
          runtime: 'browser',
          processing: 'local',
          model: null,
          version: '1'
        }
      }
      if (candidate.parentSegmentId) {
        payload.selection = {
          ...payload.selection,
          mode: 'brush_refine',
          parentSegmentId: candidate.parentSegmentId
        }
        payload.provider = {
          id: 'cowart-browser-mask-brush',
          runtime: 'browser',
          processing: 'local',
          model: null,
          version: '1'
        }
        await refineObjectSegment({}, candidate.parentSegmentId, payload)
      } else {
        await confirmObjectSegment({}, payload)
      }
      clearCandidate()
      resetWorker()
      setPhase('confirmed')
      focusObjectEditControl(OBJECT_EDIT_TEST_IDS.tool)
      await refreshSegments()
    } catch (acceptError) {
      setError(acceptError.message || OBJECT_EDIT_COPY.error)
      setPhase(acceptError.code === 'source_asset_changed' ? 'stale' : 'error')
    }
  }, [candidate, clearCandidate, editor, refreshSegments, resetWorker])

  const updateCandidateHistory = useCallback((transform, correction = null) => {
    setCandidates((current) => current.map((item, index) => {
      if (index !== candidateIndex || !item.history) return item
      const history = transform(item.history)
      if (history === item.history) return item
      const mask = { width: history.width, height: history.height, pixels: history.present }
      const summary = summarizeMask(mask)
      return {
        ...item,
        history,
        maskPng: encodeGrayscalePng(mask),
        bbox: summary.bbox,
        area: summary.area,
        corrections: correction ? [...item.corrections, correction] : item.corrections
      }
    }))
  }, [candidateIndex])

  const applyBrushStroke = useCallback((screenPoints) => {
    if (!candidate || interactionMode === 'select' || !mapper || screenPoints.length === 0) return
    const naturalPoints = screenPoints.map((point) => {
      const pagePoint = editor.screenToPage(point)
      return mapper.pagePointToNaturalPoint(pagePoint)
    })
    updateCandidateHistory(
      (history) => applyMaskBrush(history, { mode: interactionMode, points: naturalPoints, size: brushSize }),
      { mode: interactionMode, size: brushSize, points: naturalPoints.length }
    )
  }, [brushSize, candidate, editor, interactionMode, mapper, updateCandidateHistory])

  const undo = useCallback(() => updateCandidateHistory(undoMaskHistory), [updateCandidateHistory])
  const redo = useCallback(() => updateCandidateHistory(redoMaskHistory), [updateCandidateHistory])
  const resetMask = useCallback(() => updateCandidateHistory(resetMaskHistory), [updateCandidateHistory])
  const previousCandidate = useCallback(() => setCandidateIndex((index) => Math.max(0, index - 1)), [])
  const nextCandidate = useCallback(() => setCandidateIndex((index) => Math.min(candidates.length - 1, index + 1)), [candidates.length])
  const selectSegment = useCallback(async (segmentId) => {
    setSelectedSegmentId(segmentId)
    setError('')
    setPhase('loading')
    try {
      const [{ segment }, maskPng] = await Promise.all([
        getObjectSegment({}, segmentId),
        fetchObjectSegmentMask({}, segmentId)
      ])
      if (!currentSourceMatches(editor, segment.source)) {
        setPhase('stale')
        setError(OBJECT_EDIT_COPY.stale)
        return
      }
      const pixels = await decodeSelectionMask(maskPng, segment.source.width, segment.source.height)
      const history = createMaskHistory({ width: segment.source.width, height: segment.source.height, pixels })
      const nextCandidate = {
        source: segment.source,
        selection: segment.selection ?? { mode: 'confirmed' },
        parentSegmentId: segment.segmentId,
        maskPng,
        bbox: segment.mask?.bbox ?? null,
        area: segment.mask?.area ?? 0,
        history,
        corrections: []
      }
      setCandidates((current) => {
        const next = [...current, nextCandidate].slice(-6)
        setCandidateIndex(next.length - 1)
        return next
      })
      setInteractionMode('add')
      setPhase('preview')
    } catch (segmentError) {
      setError(segmentError.message || OBJECT_EDIT_COPY.error)
      setPhase(segmentError.code === 'segment_stale' ? 'stale' : 'error')
    }
  }, [editor])

  const queueObjectAction = useCallback((operation) => {
    const segment = segments.find((item) => item.segmentId === selectedSegmentId)
    if (!segment || !source || !picked) return
    const requestedAt = new Date().toISOString()
    const action = {
      operation,
      segmentId: segment.segmentId,
      sourcePageId: source.pageId,
      sourceShapeId: source.shapeId,
      sourceAssetId: source.assetId,
      sourceSha256: source.assetSha256,
      sourceWidth: source.width,
      sourceHeight: source.height,
      prompt: objectActionPrompt(operation),
      synthetic: true,
      requestedAt
    }
    const bounds = editor.getShapePageBounds(picked.shape)
    const existingCount = Array.from(editor.getCurrentPageShapeIds?.() ?? [])
      .map((id) => editor.getShape(id))
      .filter((shape) => shape?.meta?.cowartObjectAction?.sourceShapeId === source.shapeId)
      .length
    const holderId = createShapeId()
    const request = {
      id: createObjectActionRequestId(),
      requestedAt,
      attempt: 1,
      kind: 'object_action',
      objectAction: action
    }
    editor.markHistoryStoppingPoint('cowart-object-action-request')
    createAiImageHolderShape(editor, holderId, {
      parentId: editor.getCurrentPageId(),
      x: (bounds?.maxX ?? bounds?.x + bounds?.w ?? 0) + 40 + (existingCount % 2) * 340,
      y: (bounds?.y ?? 0) + Math.floor(existingCount / 2) * 240,
      meta: { cowartObjectAction: action, cowartRequest: request },
      props: {
        name: `${operation[0].toUpperCase()}${operation.slice(1)} object`,
        prompt: action.prompt,
        status: 'requested'
      }
    })
  }, [editor, picked, segments, selectedSegmentId, source])

  const queueVariantGrid = useCallback(() => {
    const segment = segments.find((item) => item.segmentId === selectedSegmentId)
    if (!segment || !source || !picked) return
    const requestedAt = new Date().toISOString()
    const gridId = `variant-grid:${createObjectActionRequestId()}`
    const action = {
      operation: 'modify',
      segmentId: segment.segmentId,
      sourcePageId: source.pageId,
      sourceShapeId: source.shapeId,
      sourceAssetId: source.assetId,
      sourceSha256: source.assetSha256,
      sourceWidth: source.width,
      sourceHeight: source.height,
      prompt: 'Create a distinct visual treatment for the selected object while preserving the rest of the image.',
      synthetic: true,
      requestedAt
    }
    const group = {
      id: gridId,
      sourceShapeId: source.shapeId,
      sourceSha256: source.assetSha256,
      segmentId: segment.segmentId,
      operation: action.operation,
      count: 4,
      winnerHolderId: null,
      createdAt: requestedAt
    }
    const bounds = editor.getShapePageBounds(picked.shape)
    const origin = { x: (bounds?.maxX ?? bounds?.x + bounds?.w ?? 0) + 40, y: bounds?.y ?? 0 }
    const holderIds = []
    editor.markHistoryStoppingPoint('cowart-variant-grid-request')
    for (let index = 0; index < 4; index += 1) {
      const variant = { gridId, index, count: 4 }
      const request = {
        id: createObjectActionRequestId(),
        requestedAt,
        attempt: 1,
        kind: 'variant',
        objectAction: action,
        variant
      }
      const holderId = createShapeId()
      holderIds.push(holderId)
      createAiImageHolderShape(editor, holderId, {
        parentId: editor.getCurrentPageId(),
        x: origin.x + (index % 2) * 344,
        y: origin.y + Math.floor(index / 2) * 244,
        meta: {
          cowartObjectAction: action,
          cowartVariant: variant,
          cowartVariantGroup: group,
          cowartRequest: request
        },
        props: {
          name: `Variant ${index + 1}`,
          prompt: action.prompt,
          status: 'requested'
        }
      })
    }
    const visibleBounds = [bounds, ...holderIds.map((id) => editor.getShapePageBounds(id))].filter(Boolean)
    if (visibleBounds.length > 0) {
      const left = Math.min(...visibleBounds.map((item) => item.minX ?? item.x))
      const top = Math.min(...visibleBounds.map((item) => item.minY ?? item.y))
      const right = Math.max(...visibleBounds.map((item) => item.maxX ?? item.x + item.w))
      const bottom = Math.max(...visibleBounds.map((item) => item.maxY ?? item.y + item.h))
      editor.zoomToBounds(
        { x: left, y: top, w: right - left, h: bottom - top },
        { inset: 72, targetZoom: Math.min(1, editor.getZoomLevel()), animation: { duration: 220 } }
      )
    }
  }, [editor, picked, segments, selectedSegmentId, source])

  const queueSceneDecomposition = useCallback(() => {
    if (segments.length === 0 || !source || !picked) return
    const createdAt = new Date().toISOString()
    const decompositionId = `decomposition:${createObjectActionRequestId()}`
    const segmentIds = segments.map((segment) => segment.segmentId)
    const manifest = {
      id: decompositionId,
      sourceShapeId: source.shapeId,
      sourceSha256: source.assetSha256,
      status: 'requested',
      segmentIds,
      sceneGraph: null,
      artifacts: [],
      provider: 'codex-image_gen',
      createdAt,
      completedAt: null,
      revision: 1
    }
    const requestDescriptor = {
      id: decompositionId,
      sourceShapeId: source.shapeId,
      sourceSha256: source.assetSha256,
      segmentIds,
      artifactKinds: ['depth_hint', 'clean_plate'],
      uploadConfirmedAt: createdAt
    }
    const request = {
      id: createObjectActionRequestId(),
      requestedAt: createdAt,
      attempt: 1,
      kind: 'scene_decomposition',
      decomposition: requestDescriptor
    }
    const bounds = editor.getShapePageBounds(picked.shape)
    const holderId = createShapeId()
    editor.markHistoryStoppingPoint('cowart-scene-decomposition-request')
    createAiImageHolderShape(editor, holderId, {
      parentId: editor.getCurrentPageId(),
      x: (bounds?.maxX ?? bounds?.x + bounds?.w ?? 0) + 40,
      y: bounds?.y ?? 0,
      meta: {
        cowartDecomposition: manifest,
        cowartRequest: request
      },
      props: {
        w: bounds?.w ?? picked.shape.props.w,
        h: bounds?.h ?? picked.shape.props.h,
        name: 'Scene decomposition',
        prompt: 'Create a grayscale relative depth hint and a clean plate with the confirmed foreground objects removed.',
        status: 'requested'
      }
    })
    setShowDecompositionConfirm(false)
  }, [editor, picked, segments, source])

  const setDecompositionArtifactVisible = useCallback((imageShapeId, visible) => {
    const shape = editor.getShape(imageShapeId)
    if (!shape) return
    editor.updateShape({ id: shape.id, type: shape.type, opacity: visible ? 1 : 0 })
  }, [editor])

  const status = segmentationMode === 'point' && !support.ok
    ? support.message
    : phase === 'idle'
      ? (OBJECT_EDIT_COPY[toolState.kind] ?? OBJECT_EDIT_COPY.ready)
      : (OBJECT_EDIT_COPY[phase] ?? OBJECT_EDIT_COPY.ready)
  const previewLayout = candidate && mapper ? getPreviewLayout({ editor, mapper, source: candidate.source }) : null
  const dock = getObjectEditPanelDock({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    anchor: getObjectEditPanelAnchor(editor, picked),
    avoidRects: getObjectEditAvoidRects()
  })

  return {
    accept,
    active,
    applyBrushStroke,
    brushSize,
    canRedo: Boolean(candidate?.history?.future.length),
    canUndo: Boolean(candidate?.history?.past.length),
    cancel,
    candidate: candidate ? { ...candidate, maskUrl } : null,
    candidateCount: candidates.length,
    candidateIndex,
    decomposition,
    dock,
    error,
    interactionMode,
    lineage,
    nextCandidate,
    phase,
    previousCandidate,
    previewLayout,
    queueObjectAction,
    queueSceneDecomposition,
    queueVariantGrid,
    redo,
    resetMask,
    segments,
    selectedSegmentId,
    segmentationMode,
    selectSegment,
    setBrushSize,
    setDecompositionArtifactVisible,
    setInteractionMode,
    setSegmentationMode,
    setShowDecompositionConfirm,
    setSidecarPrompt,
    showDecompositionConfirm,
    sidecarPrompt,
    runSidecarSegmentation,
    status,
    support,
    undo
  }
}

function createObjectActionRequestId() {
  if (typeof crypto?.randomUUID === 'function') return `cowart-request-${crypto.randomUUID()}`
  return `cowart-request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function objectActionPrompt(operation) {
  if (operation === 'remove') return 'Remove the selected object and plausibly fill the revealed background.'
  if (operation === 'replace') return 'Replace the selected object with the subject described in this prompt while preserving the rest of the image.'
  return 'Modify the selected object as described while preserving the rest of the image.'
}
