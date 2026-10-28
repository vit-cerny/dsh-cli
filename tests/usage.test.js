import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  UsageMeter,
  formatCost,
  formatUsage,
  lookupPricing,
} from '../src/session/usage.js';

/** Temp roots this file created, removed once the file's tests finish. */
const created = [];

after(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true });
});

/** Rates verified against the installed catalog's deepseek table. */
const DEEPSEEK_FLASH = Object.freeze({
  input: 0.3,
  output: 1.2,
  cacheRead: 0.006,
  cacheWrite: 0,
});

/** A real `assistant/message` usage record, copied from a persisted session log. */
const REAL_USAGE = Object.freeze({
  inputTokens: 4005,
  outputTokens: 133,
  totalTokens: 20522,
  cacheReadTokens: 16384,
});

/**
 * A second real record whose `totalTokens` (71043) exceeds its component sum
 * (153 + 303 + 70528 = 70984). Measured across the session store on this
 * machine: 220 of 4897 records disagree with their own components.
 */
const REAL_USAGE_DRIFTED = Object.freeze({
  inputTokens: 153,
  outputTokens: 303,
  totalTokens: 71043,
  cacheReadTokens: 70528,
});

/**
 * Build a fake DSH app dir holding a pi-ai catalog.
 *
 * @param {Record<string, unknown>} files Catalog file name to parsed JSON.
 * @returns {string} The catalog directory.
 */
function makeCatalog(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-catalog-'));
  created.push(root);
  const dir = path.join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), JSON.stringify(body));
  }
  return dir;
}

/** The runtime entry point a real install would have, inside `appDir`. */
function runtimeBinIn(appDir) {
  return path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

/** A catalog entry in the verified shape (`chat:<id>` key, `cost` rates). */
function chatModel(id, cost) {
  return { id, name: id, api: 'openai-completions', type: 'chat', cost };
}

test('usage totals are additive while the provider total is not', () => {
  const meter = new UsageMeter({ provider: 'deepseek-official', model: 'deepseek-flash', pricing: DEEPSEEK_FLASH });
  meter.record(REAL_USAGE);
  meter.record(REAL_USAGE);

  const totals = meter.totals;
  assert.equal(totals.inputTokens, 8010);
  assert.equal(totals.outputTokens, 266);
  assert.equal(totals.cacheReadTokens, 32768);
  assert.equal(totals.calls, 2);
  assert.equal(meter.priced, true);
  // `totalTokens` is rebuilt from the additive counters. This record happens to
  // satisfy total = input + cached + output, which is exactly why summing the
  // provider's own total looks right until a record like the next one appears.
  assert.equal(totals.totalTokens, 8010 + 266 + 32768);

  // The provider's total is not a usable source of additive truth: it drifts
  // from its own components, so a meter that summed it would over-report.
  meter.reset();
  meter.record(REAL_USAGE_DRIFTED);
  assert.equal(meter.totals.totalTokens, 153 + 303 + 70528);
  assert.notEqual(meter.totals.totalTokens, REAL_USAGE_DRIFTED.totalTokens);
});

test('cost prices the cached and uncached input split separately', () => {
  const meter = new UsageMeter({ provider: 'deepseek-official', model: 'deepseek-flash', pricing: DEEPSEEK_FLASH });
  meter.record(REAL_USAGE);

  const expected = (4005 * 0.3 + 133 * 1.2 + 16384 * 0.006) / 1_000_000;
  assert.ok(Math.abs(meter.totals.costUsd - expected) < 1e-12, 'cost matches the per-million rates');
  assert.equal(formatCost(meter.totals.costUsd, meter.priced), '$0.0015');
  // Charging the cached prefix at the input rate would be over four times more,
  // which is what a single flat input rate would get silently wrong.
  const flat = ((4005 + 16384) * 0.3 + 133 * 1.2) / 1_000_000;
  assert.ok(expected < flat / 4);
});

test('an unmatched model is unpriced instead of free', () => {
  const meter = new UsageMeter({
    provider: 'no-such-provider',
    model: 'no-such-model',
    catalogDir: makeCatalog({ 'deepseek.json': { 'openai-completions': { 'chat:deepseek-flash': chatModel('deepseek-flash', DEEPSEEK_FLASH) } } }),
  });
  meter.record(REAL_USAGE);

  const totals = meter.totals;
  assert.equal(meter.priced, false);
  assert.equal(totals.priced, false);
  assert.equal(totals.costUsd, null, 'an unpriced meter must not report $0');
  assert.equal(formatCost(totals.costUsd, totals.priced), 'cost unknown');
  assert.match(formatUsage(totals), /cost unknown$/);
  assert.equal(totals.inputTokens, 4005, 'unpriced usage is still counted');
});

test('malformed and non-attributable usage records are ignored', () => {
  const meter = new UsageMeter({ provider: 'p', model: 'm', pricing: DEEPSEEK_FLASH });
  for (const bad of [null, undefined, 'nope', 42, [], {}, { inputTokens: -1 }, { totalTokens: 20522 }]) {
    assert.doesNotThrow(() => meter.record(bad));
  }

  const totals = meter.totals;
  assert.equal(totals.calls, 0);
  assert.equal(totals.totalTokens, 0);
  assert.equal(totals.costUsd, 0);

  // A record carrying one counter is kept; the missing ones count as zero.
  meter.record({ outputTokens: 7 });
  assert.equal(meter.totals.outputTokens, 7);
  assert.equal(meter.totals.calls, 1);

  meter.reset();
  assert.deepEqual(
    { ...meter.totals },
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, calls: 0, costUsd: 0, priced: true },
  );
});

