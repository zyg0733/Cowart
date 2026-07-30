import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { localizePageAssets } from './asset-localization.mjs'
import { canvasDir, canvasFile, canvasFileName, canvasPagesDir, pagesManifestFile, revisionFile } from './config.mjs'
import { isSnapshot } from './http.mjs'
import { getPageRecords, pageDirName, pageFilePath, snapshotForPage } from './page-snapshots.mjs'

let canvasWriteChain = Promise.resolve()
let canvasRevision = null
let atomicWriteCounter = 0

export function withCanvasWriteLock(task) {
  const run = canvasWriteChain.then(task, task)
  canvasWriteChain = run.then(
    () => {},
    () => {}
  )
  return run
}

export async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function readPageSnapshots() {
  let entries
  try {
    entries = await readdir(canvasPagesDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const snapshots = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const filePath = join(canvasPagesDir, entry.name, canvasFileName)
    try {
      const snapshot = await readJsonFile(filePath)
      if (isSnapshot(snapshot)) snapshots.push({ filePath, snapshot })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return snapshots
}

export async function loadCanvasSnapshot() {
  const pageSnapshots = await readPageSnapshots()
  if (pageSnapshots.length > 0) {
    const [{ snapshot: firstSnapshot }] = pageSnapshots
    const mergedSnapshot = {
      schema: firstSnapshot.schema,
      store: {}
    }

    for (const { snapshot } of pageSnapshots) {
      Object.assign(mergedSnapshot.store, snapshot.store)
    }
    return {
      snapshot: mergedSnapshot,
      path: canvasPagesDir,
      storage: 'per-page'
    }
  }

  try {
    return {
      snapshot: await readJsonFile(canvasFile),
      path: canvasFile,
      storage: 'legacy-single-file'
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { snapshot: null, path: canvasPagesDir, storage: 'empty' }
    }
    throw error
  }
}

export async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true })
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.${atomicWriteCounter++}.tmp`
  try {
    await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`)
    await rename(tempFile, filePath)
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {})
    throw error
  }
}

export async function loadCanvasRevision() {
  if (canvasRevision !== null) return canvasRevision
  try {
    const stored = await readJsonFile(revisionFile)
    canvasRevision = Number.isInteger(stored?.revision) ? stored.revision : 0
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Cowart: could not read canvas revision file, resetting to 0.', error)
    }
    canvasRevision = 0
  }
  return canvasRevision
}

export async function bumpCanvasRevision() {
  const next = (await loadCanvasRevision()) + 1
  canvasRevision = next
  await writeJsonAtomic(revisionFile, { revision: next })
  return next
}

async function removeStalePageDirs(currentPageIds) {
  let entries
  try {
    entries = await readdir(canvasPagesDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }

  const currentDirNames = new Set([...currentPageIds].map(pageDirName))
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !currentDirNames.has(entry.name))
      .map((entry) => rm(join(canvasPagesDir, entry.name), { recursive: true, force: true }))
  )
}

export async function saveCanvasSnapshot(snapshot) {
  const pages = getPageRecords(snapshot)
  if (pages.length === 0) {
    await writeJsonAtomic(canvasFile, snapshot)
    return { storage: 'legacy-single-file', paths: [canvasFile] }
  }
  pages.forEach((page) => pageDirName(page.id))

  const currentPageIds = new Set(pages.map((page) => page.id))
  await removeStalePageDirs(currentPageIds)

  const paths = []
  for (const page of pages) {
    const filePath = pageFilePath(page.id)
    const pageSnapshot = await localizePageAssets(snapshotForPage(snapshot, page), page.id)
    await writeJsonAtomic(filePath, pageSnapshot)
    paths.push(filePath)
  }

  const manifest = {
    version: 1,
    source: 'cowart',
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      index: page.index,
      path: relative(canvasDir, pageFilePath(page.id))
    }))
  }
  await writeJsonAtomic(pagesManifestFile, manifest)

  return { storage: 'per-page', paths }
}
