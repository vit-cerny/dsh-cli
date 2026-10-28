/**
 * `dsh-cli migrate` — import skills, MCP servers, sessions and projects from
 * another agent harness into DSH.
 *
 * Sources are described by adapters, so a new harness needs a new
 * {@link SourceAdapter} entry and no change to planning or writing. Measured
 * layout of the only adapter shipped here (opencode, this machine, opencode 2):
 *
 *   config   ~/.config/opencode/opencode.json[c]   (`mcp` map, `skills/`)
 *   data     ~/.local/share/opencode/opencode.db    (SQLite: sessions, projects)
 *
 * Two facts decide what can actually move:
 *
 * - **skills** are directory bundles with a `SKILL.md`, which DSH reads from
 *   `$DSH_HOME/skills/<name>/`, so they are copied verbatim;
 * - **sessions** are only resumable in DSH's own v4 log format
 *   (`sessions/<encoded-cwd>/<id>/session.v4.jsonl.zstd`). opencode keeps them
 *   in SQLite, so they are inventoried and reported as skipped, never
 *   converted: a synthesized log would be a lie about history the runtime
 *   cannot replay.
 *
 * MCP servers convert to `@deepseek-ai/dsh-mcp-client` rows and are written as
 * loader patch fragments under `$DSH_HOME/migrate/mcp/`. DSH does not mount a
 * fragment by itself, so mounting is a deliberate second step: the fragments
 * are meant to be merged into a profile `cordis.patch.yml`, and the command
 * says so rather than editing a profile behind the user's back.
 *
 * Safety rules, enforced here rather than by the caller: planning only reads;
 * a dry run is the default; an existing destination is reported as a skip
 * unless `force` is set; a literal secret refuses the whole server instead of
 * being copied; and every write must resolve inside `$DSH_HOME`.
 *
 * @module src/cli/migrate
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { CliError, resolveDshHome } from './context.js';
import { parseMcpServers } from './info.js';
import { encodeWorkspaceDir, readSessionHeader } from './store.js';

/** File name of a DSH session log inside a session directory. */
const SESSION_LOG = 'session.v4.jsonl.zstd';

/** Markdown entry file of a skill bundle. */
const SKILL_FILE = 'SKILL.md';

/** Loader id of the plugin that consumes one MCP server row per config entry. */
const DSH_MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client';

/** `serverName` pattern enforced by `dsh-mcp-client`; other names cannot load. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Directory names that are portable between the two skill stores. */
const PORTABLE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Bounded walk: a foreign data directory is not a place to spend the command. */
const SCAN_MAX_DEPTH = 5;
const SCAN_MAX_ENTRIES = 4000;
const SCAN_MAX_LOGS = 200;

const DEFAULT_SESSION_LIMIT = 25;
const DEFAULT_PROJECT_LIMIT = 25;

/** Every plan item kind, in the order a plan lists them. */
const ALL_KINDS = Object.freeze(['skill', 'mcp', 'session', 'project']);

/**
 * One planned migration step.
 *
 * `from` and `to` are absolute paths (or `''` when the location is unknown);
 * `data` carries what a `convert` step needs to write, and is never produced
 * for a `skip`.
 *
 * @typedef {object} PlanItem
 * @property {'skill' | 'mcp' | 'session' | 'project'} kind What is migrated.
 * @property {string} name Display name (skill name, server name, session id).
 * @property {string} from Source path.
 * @property {string} to Destination path.
 * @property {'copy' | 'convert' | 'skip'} action What apply would do.
 * @property {string} [reason] Why the item is skipped.
 * @property {Record<string, any>} [data] The DSH config row a `convert` step writes.
 */

/**
 * What `planMigration` returns.
 *
 * @typedef {object} Plan
 * @property {string} source Source id the plan was built from.
 * @property {string} dshHome Destination DSH home.
 * @property {PlanItem[]} items Steps in display order.
 * @property {string[]} notes Source limitations worth printing once.
 */

/**
 * A harness this module knows how to read.
 *
 * An adapter only locates directories; discovery, conversion and planning stay
 * shared, so adding Codex or Gemini means locating its config/data roots here
 * and nothing else.
 *
 * @typedef {object} SourceAdapter
 * @property {string} id Source id used on the command line.
 * @property {string} label Human label in reports.
 * @property {(homeDir: string, env: Record<string, string | undefined>) => string[]} configDirs
 *   Candidate config roots, preferred first.
 * @property {(homeDir: string, env: Record<string, string | undefined>) => string[]} dataDirs
 *   Candidate data roots, preferred first.
 * @property {(configDir: string) => string[]} configFiles Config files to merge, later wins.
 * @property {(configDir: string) => string} skillRoots Directory holding skill bundles.
 * @property {(dataDir: string) => string} database Session database path, or `''`.
 */

/**
 * One detected source, with the inventory planning needs.
 *
 * @typedef {object} SourceRow
 * @property {string} id Source id.
 * @property {string} label Human label.
 * @property {{ config: string[], skills: string, sessions: string }} paths
 *   Directories and files consulted.
 * @property {{ skills: number, mcp: number, sessions: number, projects: number }} counts
 *   Totals, even when the lists below are capped.
 * @property {{ name: string, dir: string }[]} skillList Skill bundles found.
 * @property {{ name: string, entry: object, file: string }[]} mcpList MCP entries found.
 * @property {{ id: string, cwd: string, file: string }[]} sessionList Sessions found;
 *   `file` is empty when the source cannot hand DSH a copyable log.
 * @property {{ name: string, dir: string }[]} projectList Project roots found.
 * @property {string} [dbFile] Session database actually read.
 * @property {string[]} notes Limitations worth printing once.
 */

