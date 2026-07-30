import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  resizeBox,
  stopEventPropagation,
  useEditor,
  useValue
} from 'tldraw'

export const COWART_AI_IMAGE_SHAPE = 'cowart-ai-image'
export const AI_IMAGE_HOLDER_LABEL = 'AI 图片'
export const AI_IMAGE_HOLDER_DEFAULT_W = 320
export const AI_IMAGE_HOLDER_DEFAULT_H = 220
const AI_IMAGE_STATUSES = ['empty', 'requested', 'generating', 'failed', 'filled']
const ERROR_MESSAGE_MAX_LENGTH = 240
let fallbackRequestCounter = 0

const IS_ZH = typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('zh')
const COPY = IS_ZH
  ? {
      empty: 'AI 图片占位框',
      requested: '已排队',
      generating: '生成中',
      failed: '生成失败',
      generate: '生成',
      regenerate: '重生成',
      retry: '重试',
      cancel: '取消',
      hint: '让 Codex 把图片生成到这里',
      edit: '编辑 prompt',
      promptPlaceholder: '描述要生成的图片…',
      defaultError: '生成失败。请重试。'
    }
  : {
      empty: 'AI image holder',
      requested: 'Queued',
      generating: 'Generating',
      failed: 'Generation failed',
      generate: 'Generate',
      regenerate: 'Regenerate',
      retry: 'Retry',
      cancel: 'Cancel',
      hint: 'Ask Codex to generate an image here',
      edit: 'Edit prompt',
      promptPlaceholder: 'Describe the image to generate…',
      defaultError: 'Generation failed. Try again.'
    }

function createCowartRequestId() {
  const crypto = globalThis.crypto
  if (typeof crypto?.randomUUID === 'function') {
    try {
      return `cowart-request-${crypto.randomUUID()}`
    } catch (error) {
      void error
    }
  }

  fallbackRequestCounter += 1
  return [
    'cowart-request',
    Date.now().toString(36),
    fallbackRequestCounter.toString(36),
    Math.random().toString(36).slice(2, 10)
  ].join('-')
}

function finiteAttempt(value) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function getNextRequestAttempt(meta) {
  return Math.max(
    finiteAttempt(meta?.cowartRequest?.attempt),
    finiteAttempt(meta?.cowartLastRequest?.attempt)
  ) + 1
}

function getCappedErrorMessage(meta) {
  const message = meta?.cowartRequest?.error?.message
  if (typeof message !== 'string' || message.trim().length === 0) return ''
  return message.slice(0, ERROR_MESSAGE_MAX_LENGTH)
}

function archiveActiveRequest(meta, patch) {
  const activeRequest = meta?.cowartRequest
  if (!activeRequest || typeof activeRequest !== 'object') return null
  return {
    ...activeRequest,
    ...patch
  }
}

function replaceCowartAiImageShape(editor, shape, { meta, props }) {
  editor.store.put([
    {
      ...shape,
      meta: meta ?? shape.meta,
      props: {
        ...shape.props,
        ...props
      }
    }
  ])
}

// A first-class "AI image holder" shape: it knows it is an AI slot, renders
// empty / requested / generating / failed / filled states, owns its image via assetId,
// and exposes a button that flags a (re)generation request for the agent to
// service on its next turn (Codex is request/response — there is no daemon).
export class CowartAiImageShapeUtil extends ShapeUtil {
  static type = COWART_AI_IMAGE_SHAPE

  static props = {
    w: T.number,
    h: T.number,
    name: T.string,
    prompt: T.string,
    status: T.literalEnum(...AI_IMAGE_STATUSES),
    assetId: T.string.nullable()
  }

  getDefaultProps() {
    return {
      w: AI_IMAGE_HOLDER_DEFAULT_W,
      h: AI_IMAGE_HOLDER_DEFAULT_H,
      name: AI_IMAGE_HOLDER_LABEL,
      prompt: '',
      status: 'empty',
      assetId: null
    }
  }

  canEdit() {
    return true
  }

  canResize() {
    return true
  }

  isAspectRatioLocked() {
    return false
  }