test('formatUsage renders the contract line', () => {
  const line = formatUsage({
    inputTokens: 12_300,
    outputTokens: 4_100,
    cacheReadTokens: 9_200,
    totalTokens: 25_600,
    calls: 3,
    costUsd: 0.0042,
    priced: true,
  });
  assert.equal(line, '12.3k in · 4.1k out · 9.2k cached · $0.0042');
  assert.equal(formatCost(0.00001, true), '<$0.0001', 'a real charge never rounds to $0.0000');
  assert.equal(formatCost(0, true), '$0.0000');
});

test('pricing comes from the installed catalog, resolved from the runtime path', () => {
  const dir = makeCatalog({
    'deepseek.json': {
      'openai-completions': { 'chat:deepseek-flash': chatModel('deepseek-flash', DEEPSEEK_FLASH) },
    },
  });
  const appDir = path.resolve(dir, '../../../..');
  const env = { DSH_CLI_RUNTIME_BIN: runtimeBinIn(appDir) };

  // `deepseek-official` is a DSH route, not a pi-ai provider id; its catalog
  // file is the `deepseek` one.
  assert.deepEqual(
    lookupPricing({ provider: 'deepseek-official', model: 'deepseek-flash' }, { env }),
    DEEPSEEK_FLASH,
  );
  assert.equal(
    lookupPricing({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, { env }),
    null,
    'a model the catalog does not describe stays unpriced',
  );
});

test('an exact route file outranks the provider-stem fallback', () => {
  const dir = makeCatalog({
    'acme.json': { 'openai-completions': { 'chat:acme-1': chatModel('acme-1', { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }) } },
    'acme-corp.json': { 'openai-completions': { 'chat:acme-1': chatModel('acme-1', { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 }) } },
  });
  const options = { catalogDir: dir };

  assert.deepEqual(
    lookupPricing({ provider: 'acme-corp', model: 'acme-1' }, options),
    { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
  );
  assert.deepEqual(
    lookupPricing({ provider: 'acme-labs', model: 'acme-1' }, options),
    { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    'a route with no file of its own falls back to the provider stem',
  );
});

test('a cross-file match is used only when every file agrees', () => {
  const agreed = makeCatalog({
    'alpha.json': { 'openai-completions': { 'chat:shared-1': chatModel('shared-1', DEEPSEEK_FLASH) } },
    'beta.json': { 'anthropic-messages': { 'chat:shared-1': chatModel('shared-1', DEEPSEEK_FLASH) } },
  });
  assert.deepEqual(lookupPricing({ provider: 'gamma', model: 'shared-1' }, { catalogDir: agreed }), DEEPSEEK_FLASH);

  const disputed = makeCatalog({
    'alpha.json': { 'openai-completions': { 'chat:shared-1': chatModel('shared-1', DEEPSEEK_FLASH) } },
    'beta.json': { 'anthropic-messages': { 'chat:shared-1': chatModel('shared-1', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }) } },
  });
  assert.equal(
    lookupPricing({ provider: 'gamma', model: 'shared-1' }, { catalogDir: disputed }),
    null,
    'conflicting rates are not a fact, so nothing is returned',
  );
});

test('an explicit override is the last fallback, never a guess', () => {
  const dir = makeCatalog({});
  const override = { input: 5, output: 6, cacheRead: 0.5, cacheWrite: 1 };

  assert.deepEqual(lookupPricing({ provider: 'x', model: 'y' }, { catalogDir: dir, override }), override);
  assert.deepEqual(lookupPricing({}, { catalogDir: dir, override }), override, 'an unnamed route uses the override');
  assert.equal(lookupPricing({}, { catalogDir: dir }), null);
});

test('catalog reads are lazy and cached per directory', () => {
  const dir = makeCatalog({
    'deepseek.json': {
      'openai-completions': { 'chat:deepseek-flash': chatModel('deepseek-flash', DEEPSEEK_FLASH) },
    },
  });
  let reads = 0;
  const readFile = (file, encoding) => {
    reads += 1;
    return readFileSync(file, encoding);
  };

  const meter = new UsageMeter({ provider: 'deepseek-official', model: 'deepseek-flash', catalogDir: dir, readFile });
  meter.record(REAL_USAGE);
  assert.equal(reads, 0, 'construction and recording never touch the disk');

  assert.equal(meter.priced, true);
  const afterFirst = reads;
  assert.ok(afterFirst > 0);
  meter.totals;
  meter.totals;
  assert.equal(reads, afterFirst, 'a cached catalog is not re-read per call');
});

test('an explicit pricing table bypasses the catalog entirely', () => {
  const meter = new UsageMeter({
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    pricing: DEEPSEEK_FLASH,
    readFile: () => {
      throw new Error('the catalog must not be read when rates are supplied');
    },
  });
  meter.record(REAL_USAGE);
  assert.equal(meter.priced, true);
  assert.ok(meter.totals.costUsd > 0);
});
