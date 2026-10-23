/**
 * Readers for the model/provider configuration and credentials that other
 * agent harnesses keep on this machine. Everything is read-only and normalized
 * into one shape the planner turns into DSH routes and credential records.
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Strip comments and trailing commas, then parse. opencode ships JSONC. */
export function parseJsonc(text) {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue }
    out += c
  }
  let clean = ''
  inStr = false
  esc = false
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (inStr) {
      clean += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; clean += c; continue }
    if (c === ',') {
      let j = i + 1
      while (j < out.length && /\s/.test(out[j])) j++
      if (out[j] === '}' || out[j] === ']') continue
    }
    clean += c
  }
  return JSON.parse(clean)
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

function readJsonc(path) {
  try { return parseJsonc(readFileSync(path, 'utf8')) } catch { return undefined }
}

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Route key: lowercase, hyphenated. Leading digits are fine for a pi-ai route. */
export function routeKey(raw) {
  const key = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return key.length > 0 ? key : 'route'
}

/** Credential reference name, which must read as an environment variable. */
export function refNameFor(raw) {
  let name = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!/^[A-Za-z_]/.test(name)) name = `MM_${name}`
  name = `${name}_API_KEY`
  return REF_PATTERN.test(name) ? name : `MM_${name.replace(/[^A-Z0-9_]/g, '') || 'KEY'}`
}

const EFFORTS = { none: 'off', off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }

function inputModalities(capabilities) {
  const list = Array.isArray(capabilities?.input) ? capabilities.input : []
  const out = []
  if (list.includes('text') || list.length === 0) out.push('text')
  if (list.includes('image')) out.push('image')
  return out
}

function reasoningEfforts(capabilities) {
  const reasoning = capabilities?.reasoning
  if (reasoning?.supported !== true) return undefined
  const declared = Array.isArray(reasoning.effort) ? reasoning.effort : []
  const map = {}
  for (const effort of declared) {
    const alias = EFFORTS[String(effort).toLowerCase()]
    if (alias !== undefined) map[alias] = alias
  }
  if (Object.keys(map).length === 0) {
    for (const effort of ['off', 'low', 'medium', 'high']) map[effort] = effort
  }
  return map
}

function positive(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

/**
 * One opencode model row as a DSH model entry. `modelID` wins over the map key
 * because that is the id the endpoint expects on the wire.
 */
export function normalizeOpencodeModel(key, raw) {
  const wireId = typeof raw?.modelID === 'string' && raw.modelID.length > 0 ? raw.modelID : key
  const row = { id: String(wireId) }
  if (typeof raw?.name === 'string' && raw.name.length > 0) row.name = raw.name
  const context = positive(raw?.limit?.context)
  const output = positive(raw?.limit?.output)
  if (context !== undefined) row.contextWindow = context
  if (output !== undefined) row.maxTokens = output
  row.input = inputModalities(raw?.capabilities)
  const efforts = reasoningEfforts(raw?.capabilities)
  if (efforts !== undefined) row.reasoningEfforts = efforts
  return row
}

/** opencode `package` → DSH pi-ai protocol. */
export function protocolFor(pkg) {
  const value = String(pkg ?? '')
  if (value.includes('anthropic')) return 'anthropic-messages'
  if (/(^|\/)openai$/.test(value) || value.includes('responses')) return 'openai-responses'
  return 'openai-completions'
}

const OPENCODE_DIRS = [
  join(homedir(), '.config', 'opencode'),
  join(homedir(), '.opencode'),
]
const OPENCODE_AUTH = join(homedir(), '.local', 'share', 'opencode', 'auth.json')

function opencodeConfigPath() {
  for (const dir of OPENCODE_DIRS) {
    for (const name of ['opencode.jsonc', 'opencode.json']) {
      const path = join(dir, name)
      if (existsSync(path)) return path
    }
  }
  return undefined
}

export function scanOpencode() {
  const path = opencodeConfigPath()
  const source = { id: 'opencode', label: 'opencode', kind: 'harness', found: path !== undefined, path, items: [], notes: [] }
  if (path === undefined) {
    source.notes.push('no opencode.json or opencode.jsonc found')
    return source
  }
  const config = readJsonc(path)
  if (config === undefined) {
    source.notes.push(`could not parse ${path}`)
    return source
  }
  const auth = readJson(OPENCODE_AUTH) ?? {}
  const providers = config.provider ?? config.providers ?? {}

  for (const [id, raw] of Object.entries(providers)) {
    if (raw === null || typeof raw !== 'object') continue
    const settings = raw.settings ?? raw.options ?? {}
    const seen = new Set()
    const models = []
    for (const [key, model] of Object.entries(raw.models ?? {})) {
      const row = normalizeOpencodeModel(key, model)
      if (seen.has(row.id)) continue
      seen.add(row.id)
      models.push(row)
    }
    const inlineKey = typeof settings.apiKey === 'string' && settings.apiKey.length > 0 ? settings.apiKey : undefined
    source.items.push({
      kind: 'provider',
      sourceId: 'opencode',
      foreignId: id,
      displayName: raw.name ?? id,
      protocol: protocolFor(raw.package),
      baseURL: typeof settings.baseURL === 'string' ? settings.baseURL : undefined,
      apiKey: inlineKey ?? auth[id]?.key,
      env: Array.isArray(raw.env) ? raw.env : [],
      models,
      notes: [],
    })
  }

  for (const [id, record] of Object.entries(auth)) {
    if (providers[id] !== undefined) continue
    if (record?.type !== 'api' || typeof record.key !== 'string') continue
    // Some auth stores key an entry by the secret itself, which names no provider.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length > 40) continue
    source.items.push({
      kind: 'provider',
      sourceId: 'opencode',
      foreignId: id,
      displayName: id,
      protocol: 'openai-completions',
      baseURL: undefined,
      apiKey: record.key,
      env: [],
      models: [],
      notes: ['API key only — no endpoint or models declared in opencode'],
    })
  }

  if (source.items.length === 0) source.notes.push('no providers declared')
  return source
}

export function scanCodex() {
  const authPath = join(homedir(), '.codex', 'auth.json')
  const source = { id: 'codex', label: 'Codex CLI / ChatGPT login', kind: 'oauth', found: existsSync(authPath), path: authPath, items: [], notes: [] }
  const auth = readJson(authPath)
  if (auth === undefined) {
    source.notes.push(source.found ? 'auth.json could not be parsed' : 'no ~/.codex/auth.json found')
    return source
  }
  const tokens = auth.tokens ?? {}
  if (auth.auth_mode === 'chatgpt' && typeof tokens.access_token === 'string' && tokens.access_token.length > 0) {
    const refreshedAt = Date.parse(auth.last_refresh ?? '')
    source.items.push({
      kind: 'oauth',
      sourceId: 'codex',
      foreignId: 'openai-codex',
      displayName: 'OpenAI Codex (ChatGPT login)',
      grant: {
        type: 'oauth',
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        // Tokens last about an hour; pi-ai refreshes them with the refresh token.
        expires: (Number.isFinite(refreshedAt) ? refreshedAt : Date.now()) + 55 * 60 * 1000,
        accountId: tokens.account_id,
      },
      models: [],
      notes: ['ChatGPT subscription login from ~/.codex/auth.json'],
    })
  }
  if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0) {
    source.items.push({
      kind: 'provider',
      sourceId: 'codex',
      foreignId: 'openai',
      displayName: 'OpenAI (Codex API key)',
      protocol: 'openai-responses',
      apiKey: auth.OPENAI_API_KEY,
      models: [],
      notes: ['API key from ~/.codex/auth.json'],
    })
  }
  if (source.items.length === 0) source.notes.push('auth.json holds no ChatGPT login or API key')
  return source
}

