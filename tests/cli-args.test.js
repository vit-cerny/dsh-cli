import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs, UsageError } from '../src/cli/args.js';

test('run -- preserves a dash-prefixed prompt exactly once', () => {
  const parsed = parseArgs(['run', '--', '--foo']);

  assert.deepEqual(parsed.positionals, ['--foo']);
});

test('run --timeout rejects a recognized option as its missing value', () => {
  assert.throws(
    () => parseArgs(['run', '--timeout', '--model', 'm', 'prompt']),
    (error) => error instanceof UsageError && /missing value for --timeout/.test(error.message),
  );
});

test('run accepts a dash-prefixed prompt after the delimiter', () => {
  const parsed = parseArgs(['run', '--', '--explain this']);

  assert.deepEqual(parsed.positionals, ['--explain this']);
});

test('run parses a command option written after the prompt', () => {
  const parsed = parseArgs(['run', 'hello', 'world', '--timeout', '90s']);

  assert.deepEqual(parsed.positionals, ['hello world']);
  assert.equal(parsed.options.timeout, '90s');
});

test('run keeps everything after -- literal, including flags', () => {
  const parsed = parseArgs(['run', '--', 'explain', '--timeout', '1s']);

  assert.deepEqual(parsed.positionals, ['explain --timeout 1s']);
  assert.equal(parsed.options.timeout, undefined);
});
