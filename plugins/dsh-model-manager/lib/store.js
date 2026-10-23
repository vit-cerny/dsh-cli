/**
 * Plugin-local state: which routes/models the user disabled and the extra `.env`
 * paths they added. Secrets are never stored here.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const EMPTY = { version: 1, disabledRoutes: {}, disabledModels: {}, envPaths: [] }

export function defaultStatePath() {
  return join(homedir(), '.dsh', 'model-manager', 'state.json')
}

export function readState(path = defaultStatePath()) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return {
      version: 1,
      disabledRoutes: raw?.disabledRoutes && typeof raw.disabledRoutes === 'object' ? raw.disabledRoutes : {},
      disabledModels: raw?.disabledModels && typeof raw.disabledModels === 'object' ? raw.disabledModels : {},
      envPaths: Array.isArray(raw?.envPaths) ? raw.envPaths.filter((entry) => typeof entry === 'string') : [],
    }
  } catch {
    return { ...EMPTY, disabledRoutes: {}, disabledModels: {}, envPaths: [] }
  }
}

/** Write through a temp file so a crash cannot truncate the state. */
export function writeState(state, path = defaultStatePath()) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(state, null, 2))
  renameSync(temp, path)
}

/** Remember one route's live config before disabling it, so enabling restores it. */
export function disableRoute(state, route, config) {
  const next = structuredClone(state)
  next.disabledRoutes[route] = { config, at: new Date().toISOString() }
  return next
}

export function enableRoute(state, route) {
  const next = structuredClone(state)
  const saved = next.disabledRoutes[route]
  delete next.disabledRoutes[route]
  return { state: next, config: saved?.config }
}

export function disableModel(state, route, model) {
  const next = structuredClone(state)
  const list = Array.isArray(next.disabledModels[route]) ? next.disabledModels[route] : []
  if (!list.some((entry) => entry.id === model.id)) list.push(model)
  next.disabledModels[route] = list
  return next
}

export function enableModel(state, route, modelId) {
  const next = structuredClone(state)
  const list = Array.isArray(next.disabledModels[route]) ? next.disabledModels[route] : []
  next.disabledModels[route] = list.filter((entry) => entry.id !== modelId)
  if (next.disabledModels[route].length === 0) delete next.disabledModels[route]
  return next
}

export function disabledModelsFor(state, route) {
  return Array.isArray(state.disabledModels[route]) ? state.disabledModels[route] : []
}

/** Apply the user's model choices to one route's declared models. */
export function applyModelMask(state, route, models) {
  const disabled = new Set(disabledModelsFor(state, route).map((entry) => entry.id))
  return models.filter((model) => !disabled.has(model.id))
}

export function withEnvPath(state, path) {
  const next = structuredClone(state)
  if (!next.envPaths.includes(path)) next.envPaths.push(path)
  return next
}

export function withoutEnvPath(state, path) {
  const next = structuredClone(state)
  next.envPaths = next.envPaths.filter((entry) => entry !== path)
  return next
}
