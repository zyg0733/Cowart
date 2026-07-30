import {
  ArrowDownToolbarItem,
  ArrowLeftToolbarItem,
  ArrowRightToolbarItem,
  ArrowToolbarItem,
  ArrowUpToolbarItem,
  AssetToolbarItem,
  CheckBoxToolbarItem,
  CloudToolbarItem,
  DefaultToolbar,
  DiamondToolbarItem,
  DrawToolbarItem,
  EllipseToolbarItem,
  EraserToolbarItem,
  FrameToolbarItem,
  HandToolbarItem,
  HeartToolbarItem,
  HexagonToolbarItem,
  HighlightToolbarItem,
  LaserToolbarItem,
  LineToolbarItem,
  NoteToolbarItem,
  OvalToolbarItem,
  RectangleToolbarItem,
  RhombusToolbarItem,
  SelectToolbarItem,
  StarToolbarItem,
  TextToolbarItem,
  TldrawUiInFrontOfTheCanvas,
  TldrawUiMenuToolItem,
  TriangleToolbarItem,
  XBoxToolbarItem,
  useEditor,
  useValue
} from 'tldraw'
import { AI_IMAGE_HOLDER_LABEL } from '../CowartAiImageShape.jsx'
import { CowartObjectEditOverlay, OBJECT_EDIT_TEST_IDS, OBJECT_EDIT_TOOL_ID } from '../objectEditTool.js'
import { AI_IMAGE_TOOL_ID, createAiImageHolderAtViewportCenter, handleAiImageHolderDrag } from './aiImageHolder.js'
import {
  ANNOTATION_TOOL_ID,
  ANNOTATION_TOOL_LABEL,
  annotationToolIcon,
  unlockGlobalToolLock
} from './annotationTool.jsx'

const OBJECT_EDIT_TOOL_LABEL = '对象'

export const cowartUiOverrides = {
  translations: {
    en: {
      'tool.ai-image': AI_IMAGE_HOLDER_LABEL,
      'tool.cowart-annotation': ANNOTATION_TOOL_LABEL,
      'tool.cowart-object-edit': OBJECT_EDIT_TOOL_LABEL
    },
    'zh-cn': {
      'tool.ai-image': AI_IMAGE_HOLDER_LABEL,
      'tool.cowart-annotation': ANNOTATION_TOOL_LABEL,
      'tool.cowart-object-edit': OBJECT_EDIT_TOOL_LABEL
    }
  },
  tools(editor, tools) {
    return {
      ...tools,
      arrow: {
        ...tools.arrow,
        kbd: undefined
      },
      [AI_IMAGE_TOOL_ID]: {
        id: AI_IMAGE_TOOL_ID,
        label: 'tool.ai-image',
        icon: 'tool-frame',
        kbd: 'a',
        onSelect() {
          createAiImageHolderAtViewportCenter(editor)
        },
        onDragStart(_source, info) {
          handleAiImageHolderDrag(editor, info)
        },
        meta: {
          cowartTool: 'ai-image-holder'
        }
      },
      [ANNOTATION_TOOL_ID]: {
        id: ANNOTATION_TOOL_ID,
        label: 'tool.cowart-annotation',
        icon: annotationToolIcon,
        kbd: 'c',
        onSelect() {
          unlockGlobalToolLock(editor)
          editor.setCurrentTool(ANNOTATION_TOOL_ID)
        },
        meta: {
          cowartTool: 'annotation'
        }
      },
      [OBJECT_EDIT_TOOL_ID]: {
        id: OBJECT_EDIT_TOOL_ID,
        label: 'tool.cowart-object-edit',
        icon: 'tool-screenshot',
        kbd: 'o',
        onSelect() {
          unlockGlobalToolLock(editor)
          editor.setCurrentTool(OBJECT_EDIT_TOOL_ID)
        },
        meta: {
          cowartTool: 'object-edit'
        }
      }
    }
  }
}

export const cowartComponents = {
  Toolbar: CowartToolbar,
  InFrontOfTheCanvas: CowartCanvasOverlay
}

function CowartToolbarItem({ toolId }) {
  const editor = useEditor()
  const isSelected = useValue(
    `is ${toolId} selected`,
    () => editor.getCurrentToolId() === toolId,
    [editor, toolId]
  )

  return <TldrawUiMenuToolItem toolId={toolId} isSelected={isSelected} />
}

