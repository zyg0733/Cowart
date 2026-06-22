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
const AI_IMAGE_STATUSES = ['empty', 'requested', 'generating', 'filled']

const IS_ZH = typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('zh')
const COPY = IS_ZH
  ? { empty: 'AI 图片占位框', requested: '已请求生成', generating: '生成中…', generate: '生成', regenerate: '重生成', hint: '让 Codex 把图片生成到这里' }
  : { empty: 'AI image holder', requested: 'Generation requested', generating: 'Generating…', generate: 'Generate', regenerate: 'Regenerate', hint: 'Ask Codex to generate an image here' }

// A first-class "AI image holder" shape: it knows it is an AI slot, renders
// empty / requested / generating / filled states, owns its image via assetId,
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
    return false
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

  const src = useValue(
    'cowart-ai-image-src',
    () => {
      const asset = assetId ? editor.getAsset(assetId) : null
      return asset?.props?.src ?? null
    },
    [editor, assetId]
  )

  const isFilled = status === 'filled' && src
  const requestGeneration = (event) => {
    stopEventPropagation(event)
    editor.markHistoryStoppingPoint('cowart-ai-image-request')
    editor.updateShape({ id: shape.id, type: COWART_AI_IMAGE_SHAPE, props: { status: 'requested' } })
  }

  return (
    <HTMLContainer
      className={`cowart-ai-image cowart-ai-image--${isFilled ? 'filled' : status}`}
      style={{ width: w, height: h }}
    >
      {isFilled ? (
        <img className="cowart-ai-image__img" src={src} alt={name} draggable={false} />
      ) : (
        <div className="cowart-ai-image__placeholder">
          <div className="cowart-ai-image__label">{name}</div>
          {status === 'generating' ? (
            <div className="cowart-ai-image__spinner" aria-label={COPY.generating} />
          ) : null}
          <div className="cowart-ai-image__state">
            {status === 'generating' ? COPY.generating : status === 'requested' ? COPY.requested : COPY.empty}
          </div>
          {prompt ? <div className="cowart-ai-image__prompt">{prompt}</div> : <div className="cowart-ai-image__hint">{COPY.hint}</div>}
        </div>
      )}

      {status !== 'generating' ? (
        <button
          type="button"
          className="cowart-ai-image__btn"
          onPointerDown={stopEventPropagation}
          onClick={requestGeneration}
          title={isFilled ? COPY.regenerate : COPY.generate}
        >
          {isFilled ? COPY.regenerate : COPY.generate}
        </button>
      ) : null}

      {status === 'requested' ? <span className="cowart-ai-image__badge" aria-hidden="true" /> : null}
    </HTMLContainer>
  )
}
