/**
 * dsh-model-manager Host half. Imports models, providers, API keys and OAuth
 * logins from other agent harnesses into DSH, and serves the Settings page that
 * manages them. Secrets never leave this process except into the credential store.
 */
import { scanAll, scanSource, redactScan, SCANNERS } from './sources.js'
import { buildPlan, mergeRoutes, describeRoute, recordKeyFor } from './manager.js'
import {
  defaultStatePath, readState, writeState, disableRoute, enableRoute,
  disableModel, enableModel, disabledModelsFor, withEnvPath, withoutEnvPath,
} from './store.js'

export const name = 'model-manager'
export const inject = []

const ENTRY_ID = 'llm-pi-ai'
const MAX_BODY = 1024 * 1024
const KNOWN_SOURCES = [...SCANNERS.map(([id]) => id), 'env']

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

// Writes reach the credential store, so another origin must not be able to trigger them.
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true
  const { origin, host } = req.headers
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function gate(req, res, method, logger) {
  if (!isLoopback(req)) {
    sendJson(res, 403, { error: 'loopback only' })
    return false
  }
  if (req.method !== method) {
    sendJson(res, 405, { error: `method not allowed: ${String(req.method)}` })
    return false
  }
  if (method === 'POST' && !sameOrigin(req)) {
    logger?.warn?.(`dsh-model-manager: refused cross-origin write to ${req.url ?? ''}`)
    sendJson(res, 403, { error: 'cross-origin write refused' })
    return false
  }
  return true
}

function routeEntry(ctx) {
  const editor = ctx.get('configEditor')
  if (editor === undefined) return undefined
  try {
    return editor.entries().find((entry) => entry.options.id === ENTRY_ID)
  } catch {
    return undefined
  }
}

function llmConfig(ctx) {
  const entry = routeEntry(ctx)
  if (entry !== undefined) {
    const config = entry.options.config ?? {}
    return config !== null && typeof config === 'object' ? config : {}
  }
  const settings = ctx.get('settings')
  if (settings === undefined) return {}
  try {
    const row = settings.describe().find((item) => item.ns === ENTRY_ID)
    return row?.value !== null && typeof row?.value === 'object' ? row.value : {}
  } catch {
    return {}
  }
}

function currentRoutes(ctx) {
  const providers = llmConfig(ctx).providers
  return providers !== null && typeof providers === 'object' && !Array.isArray(providers) ? { ...providers } : {}
}

async function writeProviders(ctx, providers) {
  const config = { ...llmConfig(ctx), providers }
  const entry = routeEntry(ctx)
  if (entry !== undefined) {
    await ctx.get('configEditor').edit(entry, () => config)
    return
  }
  const settings = ctx.get('settings')
  if (settings === undefined) throw new Error('no configuration surface is mounted')
  await settings.mutate(ENTRY_ID, [{ op: 'set', path: ['providers'], value: providers }])
}

async function storedRecords(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return []
  return (await credentials.listRecords())
    .filter((entry) => String(entry.key).startsWith('llm-pi-ai/'))
    .map((entry) => ({ key: String(entry.key), id: String(entry.key).slice(9), kind: entry.kind }))
}

function stateOf(statePath) {
  return readState(statePath ?? defaultStatePath())
}

function scan(ctx, config, sourceId) {
  const envPaths = stateOf(config?.stateFile).envPaths
  if (typeof sourceId === 'string' && sourceId.length > 0) return redactScan(scanSource(sourceId, envPaths))
  return { sources: scanAll(envPaths).map(redactScan), known: KNOWN_SOURCES }
}

function plan(ctx, config, request = {}) {
  const state = stateOf(config?.stateFile)
  const wanted = Array.isArray(request.sources) && request.sources.length > 0 ? request.sources : KNOWN_SOURCES
  const selected = new Set(wanted)
  const items = []
  for (const source of scanAll(state.envPaths)) {
    if (!selected.has(source.id)) continue
    items.push(...source.items)
  }
  return buildPlan(items, { existingProviders: currentRoutes(ctx) })
}

