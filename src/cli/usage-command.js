/**
 * `dsh-cli usage` and the `/usage` slash command.
 *
 * Two sources answer "what did this cost":
 *
 * - the live meter in the interactive UI, which only knows this process; and
 * - the persisted session log, which knows every turn ever recorded.
 *
 * This module reads the log, so the number survives a restart. It reuses the
 * same bounded frame decoder as `src/cli/store.js` rather than adding a second
 * one, and it reuses `UsageMeter` so live and historical figures price the same
 * way and cannot disagree.
 *
 * @module src/cli/usage-command
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { formatCost, formatUsage, UsageMeter } from '../session/usage.js';
import { pricingOverrideFor } from './pricing-config.js';
import { decodeSessionLog, readSessionSummaries } from './store.js';

/** Usage is a report, not a transcript: the whole log is never loaded. */
const USAGE_LOG_BYTES = 32 * 1024 * 1024;

/**
 * Fold every `assistant/message` usage record in one session log.
 *
 * @param {string} file Session log path.
 * @param {{ provider?: string, model?: string, meter?: UsageMeter, override?: object }} [options]
 *   Route for pricing, plus any user-declared rates.
 * @returns {ReturnType<UsageMeter['totals']> | null} Totals, or null when unreadable.
 */
export function readSessionUsage(file, { provider, model, meter, override } = {}) {
  let text;
  try {
    // The decoder enforces its own ceilings; this guard only skips a log so
    // large that reading it would cost more than the answer is worth.
    const bytes = readFileSync(file);
    if (bytes.byteLength > USAGE_LOG_BYTES) return null;
    text = decodeSessionLog(bytes);
  } catch {
    return null;
  }
  if (text === null) return null;

  const active =
    meter ??
    new UsageMeter({
      provider,
      model,
      ...(override === undefined ? {} : { override }),
    });
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || !line.includes('"usage"')) continue;
    /** @type {any} */
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== 'assistant/message') continue;
    active.record(record?.data?.usage);
    // The route can differ per request (a mid-session `/model` switch), so a
    // later message re-prices against its own model when the log records one.
    const source = record?.data?.message?.source;
    if (typeof source?.model === 'string' && source.model !== '' && source.model !== model) {
      active.adoptRoute?.(source.provider, source.model);
    }
  }
  return active.totals;
}

/**
 * Sum across every session in the store.
 *
 * @param {string} dshHome DSH home directory.
 * @param {{ provider?: string, model?: string, limit?: number, override?: object }} [options]
 *   Route, cap, and any user-declared rates.
 * @returns {{ sessions: number, read: number, totals: object }} Aggregate.
 */
export function readStoreUsage(dshHome, options = {}) {
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 50;
  const summaries = readSessionSummaries(dshHome, { limit, includeAll: true });
  const aggregate = new UsageMeter({
    provider: options.provider,
    model: options.model,
    ...(options.override === undefined ? {} : { override: options.override }),
  });
  let read = 0;

  for (const summary of summaries) {
    const file = summary.dir === undefined ? null : `${summary.dir}/session.v4.jsonl.zstd`;
    if (file === null) continue;
    const totals = readSessionUsage(file, {
      provider: options.provider,
      model: options.model,
      ...(options.override === undefined ? {} : { override: options.override }),
    });
    if (totals === null) continue;
    read += 1;
    // Every component is replayed, including the cached split: dropping it would
    // silently understate the cost of a long session.
    aggregate.record({
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
    });
  }
  return { sessions: summaries.length, read, totals: aggregate.totals };
}

/**
 * Render one totals row set for a terminal.
 *
 * @param {object} totals From `UsageMeter.totals`.
 * @param {{ title?: string }} [options] Heading.
 * @returns {string[]} Lines.
 */
export function formatUsageReport(totals, { title } = {}) {
  const lines = [];
  if (title !== undefined) lines.push(title);
  lines.push(`  ${formatUsage(totals)}`);
  lines.push(`  cost: ${formatCost(totals.costUsd, totals.priced)}`);
  lines.push(`  requests: ${totals.calls}`);
  if (!totals.priced) {
    lines.push('  (no rate table matched this route; cost is unknown, not zero)');
  }
  return lines;
}

/**
 * Run `dsh-cli usage`.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @param {{ stdout?: NodeJS.WriteStream, sessionId?: string, json?: boolean }} [options]
 * @returns {number} Exit code.
 */
export function runUsageCommand(context, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const write = (line) => stdout.write(`${line}\n`);
  const route = { provider: context.provider, model: context.model };

  if (options.sessionId !== undefined && options.sessionId !== '') {
    const rows = readSessionSummaries(context.dshHome, { limit: 500, includeAll: true });
    const summary = rows.find((row) => row.id === options.sessionId);
    if (summary === undefined) {
      write(`no session with id ${options.sessionId}`);
      return 1;
    }
    const totals = readSessionUsage(`${summary.dir}/session.v4.jsonl.zstd`, {
      ...route,
      override: pricingOverrideFor({ dshHome: context.dshHome, ...route }),
    });
    if (totals === null) {
      write(`session ${summary.id} has no readable usage records`);
      return 1;
    }
    if (options.json === true) {
      write(JSON.stringify({ sessionId: summary.id, ...totals }));
      return 0;
    }
    for (const line of formatUsageReport(totals, { title: `session ${summary.id}` })) write(line);
    return 0;
  }

  const store = readStoreUsage(context.dshHome, {
    ...route,
    override: pricingOverrideFor({ dshHome: context.dshHome, ...route }),
  });
  if (options.json === true) {
    write(JSON.stringify(store));
    return 0;
  }
  write(`${store.read} of ${store.sessions} sessions with usage records`);
  for (const line of formatUsageReport(store.totals)) write(line);
  if (store.read === 0) {
    write('no usage records found; run a prompt first, or check DSH_HOME');
  }
  return 0;
}