/**
 * opencode, this machine's primary source.
 *
 * @type {SourceAdapter}
 */
const opencodeAdapter = Object.freeze({
  id: 'opencode',
  label: 'opencode',
  configDirs(homeDir, env) {
    const base = env.XDG_CONFIG_HOME === undefined || env.XDG_CONFIG_HOME === ''
      ? path.join(homeDir, '.config')
      : env.XDG_CONFIG_HOME;
    return [path.join(base, 'opencode')];
  },
  dataDirs(homeDir, env) {
    const base = env.XDG_DATA_HOME === undefined || env.XDG_DATA_HOME === ''
      ? path.join(homeDir, '.local', 'share')
      : env.XDG_DATA_HOME;
    return [path.join(base, 'opencode')];
  },
  // `opencode.jsonc` is the newer, comment-bearing file; it wins over the json.
  configFiles: (configDir) => ['opencode.json', 'opencode.jsonc'].map((name) => path.join(configDir, name)),
  skillRoots: (configDir) => path.join(configDir, 'skills'),
  database: (dataDir) => path.join(dataDir, 'opencode.db'),
});

/** Adapters in detection order; the first entry wins ties in a report. */
const SOURCE_ADAPTERS = Object.freeze([opencodeAdapter]);

/** Source ids accepted by `migrate [source]`. */
export const SOURCE_IDS = Object.freeze(SOURCE_ADAPTERS.map((adapter) => adapter.id));

/**
 * @param {unknown} value Candidate.
 * @returns {value is Record<string, any>} True for a non-array object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read one file, tolerating absence.
 *
 * @param {string} file Absolute path.
 * @returns {string} Contents, or `''`.
 */
function readIfPresent(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Parse JSON with comments and trailing commas.
 *
 * opencode ships `opencode.jsonc`, and comments are the only place some of its
 * settings are explained, so the reader has to accept them. Implemented as a
 * single pass rather than a regex so `//` inside a string stays content.
 *
 * @param {string} text File contents.
 * @returns {any} Parsed value.
 * @throws {SyntaxError} When the text is not JSON-with-comments.
 */
export function parseJsonc(text) {
  const source = String(text).replace(/^\uFEFF/, '');
  let stripped = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      stripped += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      stripped += character;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      stripped += '\n';
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    stripped += character;
  }

  let clean = '';
  inString = false;
  escaped = false;
  for (let index = 0; index < stripped.length; index += 1) {
    const character = stripped[index];
    if (inString) {
      clean += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      clean += character;
      continue;
    }
    if (character === ',') {
      let next = index + 1;
      while (next < stripped.length && /\s/.test(stripped[next])) next += 1;
      if (stripped[next] === '}' || stripped[next] === ']') continue;
    }
    clean += character;
  }
  return JSON.parse(clean);
}

/**
 * Whether a value looks like a credential a repository could capture.
 *
 * Deliberately biased towards refusal: a false positive costs one skipped
 * server the user can add by hand, a false negative leaks a key into a config
 * file. Shape checks only, so no network and no entropy guessing.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} True for anything that must not be written to disk.
 */
export function looksLikeLiteralSecret(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 8) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
  if (/^sk-[A-Za-z0-9_-]{16,}$/.test(text)) return true;
  if (/^Bearer\s+\S{8,}$/i.test(text)) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) return true;
  if (/^(gh[pousr]|glpat|xox[baprs]|npm|pypi)-?[A-Za-z0-9_-]{16,}$/.test(text)) return true;
  if (/^AKIA[0-9A-Z]{16}$/.test(text)) return true;
  if (/^AIza[0-9A-Za-z_-]{30,}$/.test(text)) return true;
  if (/^[0-9a-fA-F]{32,}$/.test(text)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@/i.test(text)) return true;
  if (text.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(text)) {
    // Long single-token values are the shape of base64 keys, not file paths or
    // switch names: a path carries separators and a flag is a word.
    return /[A-Z]/.test(text) && /[a-z]/.test(text) && /[0-9]/.test(text);
  }
  return false;
}

/**
 * Read a credential reference already expressed in the source config.
 *
 * @param {unknown} value Candidate.
 * @returns {string | null} Variable name, or null when this is a literal.
 */
function referenceName(value) {
  if (isRecord(value)) {
    if (typeof value.envVar === 'string' && value.envVar !== '') return value.envVar;
    if (typeof value.env === 'string' && value.env !== '') return value.env;
    return null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text);
  if (braced !== null) return braced[1];
  const bare = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
  if (bare !== null) return bare[1];
  const opencode = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text);
  return opencode === null ? null : opencode[1];
}

/**
 * Convert one env/header map into DSH-shaped values.
 *
 * A reference becomes `{ envVar: 'NAME' }`, which the profile patch renders as
 * `!!js process.env.NAME`; a literal secret refuses the whole server.
 *
 * @param {unknown} map Source `env`/`environment`/`headers` value.
 * @param {string} where Field name, for the skip reason.
 * @returns {{ values: Record<string, string | { envVar: string }>, bad?: string }}
 *   Converted values, or the reason this map cannot be migrated.
 */
function convertReferenceMap(map, where) {
  /** @type {Record<string, string | { envVar: string }>} */
  const values = {};
  if (map === undefined || map === null) return { values };
  if (!isRecord(map)) return { values, bad: `${where} is not an object` };
  for (const [key, value] of Object.entries(map)) {
    if (key === '') continue;
    const reference = referenceName(value);
    if (reference !== null) {
      values[key] = { envVar: reference };
      continue;
    }
    if (typeof value === 'string') {
      if (looksLikeLiteralSecret(value)) {
        return {
          values,
          bad: `literal secret in ${where}.${key}; replace it with a credential reference such as { envVar: "NAME" }`,
        };
      }
      values[key] = value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      values[key] = String(value);
      continue;
    }
    return { values, bad: `unsupported value in ${where}.${key}` };
  }
  return { values };
}