// Import plans must remain inside the Host: they contain API keys and OAuth grants.
function safeRoute(config) {
  if (config === null || typeof config !== 'object') return {}
  const models = Array.isArray(config.models) ? config.models : []
  return {
    displayName: config.displayName,
    api: config.api,
    baseURL: config.baseURL,
    apiKeyEnv: config.apiKeyEnv,
    models: models.map((model) => ({
      id: model?.id,
      name: model?.name,
      contextWindow: model?.contextWindow,
      maxTokens: model?.maxTokens,
    })),
  }
}

export function redactPlan(plan) {
  return {
    routes: Object.fromEntries(Object.entries(plan.routes).map(([route, config]) => [route, safeRoute(config)])),
    refs: plan.refs.map(({ ref }) => ({ ref })),
    envRefs: plan.envRefs.map(({ ref, route, protocol }) => ({ ref, route, protocol })),
    records: plan.records.map(({ key }) => ({ key })),
    skipped: plan.skipped,
    filtered: plan.filtered,
    summary: {
      ...plan.summary,
      credentials: plan.refs.length + plan.envRefs.length + plan.records.length,
    },
  }
}

async function importSources(ctx, config, request = {}) {
  const credentials = ctx.get('credentials')
  const result = plan(ctx, config, request)
  if (request.dryRun === true) {
    return { dryRun: true, plan: redactPlan(result), wrote: { refs: [], records: [], routes: [] } }
  }

  const wrote = { refs: [], records: [], routes: [] }
  if (credentials !== undefined) {
    for (const { ref, value } of result.refs) {
      await credentials.set(ref, value)
      wrote.refs.push(ref)
    }
    for (const { ref, value } of result.envRefs) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) continue
      await credentials.set(ref, value)
      wrote.refs.push(ref)
    }
    for (const { key, record } of result.records) {
      await credentials.modifyRecord(key, () => record)
      wrote.records.push(key)
    }
  }

  const merged = mergeRoutes(llmConfig(ctx), result.routes, { replace: request.replace === true })
  await writeProviders(ctx, merged.providers)
  wrote.routes = Object.keys(result.routes)
  return { plan: redactPlan(result), wrote }
}

async function listRoutes(ctx, config) {
  const state = stateOf(config?.stateFile)
  return {
    routes: Object.entries(currentRoutes(ctx)).map(([route, entry]) => ({
      ...describeRoute(route, entry),
      disabledModels: disabledModelsFor(state, route).map((model) => model.id),
    })),
    disabledRoutes: Object.keys(state.disabledRoutes),
    records: await storedRecords(ctx),
    envPaths: state.envPaths,
  }
}

async function setRouteEnabled(ctx, config, route, enabled) {
  const state = stateOf(config?.stateFile)
  const routes = currentRoutes(ctx)
  if (enabled === false) {
    if (routes[route] === undefined) throw new Error(`no such route: ${route}`)
    writeState(disableRoute(state, route, routes[route]), config?.stateFile ?? defaultStatePath())
    const next = { ...routes }
    delete next[route]
    await writeProviders(ctx, next)
    return { route, enabled: false }
  }
  const restored = enableRoute(state, route)
  if (restored.config === undefined) throw new Error(`route ${route} is not disabled`)
  writeState(restored.state, config?.stateFile ?? defaultStatePath())
  await writeProviders(ctx, { ...routes, [route]: restored.config })
  return { route, enabled: true }
}

async function removeRoute(ctx, config, route) {
  const routes = currentRoutes(ctx)
  if (routes[route] === undefined) throw new Error(`no such route: ${route}`)
  const next = { ...routes }
  delete next[route]
  await writeProviders(ctx, next)
  const state = stateOf(config?.stateFile)
  if (state.disabledRoutes[route] !== undefined) {
    writeState(enableRoute(state, route).state, config?.stateFile ?? defaultStatePath())
  }
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const key = recordKeyFor(route)
    const stored = (await credentials.listRecords()).some((entry) => String(entry.key) === key)
    if (stored) await credentials.deleteRecord(key)
  }
  return { removed: route }
}

