import { StateNode } from 'tldraw'
import { CowartObjectEditOverlay } from './objectEditOverlay.jsx'
import { OBJECT_EDIT_TEST_IDS, OBJECT_EDIT_TOOL_ID } from './objectEditState.js'

export { CowartObjectEditOverlay, OBJECT_EDIT_TEST_IDS, OBJECT_EDIT_TOOL_ID }

export class CowartObjectEditTool extends StateNode {
  static id = OBJECT_EDIT_TOOL_ID
  static initial = 'idle'

  static children() {
    return [CowartObjectEditIdle]
  }

  onEnter() {
    this.editor.setCursor({ type: 'cross', rotation: 0 })
  }
}

class CowartObjectEditIdle extends StateNode {
  static id = 'idle'
  points = []

  onPointerDown() {
    this.points = [this.editor.inputs.getOriginPagePoint()]
  }

  onPointerMove() {
    if (this.points.length === 0) return
    const point = this.editor.inputs.getCurrentPagePoint()
    const last = this.points[this.points.length - 1]
    if (Math.hypot(point.x - last.x, point.y - last.y) > 3 / this.editor.getZoomLevel()) {
      this.points.push(point)
    }
  }

  onPointerUp() {
    if (this.points.length === 0) return
    const detail = this.points.length > 2
      ? { mode: 'scribble', points: this.points }
      : { mode: 'point', point: this.points[0] }
    window.dispatchEvent(new CustomEvent('cowart-object-edit-input', { detail }))
    this.points = []
  }

  onCancel() {
    window.dispatchEvent(new CustomEvent('cowart-object-edit-cancel'))
    this.points = []
  }
}