function CowartAnnotationToolbarItem() {
  const editor = useEditor()
  const isSelected = useValue(
    'is annotation selected',
    () => editor.getCurrentToolId() === ANNOTATION_TOOL_ID,
    [editor]
  )

  return (
    <button
      aria-label={ANNOTATION_TOOL_LABEL}
      aria-pressed={isSelected ? 'true' : 'false'}
      className="tlui-button tlui-button__tool cowart-annotation-toolbar-button"
      data-testid={`tools.${ANNOTATION_TOOL_ID}`}
      data-value={ANNOTATION_TOOL_ID}
      draggable={false}
      onClick={() => {
        unlockGlobalToolLock(editor)
        editor.setCurrentTool(ANNOTATION_TOOL_ID)
      }}
      onTouchStart={(event) => {
        event.preventDefault()
        unlockGlobalToolLock(editor)
        editor.setCurrentTool(ANNOTATION_TOOL_ID)
      }}
      title={ANNOTATION_TOOL_LABEL}
      type="button"
    >
      {annotationToolIcon}
      <span className="cowart-annotation-toolbar-label" draggable={false}>
        {ANNOTATION_TOOL_LABEL}
      </span>
    </button>
  )
}

function CowartObjectEditToolbarItem() {
  const editor = useEditor()
  const isSelected = useValue(
    'is object edit selected',
    () => editor.getCurrentToolId() === OBJECT_EDIT_TOOL_ID,
    [editor]
  )

  return (
    <button
      aria-label={OBJECT_EDIT_TOOL_LABEL}
      aria-pressed={isSelected ? 'true' : 'false'}
      className="tlui-button tlui-button__tool cowart-object-edit-toolbar-button"
      data-testid={OBJECT_EDIT_TEST_IDS.tool}
      data-value={OBJECT_EDIT_TOOL_ID}
      draggable={false}
      onClick={() => {
        unlockGlobalToolLock(editor)
        editor.setCurrentTool(OBJECT_EDIT_TOOL_ID)
      }}
      onTouchStart={(event) => {
        event.preventDefault()
        unlockGlobalToolLock(editor)
        editor.setCurrentTool(OBJECT_EDIT_TOOL_ID)
      }}
      title={OBJECT_EDIT_TOOL_LABEL}
      type="button"
    >
      <span className="cowart-object-edit-tool-icon" aria-hidden="true" />
      <span className="cowart-object-edit-toolbar-label" draggable={false}>
        {OBJECT_EDIT_TOOL_LABEL}
      </span>
    </button>
  )
}

function CowartToolbarDivider() {
  return <div aria-orientation="vertical" className="cowart-toolbar-divider" role="separator" />
}

function CowartCanvasOverlay() {
  return (
    <>
      <TldrawUiInFrontOfTheCanvas />
      <CowartObjectEditOverlay />
    </>
  )
}

function CowartToolbar(props) {
  return (
    <DefaultToolbar {...props} maxItems={9}>
      <CowartAnnotationToolbarItem />
      <CowartObjectEditToolbarItem />
      <CowartToolbarDivider />
      <SelectToolbarItem />
      <HandToolbarItem />
      <CowartToolbarItem toolId={AI_IMAGE_TOOL_ID} />
      <CowartToolbarDivider />
      <AssetToolbarItem />
      <DrawToolbarItem />
      <EraserToolbarItem />
      <TextToolbarItem />
      <ArrowToolbarItem />
      <NoteToolbarItem />
      <RectangleToolbarItem />
      <EllipseToolbarItem />
      <TriangleToolbarItem />
      <DiamondToolbarItem />
      <HexagonToolbarItem />
      <OvalToolbarItem />
      <RhombusToolbarItem />
      <StarToolbarItem />
      <CloudToolbarItem />
      <HeartToolbarItem />
      <XBoxToolbarItem />
      <CheckBoxToolbarItem />
      <ArrowLeftToolbarItem />
      <ArrowUpToolbarItem />
      <ArrowDownToolbarItem />
      <ArrowRightToolbarItem />
      <LineToolbarItem />
      <HighlightToolbarItem />
      <LaserToolbarItem />
      <FrameToolbarItem />
    </DefaultToolbar>
  )
}
