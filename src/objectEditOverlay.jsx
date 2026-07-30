import { OBJECT_EDIT_COPY, OBJECT_EDIT_TEST_IDS } from './objectEditState.js'
import { useCowartObjectEditController } from './objectEditController.js'

export function CowartObjectEditOverlay() {
  const {
    accept,
    active,
    cancel,
    candidate,
    dock,
    error,
    phase,
    previewLayout,
    segments,
    status,
    support
  } = useCowartObjectEditController()

  if (!active && segments.length === 0) return null

  return (
    <div className="cowart-object-edit-layer" data-testid={OBJECT_EDIT_TEST_IDS.overlay}>
      {candidate && previewLayout ? (
        <div className="cowart-object-edit-preview" style={previewLayout.frameStyle} aria-hidden="true">
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
          {(phase === 'loading' || phase === 'segmenting') ? (
            <span className="cowart-object-edit-spinner" data-testid={OBJECT_EDIT_TEST_IDS.loading} aria-hidden="true" />
          ) : null}
          <span>{status}</span>
        </div>
        {segments.length > 0 ? <div className="cowart-object-edit-summary">{segments.length} confirmed</div> : null}
        {(phase === 'error' || phase === 'stale' || !support.ok) ? (
          <div className="cowart-object-edit-error" data-testid={OBJECT_EDIT_TEST_IDS.error}>{error || status}</div>
        ) : null}
        {active ? (
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
        ) : null}
      </section>
    </div>
  )
}