export function scanClaudeCode() {
  const dir = join(homedir(), '.claude')
  const credPath = join(dir, '.credentials.json')
  const settingsPath = join(dir, 'settings.json')
  const source = {
    id: 'claude-code',
    label: 'Claude Code',
    kind: 'oauth',
    found: existsSync(credPath) || existsSync(settingsPath),
    path: existsSync(credPath) ? credPath : settingsPath,
    items: [],
    notes: [],
  }
  const oauth = (readJson(credPath) ?? {}).claudeAiOauth
  if (typeof oauth?.accessToken === 'string' && oauth.accessToken.length > 0) {
    const expiresAt = Number(oauth.expiresAt)
    source.items.push({
      kind: 'oauth',
      sourceId: 'claude-code',
      foreignId: 'anthropic',
      displayName: 'Anthropic (Claude Code login)',
      grant: {
        type: 'oauth',
        access: oauth.accessToken,
        refresh: typeof oauth.refreshToken === 'string' ? oauth.refreshToken : undefined,
        expires: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : Date.now(),
      },
      models: [],
      notes: ['Claude Code login from ~/.claude/.credentials.json'],
    })
  }
  const key = readJson(settingsPath)?.env?.ANTHROPIC_API_KEY
  if (typeof key === 'string' && key.length > 0) {
    source.items.push({
      kind: 'provider',
      sourceId: 'claude-code',
      foreignId: 'anthropic',
      displayName: 'Anthropic (API key)',
      protocol: 'anthropic-messages',
      apiKey: key,
      models: [],
      notes: ['ANTHROPIC_API_KEY from ~/.claude/settings.json'],
    })
  }
  if (source.items.length === 0) source.notes.push('no Claude Code credentials found')
  return source
}

function scanOauthFile({ id, label, dirs, file, route, displayName, pick }) {
  const source = { id, label, kind: 'oauth', found: false, path: undefined, items: [], notes: [] }
  for (const dir of dirs) {
    const path = join(dir, file)
    if (!existsSync(path)) continue
    source.found = true
    source.path = path
    const doc = readJson(path)
    if (doc === undefined) { source.notes.push(`${file} could not be parsed`); continue }
    const grant = pick(doc)
    if (grant === undefined) { source.notes.push(`${file} holds no OAuth token`); continue }
    source.items.push({
      kind: 'oauth',
      sourceId: id,
      foreignId: route,
      displayName,
      grant,
      models: [],
      notes: [`OAuth token from ${path}`],
    })
  }
  if (!source.found) source.notes.push(`no ${file} found`)
  return source
}

