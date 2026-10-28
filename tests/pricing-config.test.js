import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PRICING_FILE,
  normalizeRates,
  pricingOverrideFor,
  readPricingFile,
  resolveOverride,
} from '../src/cli/pricing-config.js';

function home(files = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-pricing-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(root, name), contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a missing pricing file is an empty table, not an error', () => {
  const box = home();
  try {
    assert.deepEqual(readPricingFile(box.root), {});
    assert.equal(pricingOverrideFor({ dshHome: box.root, provider: 'p', model: 'm' }), null);
  } finally {
    box.cleanup();
  }
});

test('a malformed pricing file degrades to no override', () => {
  const box = home({ [PRICING_FILE]: '{ not json' });
  try {
    assert.deepEqual(readPricingFile(box.root), {});
  } finally {
    box.cleanup();
  }
});

test('entries with no usable rate are dropped rather than zero-filled', () => {
  const box = home({
    [PRICING_FILE]: JSON.stringify({
      'a/b': { input: 1, output: 2 },
      'c/d': { note: 'not a rate' },
      'e/f': { input: -5, output: 'x' },
    }),
  });
  try {
    const table = readPricingFile(box.root);
    assert.deepEqual(Object.keys(table), ['a/b']);
    assert.deepEqual(table['a/b'], { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  } finally {
    box.cleanup();
  }
});

test('an exact route outranks a provider wildcard, which outranks the global wildcard', () => {
  const table = {
    'logfare/model-x': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    'logfare/*': { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 },
    '*': { input: 3, output: 3, cacheRead: 0, cacheWrite: 0 },
  };
  assert.equal(resolveOverride(table, { provider: 'logfare', model: 'model-x' }).input, 1);
  assert.equal(resolveOverride(table, { provider: 'logfare', model: 'other' }).input, 2);
  assert.equal(resolveOverride(table, { provider: 'elsewhere', model: 'other' }).input, 3);
  assert.equal(resolveOverride({}, { provider: 'p', model: 'm' }), null);
});

test('normalizeRates keeps finite non-negative fields only', () => {
  assert.deepEqual(normalizeRates({ input: 0.3, output: 1.2 }), {
    input: 0.3,
    output: 1.2,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(normalizeRates(null), null);
  assert.equal(normalizeRates({}), null);
  assert.equal(normalizeRates({ input: Number.NaN }), null);
});