/**
 * Read an opencode `command` field as one executable plus arguments.
 *
 * @param {unknown} value Source `command` (array or string).
 * @returns {{ command: string, args: string[] } | null} Null when unusable.
 */
function commandOf(value) {
  if (typeof value === 'string' && value.trim() !== '') return { command: value.trim(), args: [] };
  if (!Array.isArray(value) || value.length === 0) return null;
  const parts = value.map((entry) => (typeof entry === 'string' ? entry : ''));
  if (parts.some((entry) => entry === '')) return null;
  return { command: parts[0], args: parts.slice(1) };
}

/**
 * @param {object} entry Source server entry.
 * @returns {number | undefined} Per-call timeout in ms, when declared.
 */
function timeoutOf(entry) {
  const value = entry.timeout;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}

/**
 * Convert one opencode MCP entry into a `dsh-mcp-client` config row.
 *
 * Shapes only: `local` becomes stdio, `remote` becomes streamable HTTP. The
 * function never returns a literal secret, and refuses the server instead.
 *
 * @param {string} name Server name (the opencode map key).
 * @param {unknown} entry Source entry.
 * @returns {{ action: 'convert', row: object } | { action: 'skip', reason: string }}
 *   The DSH row, or why it cannot be migrated.
 */
export function convertMcpServer(name, entry) {
  if (typeof name !== 'string' || !SERVER_NAME_PATTERN.test(name)) {
    return { action: 'skip', reason: `"${String(name)}" is not a valid DSH server name ([A-Za-z0-9_-]{1,32})` };
  }
  if (!isRecord(entry)) return { action: 'skip', reason: 'server entry is not an object' };
  if (entry.enabled === false) return { action: 'skip', reason: 'disabled in the source config' };

  const type = typeof entry.type === 'string' && entry.type !== ''
    ? entry.type
    : typeof entry.url === 'string' ? 'remote' : 'local';

  if (type === 'remote') {
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) {
      return { action: 'skip', reason: 'remote server without an http(s) url' };
    }
    const headers = convertReferenceMap(entry.headers, 'headers');
    if (headers.bad !== undefined) return { action: 'skip', reason: headers.bad };
    /** @type {Record<string, any>} */
    const row = { serverName: name, transport: 'streamable-http', url };
    if (Object.keys(headers.values).length > 0) row.headers = headers.values;
    const timeout = timeoutOf(entry);
    if (timeout !== undefined) row.toolCallTimeoutMs = timeout;
    return { action: 'convert', row };
  }

  if (type !== 'local') return { action: 'skip', reason: `unsupported transport "${type}"` };

  const command = commandOf(entry.command);
  if (command === null) return { action: 'skip', reason: 'local server without a usable command' };
  const environment = convertReferenceMap(entry.environment ?? entry.env, 'environment');
  if (environment.bad !== undefined) return { action: 'skip', reason: environment.bad };

  /** @type {Record<string, any>} */
  const row = { serverName: name, transport: 'stdio', command: command.command };
  if (command.args.length > 0) row.args = command.args;
  if (Object.keys(environment.values).length > 0) row.env = environment.values;
  if (typeof entry.cwd === 'string' && entry.cwd !== '') row.cwd = entry.cwd;
  const timeout = timeoutOf(entry);
  if (timeout !== undefined) row.toolCallTimeoutMs = timeout;
  return { action: 'convert', row };
}

/**
 * Render one converted MCP row as a loader patch entry.
 *
 * DSH mounts a server by loading `@deepseek-ai/dsh-mcp-client` with that
 * server's config, so the fragment is an entry-list row rather than JSON. A
 * credential reference becomes `!!js process.env.NAME`, the dialect the loader
 * evaluates at activation, which keeps the key out of the file.
 *
 * @param {Record<string, any>} row Config row from {@link convertMcpServer}.
 * @returns {string[]} YAML lines, without a trailing newline.
 */
export function formatMcpEntry(row) {
  const quote = (value) => JSON.stringify(String(value));
  /** @type {string[]} */
  const lines = [`- id: mcp-${row.serverName}`, `  name: ${quote(DSH_MCP_PLUGIN)}`, '  config:'];
  const scalar = (key, value) => lines.push(`    ${key}: ${quote(value)}`);
  scalar('serverName', row.serverName);
  scalar('transport', row.transport);
  if (row.transport === 'streamable-http') {
    scalar('url', row.url);
  } else {
    scalar('command', row.command);
    if (Array.isArray(row.args) && row.args.length > 0) {
      lines.push('    args:');
      for (const arg of row.args) lines.push(`      - ${quote(arg)}`);
    }
    if (typeof row.cwd === 'string' && row.cwd !== '') scalar('cwd', row.cwd);
  }
  const map = row.transport === 'streamable-http' ? row.headers : row.env;
  if (isRecord(map) && Object.keys(map).length > 0) {
    lines.push(`    ${row.transport === 'streamable-http' ? 'headers' : 'env'}:`);
    for (const [key, value] of Object.entries(map)) {
      const rendered = isRecord(value) && typeof value.envVar === 'string'
        ? `!!js process.env.${value.envVar}`
        : quote(value);
      lines.push(`      ${key}: ${rendered}`);
    }
  }
  if (Number.isFinite(row.toolCallTimeoutMs)) lines.push(`    toolCallTimeoutMs: ${row.toolCallTimeoutMs}`);
  return lines;
}