  getGeometry(shape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  onResize(shape, info) {
    return resizeBox(shape, info)
  }

  component(shape) {
    return <CowartAiImageComponent shape={shape} />
  }

  indicator(shape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={10} ry={10} />
  }

  // tldraw 5 renders selection/hover outlines via a single SVG path overlay that
  // calls getIndicatorPath on each shape util; without it the overlay crashes.
  getIndicatorPath(shape) {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }
}

function CowartAiImageComponent({ shape }) {
  const editor = useEditor()
  const { w, h, name, prompt, status, assetId } = shape.props
  const meta = shape.meta ?? {}

  const src = useValue(
    'cowart-ai-image-src',
    () => {
      const asset = assetId ? editor.getAsset(assetId) : null
      return asset?.props?.src ?? null
    },
    [editor, assetId]
  )
  const isEditing = useValue('cowart-ai-image-editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])

  const isFilled = status === 'filled' && src
  const hasActiveRequest = Boolean(meta.cowartRequest?.id)
  const visibleStatus = isFilled ? 'filled' : status
  const statusLabel = COPY[visibleStatus] ?? COPY.empty
  const errorMessage = status === 'failed' ? getCappedErrorMessage(meta) || COPY.defaultError : ''
  const domId = shape.id.replace(/[^A-Za-z0-9_-]/g, '-')
  const statusId = `cowart-ai-status-${domId}`
  const errorId = `cowart-ai-error-${domId}`
  const statusIsAnnounced = status === 'requested' || status === 'generating' || status === 'failed'
  const describedBy = [statusIsAnnounced ? statusId : null, errorMessage ? errorId : null].filter(Boolean).join(' ') || undefined

  const requestGeneration = (event) => {
    stopEventPropagation(event)
    if (status === 'requested' || status === 'generating') return

    const requestedAt = new Date().toISOString()
    const request = {
      id: createCowartRequestId(),
      requestedAt,
      attempt: getNextRequestAttempt(meta),
      kind: meta.cowartVariant ? 'variant' : meta.cowartObjectAction ? 'object_action' : 'image_generation'
    }
    if (meta.cowartObjectAction) request.objectAction = meta.cowartObjectAction
    if (meta.cowartVariant) request.variant = meta.cowartVariant
    const nextMeta = {
      ...meta,
      cowartRequest: request
    }
    const archivedRequest = archiveActiveRequest(meta, { supersededAt: requestedAt })
    if (archivedRequest) nextMeta.cowartLastRequest = archivedRequest

    editor.markHistoryStoppingPoint('cowart-ai-image-request')
    replaceCowartAiImageShape(editor, shape, { meta: nextMeta, props: { status: 'requested' } })
  }
  const cancelRequest = (event) => {
    stopEventPropagation(event)
    if (status !== 'requested' && status !== 'generating') return

    const nextMeta = { ...meta }
    const archivedRequest = archiveActiveRequest(meta, { cancelledAt: new Date().toISOString() })
    if (archivedRequest) nextMeta.cowartLastRequest = archivedRequest
    delete nextMeta.cowartRequest

    editor.markHistoryStoppingPoint('cowart-ai-image-cancel-request')
    replaceCowartAiImageShape(editor, shape, { meta: nextMeta, props: { status: assetId ? 'filled' : 'empty' } })
  }
  const startEditing = (event) => {
    stopEventPropagation(event)
    editor.setEditingShape(shape.id)
  }

  return (
    <HTMLContainer
      className={`cowart-ai-image cowart-ai-image--${isFilled ? 'filled' : status}${isEditing ? ' cowart-ai-image--editing' : ''}`}
      role="group"
      aria-label={`${name}: ${statusLabel}`}
      aria-describedby={describedBy}
      style={{ width: w, height: h }}
    >
      {isFilled ? (
        <img className="cowart-ai-image__img" src={src} alt={name} draggable={false} />
      ) : (
        <div className="cowart-ai-image__placeholder">
          {statusIsAnnounced ? (
            <div id={statusId} className="cowart-ai-image__status-chip" role="status" aria-live="polite">
              {statusLabel}
            </div>
          ) : null}
          <div className="cowart-ai-image__label">{name}</div>
          {status === 'generating' ? (
            <div className="cowart-ai-image__spinner" aria-hidden="true" />
          ) : null}
          <div className="cowart-ai-image__state">{statusLabel}</div>
          {prompt ? <div className="cowart-ai-image__prompt">{prompt}</div> : <div className="cowart-ai-image__hint">{COPY.hint}</div>}
          {errorMessage ? <div id={errorId} className="cowart-ai-image__error">{errorMessage}</div> : null}
        </div>
      )}

      {isEditing ? (
        <textarea
          className="cowart-ai-image__editor"
          autoFocus
          defaultValue={prompt}
          placeholder={COPY.promptPlaceholder}
          onPointerDown={stopEventPropagation}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') editor.setEditingShape(null)
          }}
          onChange={(event) =>
            editor.updateShape({ id: shape.id, type: COWART_AI_IMAGE_SHAPE, props: { prompt: event.target.value } })
          }
          onBlur={() => editor.setEditingShape(null)}
        />
      ) : null}

      {!isEditing ? (
        <div className="cowart-ai-image__actions">
          {status !== 'generating' ? (
            <button
              type="button"
              className="cowart-ai-image__btn cowart-ai-image__btn--ghost"
              onPointerDown={stopEventPropagation}
              onClick={startEditing}
              title={COPY.edit}
            >
              {COPY.edit}
            </button>
          ) : null}
          {status === 'requested' || status === 'generating' ? (
            <button
              type="button"
              className="cowart-ai-image__btn cowart-ai-image__btn--danger"
              onPointerDown={stopEventPropagation}
              onClick={cancelRequest}
              title={COPY.cancel}
            >
              {COPY.cancel}
            </button>
          ) : (
            <button
              type="button"
              className="cowart-ai-image__btn"
              onPointerDown={stopEventPropagation}
              onClick={requestGeneration}
              title={status === 'failed' ? COPY.retry : isFilled ? COPY.regenerate : COPY.generate}
              disabled={hasActiveRequest && (status === 'requested' || status === 'generating')}
            >
              {status === 'failed' ? COPY.retry : isFilled ? COPY.regenerate : COPY.generate}
            </button>
          )}
        </div>
      ) : null}
    </HTMLContainer>
  )
}
