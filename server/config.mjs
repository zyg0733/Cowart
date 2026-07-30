import { join, resolve } from 'node:path'

export const projectDir = resolve(process.env.COWART_PROJECT_DIR ?? process.cwd())
export const canvasDir = resolve(process.env.COWART_CANVAS_DIR ?? join(projectDir, 'canvas'))
export const canvasFile = join(canvasDir, 'cowart-canvas.json')
export const selectionFile = join(canvasDir, 'cowart-selection.json')
export const viewStateFile = join(canvasDir, 'cowart-view-state.json')
export const revisionFile = join(canvasDir, 'cowart-canvas-revision.json')
export const canvasPagesDir = join(canvasDir, 'pages')
export const canvasAssetsDir = join(canvasDir, 'assets')
export const pagesManifestFile = join(canvasPagesDir, 'manifest.json')
export const canvasFileName = 'cowart-canvas.json'
export const pageIdPrefix = 'page:'
export const globalAssetsRoute = '/assets/'
export const pageAssetsRoute = '/page-assets/'
export const segmentBodyLimitBytes = 32 * 1024 * 1024
