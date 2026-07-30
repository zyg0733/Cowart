import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { CowartPageAssetPathError, assertCowartAssetWritableDestination, resolveCowartAssetUrlPath } from '../shared/cowart-page-assets.mjs'
import { canvasAssetsDir, canvasPagesDir, globalAssetsRoute, pageAssetsRoute } from './config.mjs'
import { pageAssetUrl, pageAssetsDir, pageDirName } from './page-snapshots.mjs'

const mimeTypes = new Map([
  ['.apng', 'image/apng'],
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp']
])

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function extensionFromMimeType(mimeType) {
  switch (mimeType) {
    case 'image/apng':
      return '.apng'
    case 'image/avif':
      return '.avif'
    case 'image/gif':
      return '.gif'
    case 'image/jpeg':
      return '.jpg'
    case 'image/png':
      return '.png'
    case 'image/svg+xml':
      return '.svg'
    case 'image/webp':
      return '.webp'
    default:
      return '.bin'
  }
}

function safeExtension(rawName, mimeType) {
  const extension = extname(rawName)
  if (/^\.[a-zA-Z0-9]{1,12}$/.test(extension)) return extension
  return extensionFromMimeType(mimeType)
}

function sanitizeAssetFileName(name, fallbackName, mimeType) {
  const rawName = basename(String(name || fallbackName || 'asset'))
  const rawExtension = extname(rawName)
  const extension = safeExtension(rawName, mimeType)
  const baseName = rawName
    .slice(0, rawName.length - rawExtension.length)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${baseName || 'asset'}${extension}`
}

function safeAssetNamePart(value) {
  return String(value || 'asset')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'asset'
}

function reserveAssetFileName(fileName, assetId, digest, reservations) {
  const key = `${assetId}:${digest}`
  const extension = extname(fileName)
  const baseName = fileName.slice(0, fileName.length - extension.length) || 'asset'
  let candidate = fileName
  if (reservations.has(candidate) && reservations.get(candidate) !== key) {
    candidate = `${baseName}-${safeAssetNamePart(assetId)}-${digest.slice(0, 12)}${extension}`
  }
  let counter = 2
  while (reservations.has(candidate) && reservations.get(candidate) !== key) {
    candidate = `${baseName}-${safeAssetNamePart(assetId)}-${digest.slice(0, 12)}-${counter++}${extension}`
  }
  reservations.set(candidate, key)
  return candidate
}

function parseDataUrl(src) {
  const match = /^data:([^;,]+)?(?:;[^,]*)?,(.*)$/s.exec(src)
  if (!match) return null
  const mimeType = match[1] || 'application/octet-stream'
  const encoded = match[2]
  const isBase64 = /^data:[^,]*;base64,/i.test(src)
  const buffer = isBase64 ? Buffer.from(encoded, 'base64') : Buffer.from(decodeURIComponent(encoded))
  return { buffer, mimeType }
}

export async function localAssetFilePathFromUrl(src) {
  if (typeof src !== 'string') return null
  return resolveCowartAssetUrlPath(src, {
    globalAssetsDir: canvasAssetsDir,
    canvasPagesDir,
    globalAssetsRoute,
    pageAssetsRoute
  })
}

export async function localAssetBytesFromUrl(src) {
  try {
    const filePath = await localAssetFilePathFromUrl(src)
    if (!filePath) return null
    return { filePath, bytes: await readFile(filePath) }
  } catch (error) {
    if (error instanceof CowartPageAssetPathError || error.code === 'ENOENT' || error.code === 'ELOOP') return null
    throw error
  }
}

async function writePageAssetAtomic(destinationPath, bytes) {
  const destinationDir = dirname(destinationPath)
  const destinationRoot = canvasPagesDir
  const tempPath = join(destinationDir, `.${basename(destinationPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`)
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  let handle = null

  await mkdir(destinationDir, { recursive: true })
  await assertCowartAssetWritableDestination(destinationRoot, destinationPath)
  try {
    handle = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow, 0o600)
    await handle.writeFile(bytes)
    await handle.close()
    handle = null
    await assertCowartAssetWritableDestination(destinationRoot, destinationPath)
    await rename(tempPath, destinationPath)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await rm(tempPath, { force: true }).catch(() => {})
    if (error.code === 'ELOOP') {
      throw new CowartPageAssetPathError('asset_path_symlink', 'Asset paths may not traverse symlinks.', 403)
    }
    throw error
  }
}

async function localizePageAsset(asset, pageId, reservations) {
  const src = asset?.props?.src
  if (!src || typeof src !== 'string' || /^https?:\/\//.test(src)) return asset

  const currentPagePrefix = `${pageAssetsRoute}${pageDirName(pageId)}/`
  if (src.startsWith(currentPagePrefix)) {
    const local = await localAssetBytesFromUrl(src)
    if (!local) return asset
    const localizedAsset = structuredClone(asset)
    localizedAsset.meta = { ...(localizedAsset.meta ?? {}), cowartSha256: sha256(local.bytes) }
    localizedAsset.props.fileSize = local.bytes.length
    return localizedAsset
  }

  const localizedAsset = structuredClone(asset)
  const dataUrl = src.startsWith('data:') ? parseDataUrl(src) : null
  const localSource = dataUrl ? null : await localAssetBytesFromUrl(src)
  if (!dataUrl && !localSource) return localizedAsset
  const bytes = dataUrl?.buffer ?? localSource.bytes
  const digest = sha256(bytes)

  const baseFileName = sanitizeAssetFileName(
    dataUrl ? null : localizedAsset.props.name,
    localSource ? basename(localSource.filePath) : localizedAsset.id.replace(':', '-'),
    dataUrl?.mimeType ?? localizedAsset.props.mimeType
  )
  const fileName = reserveAssetFileName(baseFileName, localizedAsset.id, digest, reservations)
  const destinationDir = pageAssetsDir(pageId)
  const destinationPath = join(destinationDir, fileName)

  await writePageAssetAtomic(destinationPath, bytes)
  if (dataUrl) localizedAsset.props.mimeType = localizedAsset.props.mimeType ?? dataUrl.mimeType

  localizedAsset.props.name = fileName
  localizedAsset.props.src = pageAssetUrl(pageId, fileName)
  localizedAsset.props.fileSize = bytes.length
  localizedAsset.meta = { ...(localizedAsset.meta ?? {}), cowartSha256: digest }
  return localizedAsset
}

export async function localizePageAssets(pageSnapshot, pageId) {
  const entries = []
  const reservations = new Map()
  for (const [id, record] of Object.entries(pageSnapshot.store)) {
    if (record?.typeName !== 'asset') {
      entries.push([id, record])
      continue
    }
    entries.push([id, await localizePageAsset(record, pageId, reservations)])
  }
  return {
    ...pageSnapshot,
    store: Object.fromEntries(entries)
  }
}

export async function serveCanvasAsset(req, res, next) {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (!url.pathname.startsWith(globalAssetsRoute) && !url.pathname.startsWith(pageAssetsRoute)) {
    next()
    return
  }

  let filePath
  try {
    filePath = await localAssetFilePathFromUrl(url.pathname)
  } catch (error) {
    if (error instanceof CowartPageAssetPathError) {
      res.statusCode = error.status ?? 403
      res.end(error.status === 400 ? 'Bad request' : 'Forbidden')
      return
    }
    next(error)
    return
  }
  if (!filePath) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }

  try {
    const bytes = await readFile(filePath)
    res.statusCode = 200
    res.setHeader('content-type', mimeTypes.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream')
    res.setHeader('content-length', String(bytes.length))
    res.setHeader('cache-control', 'no-cache')
    res.end(bytes)
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (url.pathname.startsWith(globalAssetsRoute)) {
        next()
        return
      }
      res.statusCode = 404
      res.end('Not found')
      return
    }
    next(error)
  }
}