/**
 * List skill bundles under one root.
 *
 * @param {string} root Directory that should contain `<name>/SKILL.md`.
 * @returns {{ name: string, dir: string }[]} Bundles in name order.
 */
function listSkillBundles(root) {
  /** @type {{ name: string, dir: string }[]} */
  const skills = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    if (!existsSync(path.join(dir, SKILL_FILE))) continue;
    skills.push({ name: entry.name, dir });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Merge the MCP maps of every readable config file, later files winning.
 *
 * @param {string[]} files Candidate config files.
 * @returns {{ servers: { name: string, entry: object, file: string }[], files: string[] }}
 *   Merged servers plus the files that contributed.
 */
function readMcpServers(files) {
  /** @type {Map<string, { name: string, entry: object, file: string }>} */
  const servers = new Map();
  const readable = [];
  for (const file of files) {
    const text = readIfPresent(file);
    if (text.trim() === '') continue;
    readable.push(file);
    let config;
    try {
      config = parseJsonc(text);
    } catch {
      continue; // A broken file must not abort discovery of the other one.
    }
    if (!isRecord(config) || !isRecord(config.mcp)) continue;
    for (const [name, entry] of Object.entries(config.mcp)) {
      if (!isRecord(entry)) continue;
      servers.set(name, { name, entry, file });
    }
  }
  return { servers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)), files: readable };
}

/**
 * Load `node:sqlite` only when a database is actually present.
 *
 * It is a built-in, not a dependency, but an older supported Node may lack it;
 * its absence downgrades the session inventory instead of failing the command.
 *
 * @returns {typeof import('node:sqlite') | null} The module, when available.
 */
function sqliteModule() {
  try {
    return createRequire(import.meta.url)('node:sqlite');
  } catch {
    return null;
  }
}

/**
 * Read opencode's session and project inventory, read-only.
 *
 * @param {string} file Database path (`''` when there is none).
 * @param {number} limit Maximum session rows to keep.
 * @returns {{
 *   readable: boolean,
 *   totalSessions: number,
 *   sessions: { id: string, cwd: string, updatedAt: number }[],
 *   projects: string[],
 * }} Inventory; empty and `readable: false` when unavailable.
 */
function readOpencodeDatabase(file, limit) {
  /** @type {{ readable: boolean, totalSessions: number, sessions: { id: string, cwd: string, updatedAt: number }[], projects: string[] }} */
  const empty = { readable: false, totalSessions: 0, sessions: [], projects: [] };
  if (file === '' || !existsSync(file)) return empty;
  const sqlite = sqliteModule();
  if (sqlite === null) return empty;

  /** @type {any} */
  let database;
  try {
    database = new sqlite.DatabaseSync(file, { readOnly: true });
  } catch {
    return empty;
  }
  const result = { readable: true, totalSessions: 0, sessions: [], projects: [] };
  try {
    // Both tables exist on a migrated install; a union counts each id once.
    try {
      const row = database.prepare('select count(*) as n from (select id from session_v2 union select id from session)').get();
      result.totalSessions = Number(row?.n) || 0;
    } catch {
      result.totalSessions = 0;
    }
    /** @type {Map<string, { id: string, cwd: string, updatedAt: number }>} */
    const sessions = new Map();
    for (const table of ['session_v2', 'session']) {
      let rows;
      try {
        rows = database
          .prepare(`select id, directory, time_updated from "${table}" order by time_updated desc limit ${limit}`)
          .all();
      } catch {
        continue; // A store that predates this table still has the other one.
      }
      for (const row of rows) {
        if (typeof row?.id !== 'string' || row.id === '') continue;
        const seen = sessions.get(row.id);
        if (seen !== undefined) continue;
        sessions.set(row.id, {
          id: row.id,
          cwd: typeof row.directory === 'string' ? row.directory : '',
          updatedAt: Number(row.time_updated) || 0,
        });
      }
    }
    result.sessions = [...sessions.values()];
    try {
      result.projects = database
        .prepare('select distinct worktree from "project" where worktree is not null order by worktree limit 200')
        .all()
        .map((row) => row.worktree)
        .filter((worktree) => typeof worktree === 'string' && worktree !== '');
    } catch {
      result.projects = []; // Older stores keep projects elsewhere; optional.
    }
  } finally {
    try {
      database.close();
    } catch {
      // Closing a read-only handle cannot fail in a way that matters here.
    }
  }
  return result;
}

/**
 * Find DSH v4 session logs under a source data root.
 *
 * Only this format is resumable in DSH, so it is the one artifact copying can
 * honestly move. The walk is depth- and entry-bounded because a foreign data
 * directory also holds caches, logs and tool output.
 *
 * @param {string} root Source data root (`''` when unknown).
 * @returns {string[]} Absolute log paths.
 */
function findSessionLogs(root) {
  /** @type {string[]} */
  const logs = [];
  if (root === '') return logs;
  /** @type {{ dir: string, depth: number }[]} */
  const stack = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < SCAN_MAX_ENTRIES && logs.length < SCAN_MAX_LOGS) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited >= SCAN_MAX_ENTRIES) break;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < SCAN_MAX_DEPTH) stack.push({ dir: full, depth: current.depth + 1 });
        continue;
      }
      if (entry.isFile() && entry.name === SESSION_LOG) logs.push(full);
    }
  }
  return logs;
}

