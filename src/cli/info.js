/**
 * `dsh-cli models | providers | skills | mcp` — read-only inventory commands.
 *
 * Two sources answer them, in this order:
 *
 * 1. **the profile patch layer** (`~/.dsh/profiles/<profile>/cordis.patch.yml`
 *    plus the managed block in `~/.dsh/cordis.patch.yml`). This is the same file
 *    DSH Desktop reads, which is exactly what "synced with Desktop" means: the
 *    CLI reports what the profile says, not a private copy.
 * 2. **the live runtime**, used only for `skills`, where the authoritative
 *    catalog is assembled by the runtime and reaches the client through the
 *    system prompt event. Asking the runtime costs one process and a full
 *    cold start (~4 s measured), so `skills` only does that when the on-disk
 *    scan finds nothing.
 *
 * Nothing here writes, and no secret value is ever read or printed: only
 * credential *reference names* (e.g. `DEEPSEEK_API_KEY`), never the key.
 *
 * @module src/cli/info
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { readSessionSummaries, formatSessionRow } from './store.js';

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
 * @typedef {object} LlmRoute
 * @property {string} id Loader id of the LLM plugin (`llm-pi-ai`, `llm-deepseek`, …).
 * @property {string} [provider] Provider route key inside the plugin's `providers:` map.
 * @property {string} [baseURL] Endpoint root, when the patch names one.
 * @property {string} [apiKeyEnv] Credential *reference* name, never a key.
 * @property {{ id: string, name?: string }[]} models
 */

/**
 * @typedef {object} ProfileInventory
 * @property {LlmRoute[]} routes
 * @property {string[]} mcpServers Server names from profile/home patches.
 * @property {string} mcpSource Patch files consulted for MCP servers.
 * @property {string} sourcePatch Patch file the LLM routes came from.
 */

/**
 * Parse the LLM plugin blocks out of a loader patch.
 *
 * The patch dialect is YAML with `- id: <loader-id>` entries. This reads only
 * the keys the inventory needs (`providers:` route keys, `baseURL`,
 * `apiKeyEnv`, and the `models:` list) by indentation — deliberately not a
 * YAML parser. One route is returned per provider key, so `models` can mark
 * the active provider/model pair.
 *
 * @param {string} text Patch contents.
 * @param {string[]} pluginIds Extra loader ids to treat as LLM plugins.
 * @returns {LlmRoute[]} Routes in file order.
 */
