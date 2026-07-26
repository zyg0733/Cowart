import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CowartAiImageShapeUtil } from './CowartAiImageShape.jsx'
import { CowartObjectEditTool } from './objectEditTool.js'
import {
  loadInitialCanvas
} from './app/canvasRemote.js'
import { setupCowartCanvasSession } from './app/canvasSession.js'
import {
  CowartAgentToast,
  CowartEmptyOverlay,
  ONBOARDING_DISMISSED_KEY,
  readOnboardingDismissed
} from './app/onboarding.jsx'
import {
  CowartAnnotationTool
} from './app/annotationTool.jsx'
import {
  cowartComponents,
  cowartUiOverrides
} from './app/tldrawUi.jsx'

export default function App() {
  const [snapshot, setSnapshot] = useState()
  const [viewState, setViewState] = useState()
  const [loadError, setLoadError] = useState(null)
  const [isCanvasEmpty, setIsCanvasEmpty] = useState(false)
  const [onboardingDismissed, setOnboardingDismissed] = useState(readOnboardingDismissed)
  const [agentActivity, setAgentActivity] = useState(null)
  const revisionRef = useRef(null)
  const editorRef = useRef(null)

  useEffect(() => {
    if (!agentActivity) return
    const timer = window.setTimeout(() => setAgentActivity(null), 6000)
    return () => window.clearTimeout(timer)
  }, [agentActivity])

  const dismissOnboarding = useCallback(() => {
    setOnboardingDismissed(true)
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1')
    } catch {
      // ignore storage failures; dismissal still holds for this session
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    async function loadCanvas() {
      try {
        const { canvasData, viewStateData } = await loadInitialCanvas(controller)
        revisionRef.current = canvasData.revision ?? null
        setSnapshot(canvasData.snapshot ?? null)
        setViewState(viewStateData.viewState ?? null)
      } catch (error) {
        if (error.name === 'AbortError') return
        setLoadError(error)
        setSnapshot(null)
        setViewState(null)
      }
    }

    loadCanvas()
    return () => controller.abort()
  }, [])

  const handleMount = useCallback((editor) => {
    return setupCowartCanvasSession(editor, {
      editorRef,
      revisionRef,
      setAgentActivity,
      setIsCanvasEmpty,
      viewState
    })
  }, [viewState])

  if (snapshot === undefined || viewState === undefined) {
    return (
      <main className="cowart-status" aria-live="polite">
        Loading canvas...
      </main>
    )
  }

  if (loadError) {
    return (
      <main className="cowart-status" aria-live="polite">
        Canvas file could not be loaded.
      </main>
    )
  }

  return (
    <main className="cowart-canvas" aria-label="Cowart infinite canvas">
      <Tldraw
        snapshot={snapshot ?? undefined}
        inferDarkMode
        onMount={handleMount}
        overrides={cowartUiOverrides}
        components={cowartComponents}
        shapeUtils={[CowartAiImageShapeUtil]}
        tools={[CowartAnnotationTool, CowartObjectEditTool]}
      />
      {isCanvasEmpty && !onboardingDismissed && (
        <CowartEmptyOverlay onDismiss={dismissOnboarding} />
      )}
      {agentActivity && (
        <CowartAgentToast
          activity={agentActivity}
          onLocate={() => {
            const editor = editorRef.current
            if (editor && agentActivity.shapeIds?.length) {
              editor.setCurrentTool('select')
              editor.select(...agentActivity.shapeIds)
              editor.zoomToSelection({ animation: { duration: 320 } })
            }
            setAgentActivity(null)
          }}
          onDismiss={() => setAgentActivity(null)}
        />
      )}
    </main>
  )
}
