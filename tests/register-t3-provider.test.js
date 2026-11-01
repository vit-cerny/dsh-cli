import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  INSTANCE_ID,
  buildProviderInstance,
  main,
  mergeProviderSettings,
  parseOptions,
  resolveT3Home,
} from '../scripts/register-t3-provider.mjs';

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: {
      stdout: { write: (chunk) => out.push(String(chunk)) },
      stderr: { write: (chunk) => err.push(String(chunk)) },
    },
  };
}

test('resolveT3Home honours T3CODE_HOME and otherwise uses ~/.t3', () => {
  assert.equal(resolveT3Home({ T3CODE_HOME: 'C:\\t3home' }), 'C:\\t3home');
  assert.ok(resolveT3Home({}).endsWith('.t3'));
});

test('buildProviderInstance points at node plus the ACP profile', () => {
  const instance = buildProviderInstance({
    nodePath: 'C:\\node.exe',
    runtimeBin: 'C:\\dsh\\bin.js',
    profile: 'dsh-cli-acp',
  });
  assert.equal(instance.driver, 'acpRegistry');
  assert.equal(instance.enabled, true);
  assert.equal(instance.config.source, 'local');
  assert.deepEqual(instance.config.commandArgs, [
    'C:\\dsh\\bin.js',
    '--profile',
    'dsh-cli-acp',
  ]);
});

test('mergeProviderSettings adds the instance and preserves other settings', () => {
  const existing = { idleCompaction: 'onReturn', providerInstances: { codex: { driver: 'codex' } } };
  const { settings, changed, existed } = mergeProviderSettings(existing, { driver: 'acpRegistry' });
  assert.equal(changed, true);
  assert.equal(existed, false);
  assert.equal(settings.idleCompaction, 'onReturn');
  assert.deepEqual(settings.providerInstances.codex, { driver: 'codex' });
  assert.deepEqual(settings.providerInstances[INSTANCE_ID], { driver: 'acpRegistry' });
});

test('mergeProviderSettings never overwrites without force', () => {
  const existing = { providerInstances: { [INSTANCE_ID]: { driver: 'old' } } };
  const kept = mergeProviderSettings(existing, { driver: 'new' });
  assert.equal(kept.changed, false);
  assert.equal(kept.existed, true);
  assert.deepEqual(kept.settings.providerInstances[INSTANCE_ID], { driver: 'old' });

  const replaced = mergeProviderSettings(existing, { driver: 'new' }, { force: true });
  assert.equal(replaced.changed, true);
  assert.deepEqual(replaced.settings.providerInstances[INSTANCE_ID], { driver: 'new' });
});

test('parseOptions rejects unknown flags and missing paths', () => {
  assert.throws(() => parseOptions(['--nope'], {}), /unknown option/);
  assert.throws(() => parseOptions(['--home'], {}), /needs a path/);
  const parsed = parseOptions(['--dry-run', '--force'], {});
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.force, true);
});

test('main writes the provider into an isolated T3 home', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-t3-'));
  try {
    const home = path.join(root, 't3');
    mkdirSync(path.join(home, 'userdata'), { recursive: true });
    writeFileSync(
      path.join(home, 'userdata', 'settings.json'),
      JSON.stringify({ idleCompaction: 'onReturn' }),
      'utf8',
    );
    const { io, out, err } = capture();
    const code = main(['--home', home], io);
    assert.equal(code, 0, err.join(''));
    assert.match(out.join(''), /registered/);

    const saved = JSON.parse(readFileSync(path.join(home, 'userdata', 'settings.json'), 'utf8'));
    assert.equal(saved.idleCompaction, 'onReturn');
    assert.equal(saved.providerInstances[INSTANCE_ID].driver, 'acpRegistry');
    assert.equal(saved.providerInstances[INSTANCE_ID].config.source, 'local');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main leaves an existing entry alone and reports it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-t3-'));
  try {
    const home = path.join(root, 't3');
    mkdirSync(path.join(home, 'userdata'), { recursive: true });
    const file = path.join(home, 'userdata', 'settings.json');
    writeFileSync(
      file,
      JSON.stringify({ providerInstances: { [INSTANCE_ID]: { driver: 'custom' } } }),
      'utf8',
    );
    const { io, out } = capture();
    assert.equal(main(['--home', home], io), 0);
    assert.match(out.join(''), /already registered/);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.providerInstances[INSTANCE_ID].driver, 'custom');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main refuses to corrupt an unreadable settings file', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-t3-'));
  try {
    const home = path.join(root, 't3');
    mkdirSync(path.join(home, 'userdata'), { recursive: true });
    const file = path.join(home, 'userdata', 'settings.json');
    writeFileSync(file, '{ not json', 'utf8');
    const { io, err } = capture();
    assert.equal(main(['--home', home], io), 1);
    assert.match(err.join(''), /not valid JSON/);
    assert.equal(readFileSync(file, 'utf8'), '{ not json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
