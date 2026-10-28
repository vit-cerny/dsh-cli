/**
 * Token accounting and cost for one session.
 *
 * Verified wire shape (real persisted session log):
 *   `{ inputTokens: 4005, outputTokens: 133, totalTokens: 20522, cacheReadTokens: 16384 }`
 * where `totalTokens` is the whole prompt for that one request, cached prefix
 * included. It is a per-request figure and is never summed here, both because
 * that would double-count the cached prefix and because it does not reliably
 * equal its own components (measured: 220 of 4897 real records disagree). The
 * component counters are the additive ones.
 *
 * Rates come only from the installed pi-ai catalog (`@earendil-works/pi-ai`,
 * the same catalog the runtime builds its model entries from), read lazily and
 * cached for the process. No rate table is hardcoded: a model the catalog does
 * not describe stays unpriced and the UI says "cost unknown", because `$0.0000`
 * would be a wrong number rather than a missing one.
 *
 * One `assistant/message` fans out to one normalized event per content block,
 * each carrying the same `usage` (see `./events.js`); record once per message,
 * not once per event, or every token is counted twice.
 *
 * @module dsh-cli/session/usage
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { DEFAULT_RUNTIME_BIN } from '../rpc/client.js';

/** Where the installed pi-ai package keeps its catalog, under the DSH app dir. */
const CATALOG_RELATIVE_DIR = ['node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data'];

/** Catalog rates are USD per this many tokens. */
const RATE_UNIT = 1_000_000;

/** Chat-model key prefix inside a catalog file (`chat:<model id>`). */
const CHAT_KEY_PREFIX = 'chat:';

/** Parsed catalog files per directory; a status line must not re-read them. */
const FILE_CACHE = new Map();

/** Cross-file model index per directory, built only when a route file misses. */
const INDEX_CACHE = new Map();

/**
 * A cost table in USD per million tokens.
 *
 * @typedef {object} Pricing
 * @property {number} input Uncached input rate.
 * @property {number} output Output rate.
 * @property {number} cacheRead Cached-input read rate.
 * @property {number} cacheWrite Cache-write rate.
 */

/**
 * Aggregated usage for one session.
 *
 * @typedef {object} UsageTotals
 * @property {number} inputTokens Summed uncached input tokens.
 * @property {number} outputTokens Summed output tokens.
 * @property {number} cacheReadTokens Summed cached-input tokens.
 * @property {number} totalTokens Sum of the three counters above.
 * @property {number} calls Usage records accepted.
 * @property {number|null} costUsd Cost in USD, or `null` when unpriced.
 * @property {boolean} priced Whether a rate table matched this route.
 */

/**
 * @param {unknown} value Candidate object.
 * @returns {value is Record<string, any>} True for a non-array object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read a non-negative number from a number or a numeric string. Used for token
 * counts and rates, both of which are wire values that may arrive as strings.
 *
 * @param {unknown} value Wire value.
 * @returns {number|null} The value, or `null` when it is not a non-negative number.
 */
function toCount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * Normalize a cost table, keeping only tables that can actually price a call.
 *
 * @param {unknown} cost Candidate table (`{ input, output, cacheRead, cacheWrite }`).
 * @returns {Pricing|null} Complete table, or `null` when input or output is absent.
 */
function normalizeRates(cost) {
  if (!isRecord(cost)) return null;
  const input = toCount(cost.input);
  const output = toCount(cost.output);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cacheRead: toCount(cost.cacheRead) ?? 0,
    cacheWrite: toCount(cost.cacheWrite) ?? 0,
  };
}

/**
 * Split a provider-reported usage record into its additive parts.
 *
 * A record carrying only `totalTokens` cannot be attributed to any component,
 * so it is rejected rather than counted as an unattributed lump sum.
 *
 * @param {unknown} usage Wire usage object.
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens: number }|null}
 *   Counts, or `null` when nothing can be attributed.
 */
function readUsage(usage) {
  if (!isRecord(usage)) return null;
  const input = toCount(usage.inputTokens);
  const output = toCount(usage.outputTokens);
  const cacheRead = toCount(usage.cacheReadTokens);
  if (input === null && output === null && cacheRead === null) return null;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead ?? 0,
  };
}

