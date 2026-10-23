/**
 * Translation from scanned foreign items to the two surfaces DSH owns: `llm-pi-ai`
 * provider routes and harness credential references/records. Pure — no I/O — so
 * the mapping can be tested without a Host.
 */
import { routeKey, refNameFor } from './sources.js'

/** Credential record scope owned by the pi-ai adapter. */
export const RECORD_SCOPE = 'llm-pi-ai'

export function recordKeyFor(id) {
  return `${RECORD_SCOPE}/${id}`
}

const NON_CHAT = /(embedding|embeddings|bge-|@cf\/|tts|whisper|eleven|rerank|moderation|dall-e|stable-diffusion|sdxl|flux|image-)/i

/** Whether a declared model can be served as a chat model. */
export function isChatModel(modelId, model) {
  const name = String(model?.name ?? '')
  return !NON_CHAT.test(String(modelId)) && !NON_CHAT.test(name)
}

/**
 * Pick the route for one item. An endpoint that DSH already configures
 * identically is extended rather than shadowed by a second route.
 */
export function routeFor(item, plans, existing) {
  const preferred = routeKey(item.foreignId ?? item.sourceId)
  const current = plans[preferred] ?? existing[preferred]
  if (current === undefined) {
    plans[preferred] = { reserved: true }
    return { route: preferred, merged: false }
  }
  const sameEndpoint = (current.baseURL ?? '') === (item.baseURL ?? '')
  const sameApi = item.protocol === undefined || current.api === undefined || current.api === item.protocol
  if (sameEndpoint && sameApi && item.kind === 'provider' && item.baseURL !== undefined) {
    return { route: preferred, merged: true }
  }
  const base = routeKey(`${item.sourceId}-${item.foreignId ?? preferred}`)
  let route = base
  let n = 2
  while (plans[route] !== undefined || existing[route] !== undefined) route = `${base}-${n++}`
  plans[route] = { reserved: true }
  return { route, merged: false }
}

/** Provider routes an `.env` key name is conventionally used for. */
const ENV_ROUTES = [
  [/^OPENAI_API_KEY$/, 'openai', 'openai-responses'],
  [/^ANTHROPIC_API_KEY$/, 'anthropic', 'anthropic-messages'],
  [/^GEMINI_API_KEY$|^GOOGLE_API_KEY$/, 'google', 'openai-completions'],
  [/^DEEPSEEK_API_KEY$/, 'deepseek', 'openai-completions'],
  [/^OPENROUTER_API_KEY$/, 'openrouter', 'openai-completions'],
  [/^GROQ_API_KEY$/, 'groq', 'openai-completions'],
  [/^MISTRAL_API_KEY$/, 'mistral', 'openai-completions'],
  [/^XAI_API_KEY$/, 'xai', 'openai-completions'],
  [/^NVIDIA_API_KEY$/, 'nvidia', 'openai-completions'],
  [/^MOONSHOT_API_KEY$/, 'moonshotai', 'openai-completions'],
  [/^ZAI_API_KEY$|^ZHIPU_API_KEY$/, 'zai', 'openai-completions'],
]

function envItems(item) {
  const out = []
  for (const [name, value] of Object.entries(item.entries ?? {})) {
    const known = ENV_ROUTES.find(([pattern]) => pattern.test(name))
    out.push({
      name,
      value,
      hint: known === undefined ? undefined : { route: known[1], protocol: known[2] },
    })
  }
  return out
}

/**
 * Build the import plan.
 * @param items scanned items, secrets included
 * @param options existingProviders is the current `llm-pi-ai` providers map
 */