/**
 * Combine copyable logs and database rows into one session inventory.
 *
 * @param {string[]} logs Copyable DSH v4 logs.
 * @param {{ id: string, cwd: string, updatedAt: number }[]} rows Database rows.
 * @param {number} limit Maximum entries kept.
 * @returns {{ sessions: { id: string, cwd: string, file: string }[], unreadable: number }}
 *   Inventory; `unreadable` counts logs whose header could not be decoded.
 */
function mergeSessionInventory(logs, rows, limit) {
  /** @type {Map<string, { id: string, cwd: string, file: string }>} */
  const sessions = new Map();
  /** @type {{ id: string, cwd: string, updatedAt: number }[]} */
  const ordered = [...rows];
  let unreadable = 0;
  for (const file of logs) {
    const header = readSessionHeader(file);
    if (header?.id === undefined) {
      unreadable += 1;
      continue;
    }
    const id = header.id;
    sessions.set(id, { id, cwd: header.cwd ?? '', file });
    if (!ordered.some((row) => row.id === id)) ordered.push({ id, cwd: header.cwd ?? '', updatedAt: 0 });
  }
  // Newest database rows first, then anything only a log could tell us about.
  ordered.sort((a, b) => b.updatedAt - a.updatedAt);
  const merged = [];
  for (const row of ordered) {
    if (merged.length >= limit) break;
    const copyable = sessions.get(row.id);
    merged.push(copyable ?? { id: row.id, cwd: row.cwd, file: '' });
  }
  return { sessions: merged, unreadable };
}

/**
 * Describe one adapter's installation.
 *
 * @param {SourceAdapter} adapter Adapter.
 * @param {string} homeDir User home directory.
 * @param {Record<string, string | undefined>} env Environment to read.
 * @param {{ sessionLimit?: number, projectLimit?: number }} options Caps.
 * @returns {SourceRow | null} The row, or null when the harness is absent.
 */
function describeSource(adapter, homeDir, env, options) {
  const configDir = adapter.configDirs(homeDir, env).find((dir) => existsSync(dir));
  const dataDir = adapter.dataDirs(homeDir, env).find((dir) => existsSync(dir));
  if (configDir === undefined && dataDir === undefined) return null;

  const sessionLimit = Number.isSafeInteger(options.sessionLimit) && options.sessionLimit > 0
    ? options.sessionLimit
    : DEFAULT_SESSION_LIMIT;
  const projectLimit = Number.isSafeInteger(options.projectLimit) && options.projectLimit > 0
    ? options.projectLimit
    : DEFAULT_PROJECT_LIMIT;

  const skillRoot = configDir === undefined ? '' : adapter.skillRoots(configDir);
  const skillList = skillRoot === '' ? [] : listSkillBundles(skillRoot);
  const configFiles = configDir === undefined ? [] : adapter.configFiles(configDir);
  const mcp = readMcpServers(configFiles);
  const dbFile = dataDir === undefined ? '' : adapter.database(dataDir);
  const database = readOpencodeDatabase(dbFile, sessionLimit);
  const inventory = mergeSessionInventory(findSessionLogs(dataDir ?? ''), database.sessions, sessionLimit);
  const projectList = database.projects.slice(0, projectLimit).map((dir) => ({
    name: path.basename(dir) === '' ? dir : path.basename(dir),
    dir,
  }));

  /** @type {string[]} */
  const notes = [];
  if (inventory.sessions.length > 0 && inventory.sessions.every((session) => session.file === '')) {
    notes.push(
      `${inventory.sessions.length} opencode sessions live in ${path.basename(dbFile)} (SQLite); ` +
        'DSH resume needs a v4 log, so they are planned as skips',
    );
  }
  if (!database.readable && dbFile !== '' && existsSync(dbFile)) {
    notes.push(`${dbFile} could not be read read-only; sessions are not populated`);
  }
  if (inventory.unreadable > 0) {
    notes.push(`${inventory.unreadable} session logs had an unreadable header and were ignored`);
  }
  if (database.totalSessions > inventory.sessions.length) {
    notes.push(`${database.totalSessions} sessions exist; the first ${inventory.sessions.length} are listed`);
  }
  if (database.projects.length > projectList.length) {
    notes.push(`${database.projects.length} project roots exist; the first ${projectList.length} are listed`);
  }

  return {
    id: adapter.id,
    label: adapter.label,
    paths: {
      config: mcp.files.length > 0 ? mcp.files : configFiles.filter((file) => existsSync(file)),
      skills: skillRoot,
      sessions: dataDir ?? '',
    },
    counts: {
      skills: skillList.length,
      mcp: mcp.servers.length,
      sessions: Math.max(database.totalSessions, inventory.sessions.length),
      projects: database.projects.length,
    },
    skillList,
    mcpList: mcp.servers,
    sessionList: inventory.sessions,
    projectList,
    ...(dbFile === '' ? {} : { dbFile }),
    notes,
  };
}

/**
 * Detect installed harnesses and inventory what could be migrated.
 *
 * Reads only; nothing is written and no secret value is retained beyond the
 * entry that planning inspects. Adapters are evaluated in a fixed order, with
 * opencode first, and absent harnesses are omitted.
 *
 * @param {string} [homeDir] User home directory (defaults to the real one).
 * @param {Record<string, string | undefined>} [env] Environment to read.
 * @param {{ sessionLimit?: number, projectLimit?: number }} [options] Inventory caps.
 * @returns {SourceRow[]} One row per installed harness.
 */
