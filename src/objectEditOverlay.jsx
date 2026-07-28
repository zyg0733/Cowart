import { useRef } from 'react'
import { OBJECT_EDIT_COPY, OBJECT_EDIT_TEST_IDS } from './objectEditState.js'
import { useCowartObjectEditController } from './objectEditController.js'

export function CowartObjectEditOverlay() {
  const {
    accept,
    active,
    applyBrushStroke,
    brushSize,
    canRedo,
    canUndo,
    cancel,
    candidate,
    candidateCount,
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
  } = useCowartObjectEditController()
  const strokeRef = useRef([])

  if (!active && segments.length === 0) return null

  return (
    <div className="cowart-object-edit-layer" data-testid={OBJECT_EDIT_TEST_IDS.overlay}>
      {candidate && previewLayout ? (
        <div
          className={`cowart-object-edit-preview${interactionMode === 'select' ? '' : ' cowart-object-edit-preview--brush'}`}
          style={previewLayout.frameStyle}
          aria-hidden="true"
          onPointerDown={(event) => {
            if (interactionMode === 'select') return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            strokeRef.current = [{ x: event.clientX, y: event.clientY }]
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            const point = { x: event.clientX, y: event.clientY }
            const previous = strokeRef.current.at(-1)
            if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 2) strokeRef.current.push(point)
          }}
          onPointerUp={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            event.currentTarget.releasePointerCapture(event.pointerId)
            applyBrushStroke(strokeRef.current)
            strokeRef.current = []
          }}
          onPointerCancel={() => {
            strokeRef.current = []
          }}
        >
          <img src={candidate.maskUrl} style={previewLayout.imageStyle} alt="" draggable={false} />
        </div>
      ) : null}
      <section
        className={`cowart-object-edit-panel cowart-object-edit-panel--${phase}`}
        style={dock}
        aria-label="Object edit"
        aria-live="polite"
      >
        <div className="cowart-object-edit-status" data-testid={OBJECT_EDIT_TEST_IDS.status}>
          {(phase === 'loading' || phase === 'segmenting' || phase === 'sidecar') ? (
            <span className="cowart-object-edit-spinner" data-testid={OBJECT_EDIT_TEST_IDS.loading} aria-hidden="true" />
          ) : null}
          <span>{status}</span>
        </div>
        {active ? (
          <div className="cowart-object-edit-segmentation">
            <div className="cowart-object-edit-mode" role="group" aria-label="Segmentation mode">
              <button type="button" aria-pressed={segmentationMode === 'point'} onClick={() => setSegmentationMode('point')}>Point</button>
              <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.sidecarMode} aria-pressed={segmentationMode === 'text'} onClick={() => setSegmentationMode('text')}>Text</button>
              <button type="button" aria-pressed={segmentationMode === 'automatic'} onClick={() => setSegmentationMode('automatic')}>Auto</button>
            </div>
            {segmentationMode === 'text' ? (
              <div className="cowart-object-edit-sidecar-input">
                <input
                  data-testid={OBJECT_EDIT_TEST_IDS.sidecarPrompt}
                  value={sidecarPrompt}
                  maxLength={500}
                  placeholder="Object name"
                  aria-label="Object name"
                  onChange={(event) => setSidecarPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && sidecarPrompt.trim()) runSidecarSegmentation()
                  }}
                />
                <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.sidecarRun} onClick={runSidecarSegmentation} disabled={!sidecarPrompt.trim() || phase === 'sidecar'}>Run</button>
              </div>
            ) : null}
            {segmentationMode === 'automatic' ? (
              <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.sidecarRun} className="cowart-object-edit-sidecar-run" onClick={runSidecarSegmentation} disabled={phase === 'sidecar'}>Find objects</button>
            ) : null}
          </div>
        ) : null}
        {segments.length > 0 ? <div className="cowart-object-edit-summary">{segments.length} confirmed</div> : null}
        {segments.length > 0 ? (
          <div className="cowart-object-edit-object-list" data-testid={OBJECT_EDIT_TEST_IDS.objectList} aria-label="Confirmed objects">
            {segments.map((segment, index) => (
              <button
                type="button"
                key={segment.segmentId}
                className="cowart-object-edit-object"
                aria-pressed={selectedSegmentId === segment.segmentId}
                onClick={() => selectSegment(segment.segmentId)}
              >
                Object {index + 1}
              </button>
            ))}
          </div>
        ) : null}
        {lineage.length > 1 ? (
          <ol className="cowart-object-edit-lineage" data-testid={OBJECT_EDIT_TEST_IDS.lineage} aria-label="Lineage">
            {lineage.map((event) => <li key={event.id}>{event.label}</li>)}
          </ol>
        ) : null}
        {active && segments.length > 0 ? (
          <div className="cowart-object-edit-object-actions">
            <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.modify} onClick={() => queueObjectAction('modify')}>Modify</button>
            <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.replace} onClick={() => queueObjectAction('replace')}>Replace</button>
            <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.remove} onClick={() => queueObjectAction('remove')}>Remove</button>
            <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.variants} onClick={queueVariantGrid}>4 variants</button>
            <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.decompose} onClick={() => setShowDecompositionConfirm(true)}>Decompose</button>
          </div>
        ) : null}
        {showDecompositionConfirm ? (
          <div className="cowart-object-edit-upload-confirm" role="alertdialog" aria-label="Confirm image upload">
            <p>Send this source image and {segments.length} confirmed object {segments.length === 1 ? 'mask' : 'masks'} to Codex image_gen?</p>
            <div>
              <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.confirmDecompose} onClick={queueSceneDecomposition}>Confirm</button>
              <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.cancelDecompose} onClick={() => setShowDecompositionConfirm(false)}>Cancel</button>
            </div>
          </div>
        ) : null}
        {decomposition ? (
          <div className="cowart-decomposition-stack" data-testid={OBJECT_EDIT_TEST_IDS.decompositionStack}>
            <div className="cowart-decomposition-stack__header">
              <span>Decomposition</span>
              <span>{decomposition.manifest.status}</span>
            </div>
            {decomposition.artifacts.map((artifact) => (
              <label key={`${artifact.kind}:${artifact.imageShapeId}`}>
                <input
                  type="checkbox"
                  checked={artifact.visible}
                  onChange={(event) => setDecompositionArtifactVisible(artifact.imageShapeId, event.target.checked)}
                />
                <span>{artifact.kind.replaceAll('_', ' ')}</span>
                {artifact.synthetic ? <small>AI</small> : <small>Source</small>}
              </label>
            ))}
          </div>
        ) : null}
        {(phase === 'error' || phase === 'stale' || (segmentationMode === 'point' && !support.ok)) ? (
          <div className="cowart-object-edit-error" data-testid={OBJECT_EDIT_TEST_IDS.error}>{error || status}</div>
        ) : null}
        {active ? (
          <>
          {candidate ? (
            <div className="cowart-object-edit-corrections">
              <div className="cowart-object-edit-candidate-nav">
                <button
                  type="button"
                  data-testid={OBJECT_EDIT_TEST_IDS.previousCandidate}
                  className="cowart-object-edit-icon-btn"
                  aria-label="Previous candidate"
                  onClick={previousCandidate}
                  disabled={candidateIndex === 0}
                >
                  ‹
                </button>
                <span>{candidateIndex + 1} / {candidateCount}</span>
                <button
                  type="button"
                  data-testid={OBJECT_EDIT_TEST_IDS.nextCandidate}
                  className="cowart-object-edit-icon-btn"
                  aria-label="Next candidate"
                  onClick={nextCandidate}
                  disabled={candidateIndex >= candidateCount - 1}
                >
                  ›
                </button>
              </div>
              <div className="cowart-object-edit-mode" role="group" aria-label="Mask mode">
                <button type="button" aria-pressed={interactionMode === 'select'} onClick={() => setInteractionMode('select')}>Select</button>
                <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.brushAdd} aria-pressed={interactionMode === 'add'} onClick={() => setInteractionMode('add')}>Add</button>
                <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.brushRemove} aria-pressed={interactionMode === 'remove'} onClick={() => setInteractionMode('remove')}>Remove</button>
              </div>
              <label className="cowart-object-edit-brush-size">
                <span>Brush</span>
                <input
                  data-testid={OBJECT_EDIT_TEST_IDS.brushSize}
                  type="range"
                  min="4"
                  max="160"
                  step="4"
                  value={brushSize}
                  onChange={(event) => setBrushSize(Number(event.target.value))}
                />
                <output>{brushSize}</output>
              </label>
              <div className="cowart-object-edit-history">
                <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.undo} onClick={undo} disabled={!canUndo}>Undo</button>
                <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.redo} onClick={redo} disabled={!canRedo}>Redo</button>
                <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.reset} onClick={resetMask}>Reset</button>
              </div>
            </div>
          ) : null}
          <div className="cowart-object-edit-actions">
            <button
              type="button"
              data-testid={OBJECT_EDIT_TEST_IDS.accept}
              className="cowart-object-edit-btn cowart-object-edit-btn--primary"
              onClick={accept}
              disabled={phase !== 'preview'}
            >
              {OBJECT_EDIT_COPY.accept}
            </button>
            <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.retry} className="cowart-object-edit-btn" onClick={cancel}>
              {OBJECT_EDIT_COPY.retry}
            </button>
            <button type="button" data-testid={OBJECT_EDIT_TEST_IDS.cancel} className="cowart-object-edit-btn" onClick={cancel}>
              {OBJECT_EDIT_COPY.cancel}
            </button>
          </div>
          </>
        ) : null}
      </section>
    </div>
  )
}