/**
 * Directory holding the installed catalog, derived from the runtime entry point
 * exactly as `src/rpc/client.js` resolves it: env override first, then the
 * bundled install.
 *
 * @param {{ runtimeBin?: string, env?: Record<string, string | undefined>, catalogDir?: string }} [options]
 *   Overrides; `catalogDir` wins outright.
 * @returns {string|null} Absolute directory, or `null` when the app dir cannot be derived.
 */
function resolveCatalogDir(options = {}) {
  if (typeof options.catalogDir === 'string' && options.catalogDir !== '') return options.catalogDir;
  const env = options.env ?? process.env;
  const runtimeBin = options.runtimeBin ?? env.DSH_CLI_RUNTIME_BIN ?? DEFAULT_RUNTIME_BIN;
  if (typeof runtimeBin !== 'string' || runtimeBin === '') return null;
  // The app dir is everything above the install's own `node_modules`.
  const marker = runtimeBin.search(/[\\/]node_modules[\\/]/);
  if (marker < 0) return null;
  return path.join(runtimeBin.slice(0, marker), ...CATALOG_RELATIVE_DIR);
}

/**
 * Read and cache one catalog file. A missing or corrupt file caches as `null`,
 * so a broken install costs one failed read, not one per sample.
 *
 * @param {string} dir Catalog directory.
 * @param {string} file File name inside it.
 * @param {(file: string, encoding: string) => string} readFile Reader.
 * @returns {unknown|null} Parsed JSON, or `null`.
 */
function readCatalogFile(dir, file, readFile) {
  let byFile = FILE_CACHE.get(dir);
  if (byFile === undefined) {
    byFile = new Map();
    FILE_CACHE.set(dir, byFile);
  }
  if (byFile.has(file)) return byFile.get(file);
  let parsed = null;
  try {
    parsed = JSON.parse(String(readFile(path.join(dir, file), 'utf8')));
  } catch {
    parsed = null;
  }
  byFile.set(file, parsed);
  return parsed;
}

/**
 * Every chat model a parsed catalog file describes.
 *
 * The file nests groups by wire protocol (`openai-completions`, …) and keys
 * models as `chat:<id>`; the key is authoritative when `id` is empty, which
 * happens in catalogs written by a third-party gateway.
 *
 * @param {unknown} parsed Parsed catalog file.
 * @returns {{ id: string, rates: Pricing }[]} Models with a usable rate table.
 */
function catalogModels(parsed) {
  /** @type {{ id: string, rates: Pricing }[]} */
  const models = [];
  if (!isRecord(parsed)) return models;
  for (const group of Object.values(parsed)) {
    if (!isRecord(group)) continue;
    for (const [key, entry] of Object.entries(group)) {
      if (!isRecord(entry)) continue;
      if (!key.startsWith(CHAT_KEY_PREFIX) && entry.type !== 'chat') continue;
      const id = typeof entry.id === 'string' && entry.id !== ''
        ? entry.id
        : key.slice(CHAT_KEY_PREFIX.length);
      const rates = normalizeRates(entry.cost);
      if (id !== '' && rates !== null) models.push({ id, rates });
    }
  }
  return models;
}

/**
 * Rates for one model from one catalog file.
 *
 * @param {string} dir Catalog directory.
 * @param {string} file File name.
 * @param {string} model Model id.
 * @param {(file: string, encoding: string) => string} readFile Reader.
 * @returns {Pricing|null} Rates, or `null` when the file does not describe it.
 */
function ratesFromFile(dir, file, model, readFile) {
  return catalogModels(readCatalogFile(dir, file, readFile)).find((entry) => entry.id === model)?.rates ?? null;
}

/**
 * Provider route keys whose catalog file might describe the route.
 *
 * A DSH route is not a pi-ai provider id: `deepseek-official` and
 * `deepseek-account` both serve the catalog's `deepseek` table.
 *
 * @param {string} provider Provider route key.
 * @returns {string[]} Candidate file stems, longest first.
 */
function providerStems(provider) {
  const parts = provider.split('-');
  const stems = [];
  for (let length = parts.length - 1; length >= 1; length -= 1) {
    stems.push(parts.slice(0, length).join('-'));
  }
  return stems;
}

/**
 * Build (and cache) a model-id index across every catalog file.
 *
 * @param {string} dir Catalog directory.
 * @param {(file: string, encoding: string) => string} readFile Reader.
 * @param {(dir: string) => string[]} readdir Directory lister.
 * @returns {Map<string, { file: string, rates: Pricing }[]>} Candidates by model id.
 */
