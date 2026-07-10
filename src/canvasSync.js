// Pure canvas-sync helpers, deliberately free of tldraw/DOM imports so they can
// be unit-tested in plain Node. App.jsx wraps these around the live editor.

export function isCanvasSnapshot(value) {
  return value && typeof value === 'object' && value.store && value.schema
}

export function recordsAreEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

// True if the current document store diverges from a baseline snapshot taken
// earlier (added, removed, or changed records).
export function storeDiffersFromBaseline(currentStore, baselineStore) {
  const baselineIds = new Set(Object.keys(baselineStore))

  for (const [id, baselineRecord] of Object.entries(baselineStore)) {
    const currentRecord = currentStore[id]
    if (!currentRecord) return true
    if (!recordsAreEqual(currentRecord, baselineRecord)) return true
  }

  for (const id of Object.keys(currentStore)) {
    if (!baselineIds.has(id)) return true
  }

  return false
}

/**
 * Decide how to reconcile the local document store with a remote snapshot.
 *
 * - `recordsToPut`: remote records to add/overwrite locally.
 * - `idsToRemove`: local records the remote no longer has (deletions to mirror).
 * - `switchToPageId`: a surviving page to move to before removing the current
 *   page, when the page being viewed was deleted remotely.
 *
 * Deletions are only computed when we are NOT preserving local changes. While
 * the user has unsaved local edits we never remove records, because a local
 * record missing from remote could be brand-new local work rather than a remote
 * deletion. In the preserve case we also never overwrite differing local records.
 */
export function diffRemoteSnapshot(localStore, remoteStore, { preserveLocalChanges = false, currentPageId = null } = {}) {
  const recordsToPut = Object.values(remoteStore).filter((record) => {
    const localRecord = localStore[record.id]
    if (!localRecord) return true
    if (preserveLocalChanges) return false
    return !recordsAreEqual(localRecord, record)
  })

  let idsToRemove = []
  let switchToPageId = null

  if (!preserveLocalChanges) {
    idsToRemove = Object.keys(localStore).filter((id) => !remoteStore[id])

    if (currentPageId && idsToRemove.includes(currentPageId)) {
      const survivingPage = Object.values(remoteStore).find((record) => record?.typeName === 'page')
      if (survivingPage) {
        switchToPageId = survivingPage.id
      } else {
        // Nothing to fall back to: keep the current page so the editor stays valid.
        idsToRemove = idsToRemove.filter((id) => id !== currentPageId)
      }
    }
  }

  return { recordsToPut, idsToRemove, switchToPageId }
}