export function buildPlan(items, options = {}) {
  const existing = options.existingProviders ?? {}
  const plans = {}
  const refs = []
  const records = []
  const envRefs = []
  const skipped = []
  const filtered = []
  const order = []

  for (const item of items) {
    if (item === null || typeof item !== 'object') continue

    if (item.kind === 'env') {
      for (const entry of envItems(item)) {
        if (entry.hint === undefined) {
          envRefs.push({ ref: entry.name, value: entry.value, route: undefined })
        } else {
          envRefs.push({ ref: entry.name, value: entry.value, route: entry.hint.route, protocol: entry.hint.protocol })
        }
      }
      continue
    }

    const { route, merged } = routeFor(item, plans, existing)

    if (item.kind === 'oauth') {
      plans[route] = { displayName: item.displayName ?? route }
      records.push({ key: recordKeyFor(route), record: { kind: 'grant', payload: item.grant } })
      order.push(route)
      continue
    }

    const declared = Array.isArray(item.models) ? item.models : []
    const chatModels = declared.filter((model) => isChatModel(model.id, model))
    const dropped = declared.length - chatModels.length
    if (dropped > 0) filtered.push({ id: `${item.sourceId}:${item.foreignId}`, dropped })

    const ref = refNameFor(route)
    const key = typeof item.apiKey === 'string' && item.apiKey.length > 0 ? item.apiKey : undefined

    if (chatModels.length === 0) {
      if (key !== undefined) refs.push({ ref, value: key })
      skipped.push({
        id: `${item.sourceId}:${item.foreignId}`,
        reason: declared.length === 0
          ? `no models declared — key kept as ${ref}, no route created`
          : `only non-chat models (${dropped}) — no route created`,
      })
      continue
    }

    const config = { displayName: item.displayName ?? route, api: item.protocol ?? 'openai-completions' }
    if (typeof item.baseURL === 'string' && item.baseURL.length > 0) config.baseURL = item.baseURL
    if (key !== undefined) {
      config.apiKeyEnv = ref
      refs.push({ ref, value: key })
    } else if (Array.isArray(item.env) && typeof item.env[0] === 'string') {
      config.apiKeyEnv = item.env[0]
    }

    if (merged) {
      const prior = existing[route] ?? plans[route]
      const priorModels = Array.isArray(prior?.models) ? prior.models : []
      const known = new Set(priorModels.map((model) => model.id))
      plans[route] = {
        ...prior,
        displayName: prior?.displayName ?? config.displayName,
        api: prior?.api ?? config.api,
        baseURL: prior?.baseURL ?? config.baseURL,
        apiKeyEnv: prior?.apiKeyEnv ?? config.apiKeyEnv,
        models: [...priorModels, ...chatModels.filter((model) => !known.has(model.id))],
      }
      order.push(route)
      continue
    }

    config.models = chatModels.map((model) => ({ ...model }))
    plans[route] = config
    order.push(route)
  }

  const routes = {}
  for (const route of order) {
    const config = plans[route]
    if (config === undefined || config.reserved === true) continue
    const clean = { ...config }
    delete clean.reserved
    routes[route] = clean
  }

  return {
    routes,
    refs,
    records,
    envRefs,
    skipped,
    filtered,
    summary: {
      routes: Object.keys(routes).length,
      models: Object.values(routes).reduce((total, route) => total + (Array.isArray(route.models) ? route.models.length : 0), 0),
      credentials: refs.length + records.length,
      skipped: skipped.length,
      filtered: filtered.reduce((total, entry) => total + entry.dropped, 0),
    },
  }
}

/** Merge planned routes into the existing `llm-pi-ai` config. */
export function mergeRoutes(current, planned, { replace = false } = {}) {
  const base = current !== null && typeof current === 'object' ? structuredClone(current) : {}
  const existing = base.providers
  const providers = existing !== null && typeof existing === 'object' && !Array.isArray(existing)
    ? (replace ? {} : { ...existing })
    : {}
  for (const [route, config] of Object.entries(planned)) providers[route] = config
  return { ...base, providers }
}

/** A secret-free description of one configured route. */
export function describeRoute(route, config) {
  const models = Array.isArray(config?.models) ? config.models : []
  return {
    route,
    displayName: config?.displayName ?? route,
    api: config?.api ?? 'catalog default',
    baseURL: config?.baseURL ?? 'catalog default',
    apiKeyEnv: config?.apiKeyEnv,
    modelCount: models.length,
    models: models.slice(0, 60).map((model) => ({ id: model.id, name: model.name })),
  }
}
