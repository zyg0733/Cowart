import {
  createShapeId,
  onDragFromToolbarToCreateShape
} from 'tldraw'
import {
  AI_IMAGE_HOLDER_DEFAULT_H,
  AI_IMAGE_HOLDER_DEFAULT_W,
  AI_IMAGE_HOLDER_LABEL,
  COWART_AI_IMAGE_SHAPE
} from '../CowartAiImageShape.jsx'

export const AI_IMAGE_TOOL_ID = 'ai-image'

export function getAiImageHolderMeta() {
  return {
    cowartAiImageHolder: true,
    cowartAiImageHolderVersion: 1
  }
}

export function createAiImageHolderShape(editor, id, shapeOverrides = {}) {
  const scale = editor.getResizeScaleFactor()
  const { meta, props, ...shapeRecordOverrides } = shapeOverrides
  const { scale: _scale, color: _color, ...holderProps } = props ?? {}

  return editor.createShape({
    ...shapeRecordOverrides,
    id,
    type: COWART_AI_IMAGE_SHAPE,
    meta: {
      ...getAiImageHolderMeta(),
      ...meta
    },
    props: {
      w: AI_IMAGE_HOLDER_DEFAULT_W * scale,
      h: AI_IMAGE_HOLDER_DEFAULT_H * scale,
      name: AI_IMAGE_HOLDER_LABEL,
      ...holderProps
    }
  })
}

export function createAiImageHolderAtViewportCenter(editor) {
  const scale = editor.getResizeScaleFactor()
  const w = AI_IMAGE_HOLDER_DEFAULT_W * scale
  const h = AI_IMAGE_HOLDER_DEFAULT_H * scale
  const center = editor.getViewportPageBounds().center
  const id = createShapeId()

  createAiImageHolderShape(editor, id, {
    x: center.x - w / 2,
    y: center.y - h / 2,
    props: { w, h }
  })
  editor.select(id)
  editor.setCurrentTool('select.idle')
}

export function handleAiImageHolderDrag(editor, info) {
  const scale = editor.getResizeScaleFactor()
  onDragFromToolbarToCreateShape(editor, info, {
    createShape: (id) =>
      createAiImageHolderShape(editor, id, {
        props: {
          w: AI_IMAGE_HOLDER_DEFAULT_W * scale,
          h: AI_IMAGE_HOLDER_DEFAULT_H * scale
        }
      }),
    onDragEnd: (id) => editor.select(id)
  })
}
