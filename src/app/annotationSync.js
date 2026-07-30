import { ANNOTATION_LABEL_POSITION, ANNOTATION_TOOL_ID } from './annotationTool.jsx'

export function syncAnnotationShapeProps(editor, changes, isSyncingAnnotationShapeRef) {
  if (isSyncingAnnotationShapeRef.current) return

  const updates = []
  for (const [_previous, next] of Object.values(changes.updated)) {
    if (next?.typeName !== 'shape') continue
    if (next.type !== 'arrow') continue
    if (next.meta?.cowartAnnotationArrow !== true) continue

    const props = {}
    if (next.props?.color !== next.props?.labelColor) {
      props.labelColor = next.props.color
    }
    if (next.props?.labelPosition !== ANNOTATION_LABEL_POSITION) {
      props.labelPosition = ANNOTATION_LABEL_POSITION
    }

    if (Object.keys(props).length === 0) continue
    updates.push({ id: next.id, type: 'arrow', props })
  }

  if (updates.length === 0) return

  isSyncingAnnotationShapeRef.current = true
  try {
    editor.updateShapes(updates)
  } finally {
    isSyncingAnnotationShapeRef.current = false
  }
}

export function restoreAnnotationToolAfterEditing(editor, changes) {
  for (const [previous, next] of Object.values(changes.updated)) {
    if (previous?.typeName !== 'instance_page_state') continue
    if (!previous.editingShapeId || next.editingShapeId) continue

    const shape = editor.getShape(previous.editingShapeId)
    if (shape?.meta?.cowartAnnotationArrow !== true) continue

    editor.timers.requestAnimationFrame(() => {
      if (editor.getEditingShapeId()) return
      if (editor.getCurrentToolId() !== 'select') return
      editor.setCurrentTool(ANNOTATION_TOOL_ID)
    })
  }
}