export function parseLlmRoutes(text, pluginIds = []) {
  /** @type {LlmRoute[]} */
  const routes = [];
  if (typeof text !== 'string' || text === '') return routes;
  const ids = new Set(pluginIds);

  /** @type {{ id: string, pending: boolean, indent: number } | null} */
  let plugin = null;
  /** @type {LlmRoute | null} */
  let current = null;
  /** @type {{ indent: number, itemIndent?: number } | null} */
  let inModels = null;
  /** @type {{ indent: number } | null} */
  let inProviders = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (line.trim() === '') continue;
    const indent = /^\s*/.exec(line)[0].length;

    const idMatch = /^(\s*)-\s+id\s*:\s*(.+?)\s*$/.exec(line);
    if (idMatch !== null && idMatch[1].length <= 4 && (plugin === null || idMatch[1].length <= plugin.indent)) {
      const value = idMatch[2].replace(/^['"]|['"]$/g, '');
      // `llm-pi-ai`, `llm-deepseek`, … but not `agent-teams` or `dsh-mcp-config`.
      const isLlm = ids.has(value) || /^llm-/.test(value);
      plugin = isLlm ? { id: value, pending: true, indent: idMatch[1].length } : null;
      current = null;
      inModels = null;
      inProviders = null;
      continue;
    }
    if (plugin === null) continue;

    if (inModels !== null && indent > inModels.indent) {
      const itemMatch = /^\s*-\s+(.+?)\s*$/.exec(line);
      if (itemMatch !== null && current !== null) {
        // Only count items at the model-list level; nested `input: [text, image]`
        // metadata is deeper and must not become phantom models.
        inModels.itemIndent ??= indent;
        if (indent === inModels.itemIndent) {
          const raw = itemMatch[1].replace(/^['"]|['"]$/g, '');
          const keyed = /^id\s*:\s*(.+)$/.exec(raw);
          const id = (keyed === null ? raw : keyed[1]).replace(/^['"]|['"]$/g, '');
          if (id !== '') current.models.push({ id });
        }
      }
      continue;
    }
    inModels = null;

    if (inProviders !== null) {
      if (indent <= inProviders.indent) {
        inProviders = null;
      } else if (indent === inProviders.indent + 2) {
        const name = /^\s*([A-Za-z0-9_.-]+)\s*:\s*$/.exec(line);
        if (name !== null) {
          current = { id: plugin.id, provider: name[1], models: [] };
          routes.push(current);
          inModels = null;
          continue;
        }
      }
      // Deeper lines under the current provider (baseURL, models, …) fall through.
    }

    const keyed = /^\s*(providers|provider|model|baseURL|apiKeyEnv|apiKey|models)\s*:\s*(.*)$/.exec(line);
    if (keyed === null) continue;
    const [, key, rawValue] = keyed;
    const value = rawValue.replace(/^['"]|['"]$/g, '');

    if (key === 'providers') {
      inProviders = { indent };
      current = null;
      continue;
    }

    // A single-provider plugin (`provider:`/`model:` pair, no `providers:` map).
    if (current === null && (key === 'provider' || key === 'model')) {
      current = { id: plugin.id, models: [] };
      routes.push(current);
    }
    if (current === null) continue;

    if (key === 'models') {
      inModels = { indent };
    } else if (key === 'apiKeyEnv' && value !== '') {
      current.apiKeyEnv = value;
    } else if (key === 'apiKey') {
      // A literal key in the patch is a secret: record the fact, never the value.
      current.apiKeyEnv = current.apiKeyEnv ?? '<literal apiKey in patch>';
    } else if (key === 'baseURL' && value !== '') {
      current.baseURL = value;
    } else if ((key === 'provider' || key === 'model') && value !== '' && current.models.length === 0) {
      current.models.push({ id: value });
    }
  }
  // Drop entries that never named a model or a credential reference.
  return routes.filter((route) => route.models.length > 0 || route.apiKeyEnv !== undefined);
}

/**
 * Fold multi-route plugins into one entry per provider for display.
 *
 * @param {LlmRoute[]} routes Parsed routes.
 * @returns {LlmRoute[]} One entry per `(plugin id, provider key)`.
 */
export function mergeRoutes(routes) {
  /** @type {Map<string, LlmRoute>} */
  const merged = new Map();
  for (const route of routes) {
    const key = `${route.id}\u0000${route.provider ?? ''}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...route, models: [...route.models] });
      continue;
    }
    if (existing.baseURL === undefined && route.baseURL !== undefined) existing.baseURL = route.baseURL;
    if (existing.apiKeyEnv === undefined && route.apiKeyEnv !== undefined) existing.apiKeyEnv = route.apiKeyEnv;
    for (const model of route.models) {
      if (!existing.models.some((entry) => entry.id === model.id)) existing.models.push(model);
    }
  }
  return [...merged.values()];
}

/** Loader ids that mount an LLM provider route. */
export const LLM_PLUGIN_IDS = Object.freeze([
  'llm-pi-ai',
  'pi-ai',
  'llm-deepseek',
  'llm-anthropic',
  'llm-openai',
  'llm-ollama',
]);

/**
 * Server names in the managed MCP block of `~/.dsh/cordis.patch.yml`.
 *
 * @param {string} text CODEX/MCP patch contents.
 * @returns {string[]} Server names.
 */
export function parseMcpServers(text) {
  if (typeof text !== 'string') return [];
  const names = new Set();
  const lines = text.split(/\r?\n/);
  let inMcp = false;
  let inServers = false;
  let serversIndent = 0;
  let mcpIndent = 0;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (line.trim() === '') continue;
    const indent = /^\s*/.exec(line)[0].length;
    if (/^\s*-?\s*id\s*:\s*['"]?.*mcp/.test(line) && indent <= mcpIndent + 2) {
      inMcp = true;
      mcpIndent = indent;
      inServers = false;
      continue;
    }
    if (!inMcp) continue;
    if (indent < mcpIndent) {
      inMcp = false;
      inServers = false;
      continue;
    }
    const serversKey = /^\s*servers\s*:\s*$/.exec(line);
    if (serversKey !== null) {
      inServers = true;
      serversIndent = indent;
      continue;
    }
    if (!inServers) continue;
    if (indent <= serversIndent) {
      inServers = false;
      continue;
    }
    const entry = /^\s*([A-Za-z0-9_.-]+)\s*:\s*$/.exec(line);
    if (entry !== null && indent === serversIndent + 2) names.add(entry[1]);
  }
  return [...names];
}

/**
 * List configured MCP server names from the selected profile and home patch.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @returns {{ servers: string[], source: string }} Names and files consulted.
 */
export function mcpServersFor(context) {
  const files = [
    path.join(context.dshHome, 'profiles', context.profile, 'cordis.patch.yml'),
    path.join(context.dshHome, 'cordis.patch.yml'),
  ];
  const servers = new Set();
  const readable = [];
  for (const file of files) {
    const text = readIfPresent(file);
    if (text === '') continue;
    readable.push(file);
    for (const name of parseMcpServers(text)) servers.add(name);
  }
  return {
    servers: [...servers],
    source: readable.length > 0 ? readable.join(' + ') : `${files.join(' + ')} (not found)`,
  };
}

/**
 * Build the on-disk inventory for the active profile.
 *
 * Layer order mirrors the runtime's own patch stack (measured in
 * `dsh/lib/profile-boot-*.js`): bundle layers → the profile's
 * `cordis.patch.yml` → the home-level `$DSH_HOME/cordis.patch.yml`, which
 * outranks the profile layer. Both are read; the home layer is listed last so
 * its routes appear after (and win over) the profile's.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @param {{ dshHome?: string }} [options] Override the DSH home (tests).
 * @returns {ProfileInventory} Inventory.
 */
export function readProfileInventory(context, options = {}) {
  const dshHome = options.dshHome ?? context.dshHome;
  const profilePatch = path.join(dshHome, 'profiles', context.profile, 'cordis.patch.yml');
  const homePatch = path.join(dshHome, 'cordis.patch.yml');

  /** @type {LlmRoute[]} */
  const routes = [];
  /** @type {string[]} */
  const sources = [];
  for (const file of [profilePatch, homePatch]) {
    const text = readIfPresent(file);
    if (text === '') continue;
    sources.push(file);
    routes.push(...parseLlmRoutes(text, LLM_PLUGIN_IDS));
  }
  const mcp = mcpServersFor({ ...context, dshHome });
  return {
    routes: mergeRoutes(routes),
    mcpServers: mcp.servers,
    mcpSource: mcp.source,
    sourcePatch: sources.length > 0 ? sources.join(' + ') : profilePatch,
  };
}

/**
 * Render `models` / `providers` as plain text lines.
 *
 * @param {ProfileInventory} inventory Inventory.
 * @param {{ provider: string, model: string }} active Active route.
 * @param {'models' | 'providers'} mode Which view.
 * @returns {string[]} Lines (no trailing newline each).
 */
export function formatInventory(inventory, active, mode) {
  /** @type {string[]} */
  const lines = [];
  if (inventory.routes.length === 0) {
    return [
      `no provider routes found in ${inventory.sourcePatch}`,
      `the runtime will still resolve the active route during initialize: ${active.provider} / ${active.model}`,
    ];
  }
  for (const route of inventory.routes) {
    const key = route.apiKeyEnv === undefined ? '' : `  key=${route.apiKeyEnv}`;
    const label = route.provider === undefined ? route.id : `${route.provider}  (${route.id})`;
    if (mode === 'providers') {
      lines.push(`${label}${route.baseURL === undefined ? '' : `  ${route.baseURL}`}${key}`);
      lines.push(`  models: ${route.models.length}`);
      continue;
    }
    const routeActive = route.provider === undefined ? route.models.some((entry) => entry.id === active.model) : route.provider === active.provider;
    lines.push(`${routeActive ? '*' : ' '} ${label}  (${route.models.length} models)${key}`);
    for (const model of route.models) {
      const activeMark = model.id === active.model && routeActive ? '*' : ' ';
      lines.push(`  ${activeMark} ${model.id}`);
    }
  }
  if (mode === 'models') {
    lines.push('');
    lines.push(`active: ${active.provider} / ${active.model}  (source: ${inventory.sourcePatch})`);
  }
  return lines;
}

/**
 * List skill directories the runtime will mount.
 *
 * @param {string} dshHome DSH home directory.
 * @returns {string[]} Skill directory names, sorted.
 */
export function listSkills(dshHome) {
  const root = path.join(dshHome, 'skills');
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Extract skill names from the runtime's `<available_skills>` system prompt
 * block, which every SDK client receives as a `system` event.
 *
 * @param {string} text System prompt text.
 * @returns {string[]} Skill names, in prompt order.
 */
export function skillsFromSystemPrompt(text) {
  if (typeof text !== 'string') return [];
  const names = [];
  const pattern = /^\s*-\s+`([^`]+)`\s*:/gm;
  let match;
  while ((match = pattern.exec(text)) !== null) names.push(match[1]);
  return names;
}

/**
 * Print a `providers | models | skills | mcp` listing.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @param {'providers' | 'models' | 'skills' | 'mcp'} command Which listing.
 * @param {{ stdout?: NodeJS.WriteStream, dshHome?: string, json?: boolean }} [options] Overrides for tests.
 * @returns {number} Exit code.
 */
export function runInfoCommand(context, command, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const write = (line) => stdout.write(`${line}\n`);
  const dshHome = options.dshHome ?? context.dshHome;

  if (command === 'skills') {
    const names = listSkills(dshHome);
    if (options.json === true) {
      write(JSON.stringify({ skills: names, source: path.join(dshHome, 'skills') }));
      return 0;
    }
    if (names.length === 0) {
      write(`no skills found under ${path.join(dshHome, 'skills')}`);
      write(
        'the runtime also mounts skills from installed bundles; run any prompt to see the live <available_skills> catalog',
      );
      return 0;
    }
    write(`${names.length} skills (source: ${path.join(dshHome, 'skills')})`);
    for (const name of names) write(`  ${name}`);
    return 0;
  }

  if (command === 'mcp') {
    const inventory = readProfileInventory(context, { dshHome });
    if (options.json === true) {
      write(JSON.stringify({ servers: inventory.mcpServers, source: inventory.mcpSource }));
      return 0;
    }
    if (inventory.mcpServers.length === 0) {
      write('no MCP servers configured');
      write(`(looked in ${inventory.mcpSource})`);
      return 0;
    }
    write(`${inventory.mcpServers.length} MCP servers`);
    for (const name of inventory.mcpServers) write(`  ${name}`);
    return 0;
  }

  const inventory = readProfileInventory(context, { dshHome });
  const active = { provider: context.provider, model: context.model };
  if (options.json === true) {
    write(JSON.stringify({ ...inventory, active }));
    return 0;
  }
  for (const line of formatInventory(inventory, active, command === 'models' ? 'models' : 'providers')) {
    write(line);
  }
  return 0;
}

/**
 * Print the persisted-session listing (`dsh-cli sessions`).
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @param {{ stdout?: NodeJS.WriteStream, dshHome?: string, limit?: number }} [options]
 *   Overrides for tests.
 * @returns {number} Exit code.
 */
export function runSessionsCommand(context, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const dshHome = options.dshHome ?? context.dshHome;
  const rows = readSessionSummaries(dshHome, { limit: options.limit ?? 20 });
  if (rows.length === 0) {
    stdout.write(`no persisted sessions found under ${path.join(dshHome, 'sessions')}\n`);
    return 0;
  }
  stdout.write(`${rows.length} most recent sessions (newest activity first)\n`);
  const now = Date.now();
  for (const row of rows) stdout.write(`${formatSessionRow(row, now)}\n`);
  stdout.write('\nreopen one with: dsh-cli resume <sessionId>\n');
  return 0;
}
