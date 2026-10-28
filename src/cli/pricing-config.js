/**
 * User-supplied rates for routes the installed catalog does not describe.
 *
 * The catalog that ships with Desktop covers first-party providers. A third-party
 * gateway (the default route on this machine is one) has no entry, and the meter
 * then reports "cost unknown" rather than inventing a number. That is correct but
 * unhelpful, so this module lets the user declare the real rates once.
 *
 * File: `$DSH_HOME/dsh-cli-pricing.json`
 *
 * ```json
 * {
 *   "logfare/deepseek-v4.1-flash-1017": { "input": 0.28, "output": 1.1, "cacheRead": 0.03 },
 *   "logfare/*": { "input": 0.5, "output": 2.0 }
 * }
 * ```
 *
 * Rates are USD per 1,000,000 tokens, matching the catalog. An exact
 * `provider/model` key wins over a `provider/*` wildcard. The file is optional:
 * absent or malformed means "no override", never an error, because a bad pricing
 * file must not stop a session from starting.
 *
 * @module src/cli/pricing-config
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** File name inside the DSH home. */
export const PRICING_FILE = 'dsh-cli-pricing.json';

/**
 * Read and validate the pricing file.
 *
 * @param {string} dshHome DSH home directory.
 * @param {{ readFile?: (file: string, encoding: string) => string }} [options]
 * @returns {Record<string, object>} Valid entries only; empty when absent.
 */
export function readPricingFile(dshHome, options = {}) {
  const readFile = options.readFile ?? readFileSync;
  let parsed;
  try {
    parsed = JSON.parse(readFile(path.join(dshHome, PRICING_FILE), 'utf8'));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  /** @type {Record<string, object>} */
  const entries = {};
  for (const [key, value] of Object.entries(parsed)) {
    const rates = normalizeRates(value);
    if (rates !== null) entries[key] = rates;
  }
  return entries;
}

/**
 * Keep only the four finite, non-negative rate fields the meter understands.
 *
 * @param {unknown} value Candidate entry.
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number } | null}
 *   Normalized rates, or null when the entry carries none.
 */
export function normalizeRates(value) {
  if (value === null || typeof value !== 'object') return null;
  /** @type {Record<string, number>} */
  const rates = {};
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const raw = /** @type {any} */ (value)[field];
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric >= 0) rates[field] = numeric;
  }
  if (rates.input === undefined && rates.output === undefined) return null;
  return {
    input: rates.input ?? 0,
    output: rates.output ?? 0,
    cacheRead: rates.cacheRead ?? 0,
    cacheWrite: rates.cacheWrite ?? 0,
  };
}

/**
 * Pick the rates for one route from a loaded pricing table.
 *
 * @param {Record<string, object>} entries Table from {@link readPricingFile}.
 * @param {{ provider?: string, model?: string }} route Active route.
 * @returns {object | null} Rates, or null when nothing matches.
 */
export function resolveOverride(entries, route) {
  const provider = String(route?.provider ?? '');
  const model = String(route?.model ?? '');
  if (provider === '' && model === '') return null;
  return (
    entries[`${provider}/${model}`] ??
    entries[`${provider}/*`] ??
    entries[model] ??
    entries['*'] ??
    null
  );
}

/**
 * The override a command should hand to `UsageMeter`.
 *
 * @param {{ dshHome: string, provider?: string, model?: string }} input Route and home.
 * @returns {object | null} Rates, or null when the user declared none.
 */
export function pricingOverrideFor({ dshHome, provider, model }) {
  if (typeof dshHome !== 'string' || dshHome === '') return null;
  return resolveOverride(readPricingFile(dshHome), { provider, model });
}

/**
 * Explain where a route's rates came from, for `doctor`.
 *
 * @param {{ dshHome: string, provider?: string, model?: string }} input Route and home.
 * @returns {string} One line.
 */
export function describePricing({ dshHome, provider, model }) {
  const override = pricingOverrideFor({ dshHome, provider, model });
  if (override !== null) {
    return `declared in ${path.join(dshHome, PRICING_FILE)}`;
  }
  return 'from the installed model catalog (or unknown for this route)';
}