function buildIndex(dir, readFile, readdir) {
  const cached = INDEX_CACHE.get(dir);
  if (cached !== undefined) return cached;

  /** @type {Map<string, { file: string, rates: Pricing }[]>} */
  const index = new Map();
  let files = [];
  try {
    files = readdir(dir).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
  } catch {
    files = [];
  }
  for (const file of files) {
    for (const model of catalogModels(readCatalogFile(dir, file, readFile))) {
      const hits = index.get(model.id);
      if (hits === undefined) index.set(model.id, [{ file, rates: model.rates }]);
      else hits.push({ file, rates: model.rates });
    }
  }
  INDEX_CACHE.set(dir, index);
  return index;
}

/**
 * Look up a model's rates in the installed pi-ai catalog.
 *
 * Matching is deliberately narrow, because a guessed rate is worse than none:
 * the route's own catalog file wins, then a file named after the route's
 * provider stem, and only then a cross-file match — and that last one is used
 * only when every file naming the model agrees, since 102 of the 1089 model ids
 * in the installed catalog carry conflicting rates across providers.
 *
 * `options.override` is consulted last, per the contract's "fall back to a
 * profile-declared override". The installed `dsh-llm-pi-ai` config schema has no
 * cost field (`cost: base?.cost ?? NO_COST`), so no profile can declare rates
 * today; a caller-supplied table is the only override that exists.
 *
 * @param {{ provider?: string, model?: string }} route Provider route and model id.
 * @param {object} [options] Lookup options.
 * @param {string} [options.catalogDir] Catalog directory override (tests).
 * @param {string} [options.runtimeBin] Runtime entry point to derive the app dir from.
 * @param {Record<string, string | undefined>} [options.env] Environment to read.
 * @param {Pricing} [options.override] Fallback table when the catalog has no match.
 * @param {(file: string, encoding: string) => string} [options.readFile] Reader (cached after first use).
 * @param {(dir: string) => string[]} [options.readdir] Directory lister.
 * @returns {Pricing|null} Rates in USD per million tokens, or `null` when unpriced.
 */
export function lookupPricing(route, options = {}) {
  const provider = typeof route?.provider === 'string' ? route.provider.trim() : '';
  const model = typeof route?.model === 'string' ? route.model.trim() : '';
  const readFile = options.readFile ?? readFileSync;
  const readdir = options.readdir ?? readdirSync;
  const dir = resolveCatalogDir(options);

  if (dir !== null && provider !== '' && model !== '') {
    const exact = ratesFromFile(dir, `${provider}.json`, model, readFile);
    if (exact !== null) return { ...exact };

    for (const stem of providerStems(provider)) {
      const stemmed = ratesFromFile(dir, `${stem}.json`, model, readFile);
      if (stemmed !== null) return { ...stemmed };
    }

    const hits = buildIndex(dir, readFile, readdir).get(model) ?? [];
    const distinct = new Set(hits.map((hit) => JSON.stringify(hit.rates)));
    if (distinct.size === 1) return { ...hits[0].rates };
  }

  return normalizeRates(options.override);
}

/**
 * Aggregate usage records for one route.
 *
 * Rates resolve on first use rather than in the constructor, so building a meter
 * never touches the disk.
 */
export class UsageMeter {
  /** @type {string} */
  #provider;
  /** @type {string} */
  #model;
  /** @type {object} */
  #lookupOptions;
  /** @type {Pricing|null} */
  #rates = null;
  /** @type {boolean} */
  #resolved = false;
  /** @type {number} */
  #inputTokens = 0;
  /** @type {number} */
  #outputTokens = 0;
  /** @type {number} */
  #cacheReadTokens = 0;
  /** @type {number} */
  #calls = 0;

  /**
   * @param {object} [init] Route and pricing.
   * @param {string} [init.provider] Provider route key, e.g. `deepseek-official`.
   * @param {string} [init.model] Model id, e.g. `deepseek-flash`.
   * @param {Pricing|null} [init.pricing] Explicit table; omit to look one up.
   * @param {string} [init.catalogDir] Catalog directory override, passed to `lookupPricing`.
   * @param {Pricing} [init.override] Fallback table, passed to `lookupPricing`.
   * @param {(file: string, encoding: string) => string} [init.readFile] Reader, passed to `lookupPricing`.
   */
  constructor({ provider, model, pricing, ...lookupOptions } = {}) {
    this.#provider = typeof provider === 'string' ? provider : '';
    this.#model = typeof model === 'string' ? model : '';
    this.#lookupOptions = lookupOptions;
    // An explicit `null` means "this route is known to be unpriced".
    this.#resolved = pricing !== undefined;
    this.#rates = normalizeRates(pricing);
  }

