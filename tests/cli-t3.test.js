import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  INSTANCE_ID,
  buildProviderInstance,
  mergeProviderSettings,
  readT3Settings,
  removeProviderSettings,
  resolveT3Home,
  runT3Command,
} from '../src/cli/t3.js';

/** A throwaway T3 home, so no test can read or write the real one. */
function t3home(settings) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-t3-'));
  mkdirSync(path.join(root, 'userdata'), { recursive: true });
  if (settings !== undefined) {
    writeFileSync(path.join(root, 'userdata', 'settings.json'), settings, 'utf8');
  }
  return {
    root,
    file: path.join(root, 'userdata', 'settings.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Capture process output without touching the real streams. */
function sink() {
  const lines = [];
  return {
    lines,
    write(chunk) {
      lines.push(String(chunk));
      return true;
    },
  };
}

const CONTEXT = { dshHome: path.join(os.tmpdir(), 'unused-dsh-home'), env: {} };

test('the provider entry is a local ACP command, not a registry download', () => {
  const instance = buildProviderInstance({
    nodePath: 'C:\\node.exe',
    runtimeBin: 'C:\\dsh\\bin.js',
    profile: 'dsh-cli-acp',
  });
  assert.equal(instance.driver, 'acpRegistry');
  assert.equal(instance.config.source, 'local');
  assert.deepEqual(instance.config.commandArgs, ['C:\\dsh\\bin.js', '--profile', 'dsh-cli-acp']);
  assert.equal(instance.enabled, true);
});

test('merge adds the entry without disturbing other providers', () => {
  const before = { favorites: [1], providerInstances: { opencode: { driver: 'opencode' } } };
  const result = mergeProviderSettings(before, buildProviderInstance());
  assert.equal(result.changed, true);
  assert.equal(result.existed, false);
  assert.deepEqual(Object.keys(result.settings.providerInstances).sort(), ['acpRegistry', 'opencode']);
  assert.deepEqual(result.settings.favorites, [1]);
});

test('an existing entry is left alone unless force is passed', () => {
  const before = { providerInstances: { [INSTANCE_ID]: { driver: 'old' } } };
  const kept = mergeProviderSettings(before, buildProviderInstance());
  assert.equal(kept.changed, false);
  assert.equal(kept.settings.providerInstances[INSTANCE_ID].driver, 'old');

  const replaced = mergeProviderSettings(before, buildProviderInstance(), { force: true });
  assert.equal(replaced.changed, true);
  assert.equal(replaced.settings.providerInstances[INSTANCE_ID].driver, 'acpRegistry');
});

test('removal deletes only our instance', () => {
  const before = {
    providerInstances: { [INSTANCE_ID]: { driver: 'acpRegistry' }, opencode: { driver: 'opencode' } },
  };
  const result = removeProviderSettings(before);
  assert.equal(result.changed, true);
  assert.deepEqual(Object.keys(result.settings.providerInstances), ['opencode']);

  assert.equal(removeProviderSettings({}).changed, false);
  assert.equal(removeProviderSettings({ providerInstances: {} }).changed, false);
});

test('a settings file with a UTF-8 BOM is still readable', () => {
  const box = t3home('\uFEFF{"providerInstances":{}}');
  try {
    const read = readT3Settings(box.root);
    assert.equal(read.settings === null, false);
    assert.deepEqual(read.settings, { providerInstances: {} });
  } finally {
    box.cleanup();
  }
});

test('runT3Command register then unregister round-trips through disk', () => {
  const box = t3home('{"favorites":[],"providerInstances":{"opencode":{"driver":"opencode"}}}');
  try {
    const out = sink();
    const registered = runT3Command(CONTEXT, {
      stdout: out,
      stderr: sock(),
      action: 'register',
      home: box.root,
    });
    assert.equal(registered, 0);
    const saved = JSON.parse(readFileSync(box.file, 'utf8'));
    assert.equal(saved.providerInstances[INSTANCE_ID].driver, 'acpRegistry');
    assert.deepEqual(saved.favorites, []);

    const status = sink();
    runT3Command(CONTEXT, { stdout: status, stderr: sock(), action: 'status', home: box.root });
    assert.ok(status.lines.join('\n').includes('DSH CLI'));

    const removed = runT3Command(CONTEXT, {
      stdout: sink(),
      stderr: sock(),
      action: 'unregister',
      home: box.root,
    });
    assert.equal(removed, 0);
    const after = JSON.parse(readFileSync(box.file, 'utf8'));
    assert.deepEqual(Object.keys(after.providerInstances), ['opencode']);
  } finally {
    box.cleanup();
  }
});

test('dry run reports the change without writing', () => {
  const box = t3home('{"providerInstances":{}}');
  try {
    const before = readFileSync(box.file, 'utf8');
    const out = sink();
    const code = runT3Command(CONTEXT, {
      stdout: out,
      stderr: sock(),
      action: 'register',
      dryRun: true,
      home: box.root,
    });
    assert.equal(code, 0);
    assert.equal(readFileSync(box.file, 'utf8'), before);
    assert.ok(out.lines.join('\n').includes('dry run'));
  } finally {
    box.cleanup();
  }
});

test('corrupt settings are refused instead of overwritten', () => {
  const box = t3home('{ not json');
  try {
    const out = sink();
    const err = sink();
    const code = runT3Command(CONTEXT, {
      stdout: out,
      stderr: err,
      action: 'register',
      home: box.root,
    });
    assert.equal(code, 1);
    assert.equal(readFileSync(box.file, 'utf8'), '{ not json');
    assert.match(err.lines.join('\n'), /not valid JSON/);
  } finally {
    box.cleanup();
  }
});

test('an unknown action is a usage error', () => {
  const box = t3home('{}');
  try {
    const err = sink();
    const code = runT3Command(CONTEXT, {
      stdout: sink(),
      stderr: err,
      action: 'frobnicate',
      home: box.root,
    });
    assert.equal(code, 2);
    assert.match(err.lines.join('\n'), /unknown t3 action/);
  } finally {
    box.cleanup();
  }
});

test('T3CODE_HOME overrides the default location', () => {
  assert.equal(resolveT3Home({ T3CODE_HOME: 'D:\\t3' }), 'D:\\t3');
  assert.equal(resolveT3Home({}), path.join(os.homedir(), '.t3'));
});

/** A stderr sink that fails the test if anything is written to it. */
function sock() {
  return {
    write(chunk) {
      assert.fail(`unexpected stderr: ${String(chunk)}`);
    },
  };
}