async function setModelEnabled(ctx, config, route, modelId, enabled) {
  const state = stateOf(config?.stateFile)
  const routes = currentRoutes(ctx)
  const entry = routes[route]
  if (entry === undefined) throw new Error(`no such route: ${route}`)
  const models = Array.isArray(entry.models) ? entry.models : []

  if (enabled === false) {
    const model = models.find((item) => item.id === modelId)
    if (model === undefined) throw new Error(`no such model: ${modelId}`)
    writeState(disableModel(state, route, model), config?.stateFile ?? defaultStatePath())
    await writeProviders(ctx, { ...routes, [route]: { ...entry, models: models.filter((item) => item.id !== modelId) } })
    return { route, model: modelId, enabled: false }
  }

  const restored = disabledModelsFor(state, route).find((item) => item.id === modelId)
  if (restored === undefined) throw new Error(`model ${modelId} is not disabled`)
  writeState(enableModel(state, route, modelId), config?.stateFile ?? defaultStatePath())
  const merged = [...models, restored].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  await writeProviders(ctx, { ...routes, [route]: { ...entry, models: merged } })
  return { route, model: modelId, enabled: true }
}

async function addRoute(ctx, config, request = {}) {
  const route = typeof request.route === 'string' ? request.route.trim() : ''
  if (!/^[a-z][a-z0-9-]*$/.test(route)) throw new Error('route must be lowercase letters, digits and hyphens')
  const endpoint = typeof request.baseURL === 'string' ? request.baseURL.trim() : ''
  let parsedEndpoint
  try { parsedEndpoint = new URL(endpoint) } catch { throw new Error('baseURL must be an http(s) URL') }
  if (!['http:', 'https:'].includes(parsedEndpoint.protocol) || parsedEndpoint.username !== '' || parsedEndpoint.password !== '') {
    throw new Error('baseURL must be an http(s) URL without embedded credentials')
  }
  const supportedApis = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])
  const api = typeof request.api === 'string' ? request.api : 'openai-completions'
  if (!supportedApis.has(api)) throw new Error(`api must be one of: ${[...supportedApis].join(', ')}`)
  const models = (Array.isArray(request.models) ? request.models : [])
    .map((model) => (typeof model === 'string' ? model : model?.id))
    .filter((id) => typeof id === 'string' && id.length > 0)
  if (models.length === 0) throw new Error('at least one model id is required')
  const routes = currentRoutes(ctx)
  if (routes[route] !== undefined) throw new Error(`route ${route} already exists`)
  const ref = typeof request.apiKeyEnv === 'string' && request.apiKeyEnv.length > 0
    ? request.apiKeyEnv
    : `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
    throw new Error('apiKeyEnv must be an environment-style name such as ACME_API_KEY')
  }
  // Store the key before the route so the route never points at a missing credential.
  const apiKey = typeof request.apiKey === 'string' ? request.apiKey.trim() : ''
  if (apiKey.length > 0) {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw new Error('no credentials service is mounted, so the key cannot be stored')
    await credentials.set(ref, apiKey)
  }
  await writeProviders(ctx, {
    ...routes,
    [route]: {
      displayName: typeof request.displayName === 'string' && request.displayName.length > 0 ? request.displayName : route,
      api,
      baseURL: endpoint,
      apiKeyEnv: ref,
      models: models.map((id) => ({ id })),
    },
  })
  return { added: route, apiKeyEnv: ref, keyStored: apiKey.length > 0 }
}

async function setSecret(ctx, request = {}) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('no credentials service is mounted')
  const ref = String(request.ref ?? '')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error('ref must be an environment-style name such as ACME_API_KEY')
  if (request.clear === true) {
    await credentials.unset(ref)
    return { ref, cleared: true }
  }
  const value = String(request.value ?? '')
  if (value.length === 0) throw new Error('value must not be empty')
  await credentials.set(ref, value)
  return { ref, stored: true }
}

function addEnvPath(ctx, config, path) {
  const value = String(path ?? '').trim()
  if (value.length === 0) throw new Error('path is required')
  const next = withEnvPath(stateOf(config?.stateFile), value)
  writeState(next, config?.stateFile ?? defaultStatePath())
  return { envPaths: next.envPaths }
}

function removeEnvPath(ctx, config, path) {
  const next = withoutEnvPath(stateOf(config?.stateFile), String(path ?? ''))
  writeState(next, config?.stateFile ?? defaultStatePath())
  return { envPaths: next.envPaths }
}

const text = (value) => ({ text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) })

function tool(name, description, properties, run) {
  return {
    name,
    description,
    parameters: { type: 'object', properties },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      return text(await run(args ?? {}))
    },
  }
}

function toolDefinitions(ctx, config) {
  const writable = () => {
    if (config?.allowWrite === false) throw new Error('writes are disabled by config (allowWrite: false)')
  }
  const sources = { type: 'array', items: { type: 'string' }, description: `source ids: ${KNOWN_SOURCES.join(', ')}` }
  return [
    tool(
      'model_manager_sources',
      'List the models, providers, API keys and OAuth logins that other agent harnesses on this machine hold (opencode, Codex/ChatGPT, Claude Code, Gemini, Qwen, .env). Secrets are redacted. Call this before importing.',
      { source: { type: 'string', description: `one source id (${KNOWN_SOURCES.join(', ')}), or omit for all` } },
      (args) => scan(ctx, config, args.source),
    ),
    tool(
      'model_manager_plan',
      'Dry-run an import: translate the selected harnesses into DSH llm-pi-ai routes and credential references without writing, and report what would be skipped.',
      { sources },
      (args) => redactPlan(plan(ctx, config, args)),
    ),
    tool(
      'model_manager_import',
      'Import models, providers, API keys and OAuth logins from other harnesses into DSH: writes credential references/records and llm-pi-ai routes, applied live. Run model_manager_plan first.',
      {
        sources,
        replace: { type: 'boolean', description: 'replace the whole provider map instead of merging' },
        dryRun: { type: 'boolean', description: 'report the plan without writing' },
      },
      (args) => {
        if (args.dryRun !== true) writable()
        return importSources(ctx, config, args)
      },
    ),
    tool(
      'model_manager_routes',
      'List the provider routes DSH configures through llm-pi-ai with model counts, disabled models and stored credential record ids.',
      {},
      () => listRoutes(ctx, config),
    ),
    tool(
      'model_manager_toggle_route',
      'Enable or disable one llm-pi-ai provider route. Disabling stashes the route so enabling restores it exactly.',
      {
        route: { type: 'string', description: 'route key' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable' },
      },
      (args) => {
        writable()
        return setRouteEnabled(ctx, config, String(args.route ?? ''), args.enabled !== false)
      },
    ),
    tool(
      'model_manager_toggle_model',
      'Enable or disable one model on an llm-pi-ai provider route.',
      {
        route: { type: 'string', description: 'route key' },
        model: { type: 'string', description: 'model id' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable' },
      },
      (args) => {
        writable()
        return setModelEnabled(ctx, config, String(args.route ?? ''), String(args.model ?? ''), args.enabled !== false)
      },
    ),
    tool(
      'model_manager_add_route',
      'Add a custom provider route (any OpenAI-compatible or Anthropic-compatible endpoint) to llm-pi-ai.',
      {
        route: { type: 'string', description: 'new route key, lowercase letters/digits/hyphens' },
        baseURL: { type: 'string', description: 'endpoint root, e.g. https://gateway.example/v1' },
        api: { type: 'string', description: 'openai-completions | openai-responses | anthropic-messages' },
        apiKeyEnv: { type: 'string', description: 'credential reference name; defaults to <ROUTE>_API_KEY' },
        apiKey: { type: 'string', description: 'optional secret to store under apiKeyEnv; never echoed back' },
        displayName: { type: 'string', description: 'label shown in the model picker' },
        models: { type: 'array', items: { type: 'string' }, description: 'model ids served by the endpoint' },
      },
      (args) => {
        writable()
        return addRoute(ctx, config, args)
      },
    ),
    tool(
      'model_manager_remove_route',
      'Remove one llm-pi-ai provider route and its stored OAuth record.',
      { route: { type: 'string', description: 'route key' } },
      (args) => {
        writable()
        return removeRoute(ctx, config, String(args.route ?? ''))
      },
    ),
    tool(
      'model_manager_set_secret',
      'Store or clear an API key in the DSH credential store under a reference name. The value is never echoed back.',
      {
        ref: { type: 'string', description: 'credential reference name, e.g. ACME_GATEWAY_API_KEY' },
        value: { type: 'string', description: 'secret to store; omit when clearing' },
        clear: { type: 'boolean', description: 'remove the stored value' },
      },
      (args) => {
        writable()
        return setSecret(ctx, args)
      },
    ),
  ]
}

function webRoutes(ctx, config) {
  const guard = (req, res, method) => gate(req, res, method, ctx.logger)
  const writable = () => {
    if (config?.allowWrite === false) throw new Error('writes are disabled by config (allowWrite: false)')
  }
  const handle = (body) => async (req, res) => {
    try {
      const value = await body(req, res)
      if (value !== undefined) sendJson(res, 200, value)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  const post = (body) => handle(async (req, res) => {
    if (!guard(req, res, 'POST')) return undefined
    writable()
    const payload = await readBody(req)
    if (payload === undefined) throw new Error('invalid JSON body')
    return body(payload)
  })
  const get = (body) => handle(async (req, res) => {
    if (!guard(req, res, 'GET')) return undefined
    return body(req)
  })

  return [
    {
      kind: 'exact',
      path: '/api/dsh-model-manager/sources',
      handler: get((req) => scan(ctx, config, new URL(req.url ?? '/', 'http://localhost').searchParams.get('source') ?? undefined)),
    },
    { kind: 'exact', path: '/api/dsh-model-manager/plan', handler: post((body) => redactPlan(plan(ctx, config, body))) },
    { kind: 'exact', path: '/api/dsh-model-manager/import', handler: post((body) => importSources(ctx, config, body)) },
    { kind: 'exact', path: '/api/dsh-model-manager/routes', handler: get(() => listRoutes(ctx, config)) },
    { kind: 'exact', path: '/api/dsh-model-manager/route/toggle', handler: post((body) => setRouteEnabled(ctx, config, String(body.route ?? ''), body.enabled !== false)) },
    { kind: 'exact', path: '/api/dsh-model-manager/route/remove', handler: post((body) => removeRoute(ctx, config, String(body.route ?? ''))) },
    { kind: 'exact', path: '/api/dsh-model-manager/route/add', handler: post((body) => addRoute(ctx, config, body)) },
    { kind: 'exact', path: '/api/dsh-model-manager/model/toggle', handler: post((body) => setModelEnabled(ctx, config, String(body.route ?? ''), String(body.model ?? ''), body.enabled !== false)) },
    { kind: 'exact', path: '/api/dsh-model-manager/secret', handler: post((body) => setSecret(ctx, body)) },
    { kind: 'exact', path: '/api/dsh-model-manager/env-path', handler: post((body) => (body.remove === true ? removeEnvPath(ctx, config, body.path) : addEnvPath(ctx, config, body.path))) },
  ]
}

const GUIDANCE = 'model-manager is installed: this machine holds models, providers, API keys and OAuth logins belonging to other agent harnesses (opencode, Codex/ChatGPT, Claude Code, Gemini, Qwen, .env). `model_manager_sources` lists them with secrets redacted, `model_manager_plan` dry-runs the translation into DSH llm-pi-ai routes, `model_manager_import` applies it, and `model_manager_routes` shows what DSH configures. The user also has Settings → Model Manager in the Web UI, which does the same with buttons.'

export function apply(ctx, config = {}) {
  if (config?.enabled === false) return undefined

  ctx.inject(['webServer'], (webCtx) => {
    const routes = webRoutes(ctx, config)
    webCtx.effect(() => {
      const disposers = routes.map((route) => webCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* the server may already be gone */ }
        }
      }
    }, 'dsh-model-manager: routes')
  })

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      const disposers = toolDefinitions(toolCtx, config).map((definition) => toolCtx.tools.register(definition))
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* same */ }
        }
      }
    }, 'dsh-model-manager: tools')
  })

  if (config?.announceToAgent !== false) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.effect(() => {
        const systemPrompt = promptCtx.systemPrompt
        if (typeof systemPrompt.section !== 'function') return undefined
        return systemPrompt.section({ name: 'plugin:dsh-model-manager', order: 152, text: GUIDANCE })
      }, 'dsh-model-manager: announcement')
    })
  }

  ctx.logger?.info?.('[dsh-model-manager] mounted')
  return undefined
}