export function detectSources(homeDir = homedir(), env = process.env, options = {}) {
  /** @type {SourceRow[]} */
  const rows = [];
  for (const adapter of SOURCE_ADAPTERS) {
    const row = describeSource(adapter, homeDir, env, options);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/**
 * @param {string} name Candidate skill name.
 * @returns {boolean} True when the name is portable to the DSH skill store.
 */
function isPortableName(name) {
  return typeof name === 'string' && PORTABLE_NAME_PATTERN.test(name) && name !== '.' && name !== '..';
}

/**
 * @param {string} dshHome DSH home.
 * @param {string} cwd Session working directory.
 * @param {string} id Session id.
 * @returns {string} Session directory, or `''` when the workspace is unknown.
 */
function sessionDirFor(dshHome, cwd, id) {
  if (typeof cwd !== 'string' || cwd === '') return '';
  return path.join(dshHome, 'sessions', encodeWorkspaceDir(cwd), id);
}

/**
 * Ids already present in the DSH session store.
 *
 * Directory names are authoritative here: the store's session directory is the
 * id, so this stays a listing and never decodes a log.
 *
 * @param {string} dshHome DSH home.
 * @returns {Set<string>} Existing session ids.
 */
function existingSessionIds(dshHome) {
  /** @type {Set<string>} */
  const ids = new Set();
  const root = path.join(dshHome, 'sessions');
  let workspaces;
  try {
    workspaces = readdirSync(root, { withFileTypes: true });
  } catch {
    return ids;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    try {
      for (const entry of readdirSync(path.join(root, workspace.name), { withFileTypes: true })) {
        if (entry.isDirectory()) ids.add(entry.name);
      }
    } catch {
      // An unreadable workspace directory cannot prove an id is absent, but it
      // also cannot be written to; treating it as empty keeps the plan honest.
    }
  }
  return ids;
}

/**
 * Server names already configured in any profile or home patch.
 *
 * Reuses the inventory reader, so "already configured" means exactly what
 * `dsh-cli mcp` would report rather than a second opinion.
 *
 * @param {string} dshHome DSH home.
 * @returns {Set<string>} Configured server names.
 */
function existingMcpServers(dshHome) {
  /** @type {Set<string>} */
  const names = new Set();
  const files = [path.join(dshHome, 'cordis.patch.yml')];
  try {
    for (const entry of readdirSync(path.join(dshHome, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(path.join(dshHome, 'profiles', entry.name, 'cordis.patch.yml'));
    }
  } catch {
    // No profiles directory: the home patch alone is the whole stack.
  }
  for (const file of files) {
    for (const name of parseMcpServers(readIfPresent(file))) names.add(name);
  }
  return names;
}

/**
 * @param {PlanItem['kind']} kind Item kind.
 * @param {string} name Display name.
 * @param {string} from Source path.
 * @param {string} to Destination path.
 * @param {PlanItem['action']} action Planned action.
 * @param {string} [reason] Skip reason.
 * @param {object} [data] Convert payload.
 * @returns {PlanItem} The item.
 */
function planItem(kind, name, from, to, action, reason, data) {
  return {
    kind,
    name,
    from,
    to,
    action,
    ...(reason === undefined ? {} : { reason }),
    ...(data === undefined ? {} : { data }),
  };
}

/**
 * Locate a source row by id.
 *
 * @param {string} id Source id.
 * @param {object} options Detection options.
 * @returns {SourceRow} The row.
 * @throws {CliError} When the harness is not installed or the id is unknown.
 */
function findSource(id, options) {
  if (!SOURCE_IDS.includes(id)) {
    throw new CliError(`unknown migration source: ${id}`, {
      hint: `known sources: ${SOURCE_IDS.join(', ')}`,
    });
  }
  const rows = detectSources(options.homeDir ?? homedir(), options.env ?? process.env, options);
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new CliError(`${id} is not installed on this machine`, {
      hint: 'Pass a source detected by `dsh-cli migrate` with no arguments.',
    });
  }
  return row;
}

/**
 * Plan an import from one detected source.
 *
 * Pure: it reads the source row and the DSH store, and decides one item per
 * skill, MCP server, session and project. An existing destination becomes a
 * `skip` with its reason unless `force` is set, so the plan already tells the
 * truth about what apply would do.
 *
 * @param {SourceRow | string} source Detected row, or a source id.
 * @param {{
 *   dshHome?: string,
 *   homeDir?: string,
 *   env?: Record<string, string | undefined>,
 *   force?: boolean,
 *   kinds?: Array<PlanItem['kind']>,
 *   sessionLimit?: number,
 *   projectLimit?: number,
 * }} [options] Destination and filters.
 * @returns {Plan} The plan.
 * @throws {CliError} When a source id names an unknown or absent harness.
 */
export function planMigration(source, options = {}) {
  const row = typeof source === 'string' ? findSource(source, options) : source;
  if (!isRecord(row) || typeof row.id !== 'string') {
    throw new CliError('migrate needs a detected source', {
      hint: `known sources: ${SOURCE_IDS.join(', ')}`,
    });
  }
  const dshHome = options.dshHome ?? resolveDshHome(options.env ?? process.env);
  const force = options.force === true;
  const wanted = new Set(Array.isArray(options.kinds) && options.kinds.length > 0 ? options.kinds : ALL_KINDS);
  /** @type {PlanItem[]} */
  const items = [];

  if (wanted.has('skill')) {
    for (const skill of row.skillList ?? []) {
      const to = path.join(dshHome, 'skills', String(skill.name));
      if (!isPortableName(skill.name)) {
        items.push(planItem('skill', skill.name, skill.dir, to, 'skip', 'name is not portable to the DSH skill store'));
      } else if (existsSync(to) && !force) {
        items.push(planItem('skill', skill.name, skill.dir, to, 'skip', 'destination exists (use --force to overwrite)'));
      } else {
        items.push(planItem('skill', skill.name, skill.dir, to, 'copy'));
      }
    }
  }

  if (wanted.has('mcp')) {
    const configured = existingMcpServers(dshHome);
    for (const server of row.mcpList ?? []) {
      const to = path.join(dshHome, 'migrate', 'mcp', `${String(server.name)}.yml`);
      const converted = convertMcpServer(server.name, server.entry);
      if (converted.action === 'skip') {
        items.push(planItem('mcp', server.name, server.file, to, 'skip', converted.reason));
      } else if (configured.has(server.name)) {
        items.push(planItem('mcp', server.name, server.file, to, 'skip', 'server is already configured in a DSH patch'));
      } else if (existsSync(to) && !force) {
        items.push(planItem('mcp', server.name, server.file, to, 'skip', 'destination exists (use --force to overwrite)'));
      } else {
        items.push(planItem('mcp', server.name, server.file, to, 'convert', undefined, converted.row));
      }
    }
  }

  if (wanted.has('session')) {
    const existing = existingSessionIds(dshHome);
    for (const session of row.sessionList ?? []) {
      const id = String(session.id);
      const to = sessionDirFor(dshHome, session.cwd, id);
      const from = session.file === '' ? row.paths?.sessions ?? '' : session.file;
      if (existing.has(id)) {
        items.push(planItem('session', id, from, to, 'skip', `session ${id} already exists in the DSH store`));
      } else if (session.file === '') {
        items.push(
          planItem('session', id, from, to, 'skip', 'source keeps this session in SQLite; only a DSH v4 log can be copied'),
        );
      } else if (to === '') {
        items.push(planItem('session', id, from, to, 'skip', 'session header names no working directory'));
      } else {
        items.push(planItem('session', id, from, to, 'copy'));
      }
    }
  }

  if (wanted.has('project')) {
    for (const project of row.projectList ?? []) {
      items.push(
        planItem(
          'project',
          project.name,
          row.dbFile ?? row.paths?.sessions ?? '',
          project.dir,
          'skip',
          'DSH registers a workspace when a session starts in a directory; there is nothing to copy',
        ),
      );
    }
  }

  return { source: row.id, dshHome, items, notes: [...(row.notes ?? []), ...planNotes(items)] };
}

/**
 * Notes the plan must carry for the user to finish the import by hand.
 *
 * @param {PlanItem[]} items Planned items.
 * @returns {string[]} Notes, possibly empty.
 */
function planNotes(items) {
  /** @type {string[]} */
  const notes = [];
  if (items.some((item) => item.kind === 'mcp' && item.action === 'convert')) {
    notes.push(
      'converted MCP servers are written as loader patch fragments under migrate/mcp; ' +
        'merge them into a profile cordis.patch.yml to mount them',
    );
  }
  return notes;
}

/**
 * @param {string} file Path to test.
 * @returns {boolean} True for editor backups, which are not skill content.
 */
function isBackupFile(file) {
  return /\.bak($|[.-])/.test(path.basename(file));
}

/**
 * Whether a destination stays inside the DSH home.
 *
 * Every write in this module goes through this check: the import must not gain
 * a way to touch a path the user did not opt into.
 *
 * @param {string} root Resolved DSH home.
 * @param {string} target Candidate destination.
 * @returns {boolean} True when `target` is strictly inside `root`.
 */
function isInside(root, target) {
  if (typeof target !== 'string' || target === '') return false;
  const relative = path.relative(root, path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Write one plan item.
 *
 * @param {PlanItem} item Item with `action` `copy` or `convert`.
 * @returns {void}
 * @throws {Error} When the kind cannot be applied or the source is unreadable.
 */
function writeItem(item) {
  if (item.kind === 'skill') {
    mkdirSync(path.dirname(item.to), { recursive: true });
    cpSync(item.from, item.to, {
      recursive: true,
      force: true,
      filter: (source) => !isBackupFile(source),
    });
    return;
  }
  if (item.kind === 'mcp') {
    mkdirSync(path.dirname(item.to), { recursive: true });
    writeFileSync(item.to, `${formatMcpEntry(item.data ?? {}).join('\n')}\n`);
    return;
  }
  if (item.kind === 'session') {
    mkdirSync(item.to, { recursive: true });
    copyFileSync(item.from, path.join(item.to, SESSION_LOG));
    return;
  }
  throw new Error(`cannot apply a ${item.kind} item`);
}

/**
 * Apply a plan, by default as a dry run.
 *
 * `apply` must be `true` for a single byte to be written. Each item is checked
 * again at write time, because a plan can be stale by the time it is applied:
 * an existing destination is skipped unless `force`, and anything resolving
 * outside `$DSH_HOME` is reported as failed rather than attempted.
 *
 * @param {Plan} plan Plan returned by {@link planMigration}.
 * @param {{ apply?: boolean, force?: boolean, dshHome?: string }} [options] Write controls.
 * @returns {{
 *   applied: number, skipped: number, failed: number, planned: number, dryRun: boolean,
 *   items: { kind: string, name: string, to: string, status: 'applied' | 'skipped' | 'planned' | 'failed', reason?: string }[],
 * }} Per-item outcome plus totals.
 */
export function applyMigration(plan, options = {}) {
  const apply = options.apply === true;
  const force = options.force === true;
  const dshHome = options.dshHome ?? plan?.dshHome ?? resolveDshHome(options.env ?? process.env);
  const root = path.resolve(dshHome);
  const report = { applied: 0, skipped: 0, failed: 0, planned: 0, dryRun: !apply, items: [] };
  const items = Array.isArray(plan?.items) ? plan.items : [];

  for (const item of items) {
    const row = { kind: item.kind, name: item.name, to: item.to, status: 'skipped' };
    if (item.action === 'skip') {
      report.skipped += 1;
      report.items.push({ ...row, ...(item.reason === undefined ? {} : { reason: item.reason }) });
      continue;
    }
    if (!isInside(root, item.to)) {
      report.failed += 1;
      report.items.push({ ...row, status: 'failed', reason: 'destination is outside the DSH home' });
      continue;
    }
    if (!apply) {
      report.planned += 1;
      report.items.push({ ...row, status: 'planned' });
      continue;
    }
    // A session id is the identity of a conversation: force may replace a
    // config fragment, but it may never replace someone else's session.
    if (item.kind === 'session' && existsSync(item.to)) {
      report.skipped += 1;
      report.items.push({ ...row, reason: `session ${item.name} already exists in the DSH store` });
      continue;
    }
    if (existsSync(item.to) && !force) {
      report.skipped += 1;
      report.items.push({ ...row, reason: 'destination exists (use --force to overwrite)' });
      continue;
    }
    try {
      writeItem(item);
      report.applied += 1;
      report.items.push({ ...row, status: 'applied' });
    } catch (error) {
      report.failed += 1;
      report.items.push({ ...row, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
/**
 * Render a plan as plain table lines.
 *
 * Columns are `action kind name target`, with a `reason` column only when at
 * least one item carries one, so a skip never hides its cause. No styling: the
 * caller owns width and colour.
 *
 * @param {Plan} plan Plan to render.
 * @returns {string[]} Header line plus one line per item.
 */
export function formatPlan(plan) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  if (items.length === 0) return ['no items to migrate'];
  const withReason = items.some((item) => typeof item.reason === 'string' && item.reason !== '');
  /** @type {string[]} */
  const columns = withReason
    ? ['action', 'kind', 'name', 'target', 'reason']
    : ['action', 'kind', 'name', 'target'];

  const rows = items.map((item) => {
    const name = typeof item.name === 'string' && item.name !== '' ? item.name : path.basename(item.to ?? '');
    return {
      action: item.action,
      kind: item.kind,
      name,
      target: item.to === '' ? '-' : item.to,
      reason: item.reason ?? '',
    };
  });

  /** @type {Record<string, number>} */
  const widths = {};
  for (const column of columns) {
    widths[column] = Math.max(column.length, ...rows.map((row) => String(row[column]).length));
  }
  /** @param {Record<string, string>} values Values in column order. */
  const line = (values) =>
    columns
      .map((column, index) =>
        index === columns.length - 1 ? String(values[column]) : String(values[column]).padEnd(widths[column]),
      )
      .join('  ')
      .replace(/\s+$/, '');

  /** @type {Record<string, string>} */
  const header = {};
  for (const column of columns) header[column] = column;
  return [line(header), ...rows.map((row) => line(row))];
}

/**
 * Run `dsh-cli migrate`.
 *
 * A dry run is the default: the plan is printed and nothing is written until
 * `--apply`, because a migration that silently overwrites a skill or a session
 * is not recoverable.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @param {{ stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream, source?: string,
 *   apply?: boolean, force?: boolean, json?: boolean, homeDir?: string,
 *   env?: Record<string, string | undefined> }} [options]
 * @returns {number} Exit code.
 */
export function runMigrateCommand(context, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const write = (line) => stdout.write(`${line}\n`);
  const env = options.env ?? context.env ?? process.env;
  const homeDir = options.homeDir ?? env.USERPROFILE ?? env.HOME ?? homedir();

  const sources = detectSources(homeDir, env);
  const requested = options.source;

  if (requested === undefined || requested === '') {
    if (options.json === true) {
      write(JSON.stringify({ sources }));
      return 0;
    }
    if (sources.length === 0) {
      write('no supported harness found on this machine');
      write(`looked for: ${SOURCE_IDS.join(', ')}`);
      return 0;
    }
    write('sources found');
    for (const row of sources) {
      write(
        `  ${row.id.padEnd(10)} ${String(row.counts.skills).padStart(3)} skills  ` +
          `${String(row.counts.mcp).padStart(3)} mcp  ${String(row.counts.sessions).padStart(4)} sessions  ` +
          `${String(row.counts.projects).padStart(3)} projects`,
      );
    }
    write('');
    write('plan an import with: dsh-cli migrate <source>');
    return 0;
  }

  const plan = planMigration(requested, {
    dshHome: context.dshHome,
    homeDir,
    env,
    force: options.force === true,
  });

  if (options.json === true) {
    const report = options.apply === true ? applyMigration(plan, { force: options.force === true }) : null;
    write(JSON.stringify({ plan, report }));
    return 0;
  }

  for (const line of formatPlan(plan)) write(line);

  const counts = plan.items.reduce((acc, item) => {
    acc[item.action] = (acc[item.action] ?? 0) + 1;
    return acc;
  }, /** @type {Record<string, number>} */ ({}));
  write('');
  write(
    `plan: ${counts.copy ?? 0} copy, ${counts.convert ?? 0} convert, ${counts.skip ?? 0} skip`,
  );
  for (const note of plan.notes) write(`note: ${note}`);

  if (options.apply !== true) {
    write('dry run: nothing written. Re-run with --apply to perform it.');
    return 0;
  }

  const report = applyMigration(plan, { force: options.force === true, dshHome: context.dshHome });
  write(`applied ${report.applied}, skipped ${report.skipped}, failed ${report.failed}`);
  for (const item of report.items) {
    if (item.status === 'failed') write(`  failed: ${item.name}: ${item.reason ?? 'unknown error'}`);
  }
  return report.failed > 0 ? 1 : 0;
}