function secondsOrMillis(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  return n < 10_000_000_000 ? n * 1000 : n
}

export function scanGemini() {
  return scanOauthFile({
    id: 'gemini',
    label: 'Gemini CLI',
    dirs: [join(homedir(), '.gemini'), join(homedir(), '.config', 'gemini')],
    file: 'oauth_creds.json',
    route: 'google',
    displayName: 'Google (Gemini CLI login)',
    pick(doc) {
      if (typeof doc.access_token !== 'string' || doc.access_token.length === 0) return undefined
      return {
        type: 'oauth',
        access: doc.access_token,
        refresh: typeof doc.refresh_token === 'string' ? doc.refresh_token : undefined,
        expires: secondsOrMillis(doc.expiry),
      }
    },
  })
}

export function scanQwen() {
  return scanOauthFile({
    id: 'qwen',
    label: 'Qwen Code',
    dirs: [join(homedir(), '.qwen'), join(homedir(), '.config', 'qwen')],
    file: 'oauth_creds.json',
    route: 'qwen-token-plan',
    displayName: 'Qwen (Qwen Code login)',
    pick(doc) {
      if (typeof doc.access_token !== 'string' || doc.access_token.length === 0) return undefined
      return {
        type: 'oauth',
        access: doc.access_token,
        refresh: typeof doc.refresh_token === 'string' ? doc.refresh_token : undefined,
        expires: secondsOrMillis(doc.expiry_date ?? doc.expiry),
      }
    },
  })
}

const ENV_DIRS = [
  () => process.cwd(),
  () => homedir(),
  () => join(homedir(), '.dsh'),
  () => join(homedir(), '.config', 'dsh'),
  () => join(homedir(), '.config', 'opencode'),
]

/** Parse `KEY=value` lines; quotes and `export ` are tolerated. */
export function parseEnvText(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (value.length > 1 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1)
    if (value.length > 0) out[match[1]] = value
  }
  return out
}

/**
 * `.env` files, which is how many CLIs keep their provider keys.
 * @param extraPaths additional absolute paths supplied by the user
 */
export function scanEnvFiles(extraPaths = []) {
  const source = { id: 'env', label: '.env files', kind: 'env', found: false, path: undefined, items: [], notes: [] }
  const candidates = [...ENV_DIRS.map((dir) => join(dir(), '.env')), ...extraPaths]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    let text
    try { text = readFileSync(path, 'utf8') } catch { continue }
    const entries = parseEnvText(text)
    const keys = Object.keys(entries)
    if (keys.length === 0) continue
    source.found = true
    source.path = source.path ?? path
    source.items.push({
      kind: 'env',
      sourceId: 'env',
      foreignId: path,
      displayName: path,
      entries,
      models: [],
      notes: [`${keys.length} key(s)`],
    })
  }
  if (!source.found) source.notes.push('no .env files found')
  return source
}

export const SCANNERS = [
  ['opencode', scanOpencode],
  ['codex', scanCodex],
  ['claude-code', scanClaudeCode],
  ['gemini', scanGemini],
  ['qwen', scanQwen],
]

export function scanAll(envPaths = []) {
  const sources = SCANNERS.map(([, scan]) => scan())
  sources.push(scanEnvFiles(envPaths))
  return sources
}

export function scanSource(id, envPaths = []) {
  if (id === 'env') return scanEnvFiles(envPaths)
  const entry = SCANNERS.find(([key]) => key === id)
  if (entry === undefined) throw new Error(`unknown source "${id}" (known: ${[...SCANNERS.map(([key]) => key), 'env'].join(', ')})`)
  return entry[1]()
}

export function mask(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return ''
  return `${secret.slice(0, 6)}…(${secret.length} chars)`
}

/** A scan with every secret replaced by a hint, safe for the browser and the model. */
export function redactScan(source) {
  return {
    id: source.id,
    label: source.label,
    kind: source.kind,
    found: source.found,
    path: source.path,
    notes: source.notes ?? [],
    items: (source.items ?? []).map((item) => ({
      kind: item.kind,
      sourceId: item.sourceId,
      foreignId: item.foreignId,
      displayName: item.displayName,
      protocol: item.protocol,
      baseURL: item.baseURL,
      hasKey: typeof item.apiKey === 'string' && item.apiKey.length > 0,
      keyHint: mask(item.apiKey),
      envNames: (item.env ?? []).filter((name) => typeof name === 'string'),
      expires: item.grant?.expires,
      entryNames: item.entries === undefined ? [] : Object.keys(item.entries),
      modelCount: (item.models ?? []).length,
      models: (item.models ?? []).slice(0, 12).map((model) => ({ id: model.id, name: model.name })),
      notes: item.notes ?? [],
    })),
  }
}
