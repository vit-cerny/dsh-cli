/**
 * dsh-model-picker Host half. Owns one piece of state the browser cannot keep
 * for itself: the set of favourite models, shared by the composer picker and the
 * Model Manager settings page. Nothing secret lives here — a favourite is a
 * `provider/model` string.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-model-picker'
export const inject = []

const MAX_BODY = 256 * 1024
const MAX_FAVOURITES = 500
const MAX_KEY_LENGTH = 300
/** One favourite id: `provider/model`, neither part empty, no whitespace. */
const KEY_PATTERN = /^[^\s/]+\/\S+$/

/** Default state file, next to the other plugin-local DSH state. */
export function defaultStatePath() {
  return join(homedir(), '.dsh', 'model-picker', 'favorites.json')
}

/** Normalize one stored id, or `undefined` when it is not a usable key. */
export function normalizeKey(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_KEY_LENGTH) return undefined
  return KEY_PATTERN.test(trimmed) ? trimmed : undefined
}

/** Deduplicate and order a raw list, dropping everything unusable. */
export function normalizeFavorites(values) {
  const seen = new Set()
  const out = []
  for (const value of Array.isArray(values) ? values : []) {
    const key = normalizeKey(value)
    if (key === undefined || seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= MAX_FAVOURITES) break
  }
  return out
}

/** Read the favourites list; a missing or corrupt file reads as empty. */
export function readFavorites(path = defaultStatePath()) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return normalizeFavorites(raw?.favorites)
  } catch {
    return []
  }
}

/** Write through a temp file so a crash cannot truncate the list. */
export function writeFavorites(favorites, path = defaultStatePath()) {
  const normalized = normalizeFavorites(favorites)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify({ version: 1, favorites: normalized }, null, 2))
  renameSync(temp, path)
  return normalized
}

/** Add or remove one key; returns the new list. */
export function toggleFavorite(favorites, key, favorite) {
  const current = normalizeFavorites(favorites)
  const wanted = normalizeKey(key)
  if (wanted === undefined) throw new Error('favourite key must look like provider/model')
  const without = current.filter((entry) => entry !== wanted)
  return favorite === false ? without : [...without, wanted].slice(0, MAX_FAVOURITES)
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) return undefined
      chunks.push(chunk)
    }
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Writes reach the user's preferences, so another origin must not trigger them.
 * Browsers always attach `Origin` to a cross-site POST, so an absent header means
 * a non-browser caller (the app's own fetch always sends one); a present header
 * must name this exact host.
 */
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site']
  if (site === 'same-origin') return true
  if (site === 'cross-site') return false
  const { origin, host } = req.headers
  if (origin === undefined) return true
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** The one route the browser halves talk to; it dispatches on method. */
export function webRoutes(ctx, config = {}) {
  const path = typeof config.stateFile === 'string' && config.stateFile !== '' ? config.stateFile : defaultStatePath()
  const writable = () => {
    if (config.allowWrite === false) throw new Error('writes are disabled by config (allowWrite: false)')
  }

  return [
    {
      kind: 'exact',
      path: '/api/dsh-model-picker/favorites',
      handler: async (req, res) => {
        try {
          if (!isLoopback(req)) {
            sendJson(res, 403, { error: 'loopback only' })
            return
          }
          if (req.method === 'GET') {
            sendJson(res, 200, { favorites: readFavorites(path) })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: `method not allowed: ${String(req.method)}` })
            return
          }
          if (!sameOrigin(req)) {
            ctx.logger?.warn?.(`dsh-model-picker: refused cross-origin write to ${req.url ?? ''}`)
            sendJson(res, 403, { error: 'cross-origin write refused' })
            return
          }
          writable()
          const payload = await readBody(req)
          if (payload === undefined) throw new Error('invalid JSON body')
          // Two shapes: a full replacement list, or one toggle.
          if (Array.isArray(payload.favorites)) {
            sendJson(res, 200, { favorites: writeFavorites(payload.favorites, path) })
            return
          }
          if (typeof payload.key !== 'string') throw new Error('send { favorites: [...] } or { key, favorite }')
          const next = toggleFavorite(readFavorites(path), payload.key, payload.favorite !== false)
          sendJson(res, 200, { favorites: writeFavorites(next, path) })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}

export function apply(ctx, config = {}) {
  if (config?.enabled === false) return undefined

  ctx.inject(['webServer'], (webCtx) => {
    const routes = webRoutes(ctx, config)
    webCtx.effect(() => {
      const disposers = routes.map((route) => webCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* the server may already be gone */
          }
        }
      }
    }, 'dsh-model-picker: routes')
  })

  ctx.logger?.info?.('[dsh-model-picker] mounted')
  return undefined
}