  /**
   * The table this meter prices against, resolved once per instance.
   *
   * @returns {Pricing|null} Rates, or `null` when the route is unpriced.
   */
  #resolveRates() {
    if (!this.#resolved) {
      this.#resolved = true;
      this.#rates = lookupPricing(
        { provider: this.#provider, model: this.#model },
        this.#lookupOptions,
      );
    }
    return this.#rates;
  }

  /**
   * Add one provider-reported usage record.
   *
   * Null, malformed and negative records are dropped: this runs on the event
   * path, where a throw would take down the turn that reported it.
   *
   * @param {unknown} usage The `usage` object from an `assistant/message`.
   * @returns {void}
   */
  record(usage) {
    try {
      const counts = readUsage(usage);
      if (counts === null) return;
      this.#inputTokens += counts.inputTokens;
      this.#outputTokens += counts.outputTokens;
      this.#cacheReadTokens += counts.cacheReadTokens;
      this.#calls += 1;
    } catch {
      // A rejected record loses one datum; throwing would fail the session.
    }
  }

  /**
   * Cumulative totals. `totalTokens` is derived from the additive counters,
   * because the provider's own total already repeats the cached prefix.
   *
   * @returns {UsageTotals} A fresh snapshot; mutating it cannot corrupt the meter.
   */
  get totals() {
    const rates = this.#resolveRates();
    const costUsd = rates === null
      ? null
      : (this.#inputTokens * rates.input +
          this.#outputTokens * rates.output +
          this.#cacheReadTokens * rates.cacheRead) /
        RATE_UNIT;
    return {
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      cacheReadTokens: this.#cacheReadTokens,
      totalTokens: this.#inputTokens + this.#outputTokens + this.#cacheReadTokens,
      calls: this.#calls,
      costUsd,
      priced: rates !== null,
    };
  }

  /**
   * @returns {boolean} False when no rate table matched, so the UI can say
   *   "cost unknown" instead of inventing a number.
   */
  get priced() {
    return this.#resolveRates() !== null;
  }

  /**
   * Drop the counters, keeping the resolved route pricing.
   *
   * @returns {void}
   */
  reset() {
    this.#inputTokens = 0;
    this.#outputTokens = 0;
    this.#cacheReadTokens = 0;
    this.#calls = 0;
  }
}

/**
 * Compact token count for a status segment: `999`, `12.3k`, `1.25M`.
 *
 * @param {unknown} value Token count.
 * @returns {string} Short label.
 */
function formatTokens(value) {
  const count = Math.max(0, Math.trunc(Number(value) || 0));
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${trimZeros((count / 1000).toFixed(1))}k`;
  return `${trimZeros((count / 1_000_000).toFixed(2))}M`;
}

/**
 * `12.0k` reads as noise, so drop a trailing zero fraction.
 *
 * @param {string} value Fixed-point number.
 * @returns {string} Shortened number.
 */
function trimZeros(value) {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

/**
 * Money for a status segment.
 *
 * @param {number|null|undefined} costUsd Cost in USD.
 * @param {boolean} [priced] Whether a rate table matched.
 * @returns {string} `$0.0042`, `<$0.0001`, or `cost unknown`.
 */
export function formatCost(costUsd, priced) {
  if (priced === false) return 'cost unknown';
  if (costUsd === null || costUsd === undefined) return 'cost unknown';
  const value = Number(costUsd);
  if (!Number.isFinite(value) || value < 0) return 'cost unknown';
  if (value === 0) return '$0.0000';
  // Rounding a real charge down to `$0.0000` would read as free.
  if (value < 0.0001) return '<$0.0001';
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/**
 * One-line usage summary for the transcript or status line.
 *
 * @param {UsageTotals|object|null} totals Meter totals.
 * @returns {string} e.g. `12.3k in · 4.1k out · 9.2k cached · $0.0042`.
 */
export function formatUsage(totals) {
  const source = isRecord(totals) ? totals : {};
  return [
    `${formatTokens(source.inputTokens)} in`,
    `${formatTokens(source.outputTokens)} out`,
    `${formatTokens(source.cacheReadTokens)} cached`,
    formatCost(source.costUsd, source.priced),
  ].join(' · ');
}
