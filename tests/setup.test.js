import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseSetupOptions, runSetup, t3Present } from '../scripts/setup.mjs';

/**
 * Build a throwaway home directory with a fake environment.
 *
 * @returns {{ home: string, env: Record<string, string> }}
 */
function fakeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-setup-'));
  return {
    home,
    env: {
      USERPROFILE: home,
      HOME: home,
      T3CODE_HOME: path.join(home, '.t3'),
      DSH_HOME: path.join(home, '.dsh'),
      Path: process.env.Path ?? '',
      PATH: process.env.PATH ?? '',
    },
  };
}

test('parseSetupOptions reads aliases, a bin directory and switches', () => {
  const options = parseSetupOptions(['--alias', 'dsh,deepseek', '--alias=deep', '--dir', './bin', '--no-t3', '--no-profile']);
  assert.deepEqual(options.aliases, ['dsh', 'deepseek', 'deep']);
  assert.equal(options.binDir, path.resolve('./bin'));
  assert.equal(options.t3, false);
  assert.equal(options.installProfile, false);
  assert.equal(options.dryRun, false);
});

test('parseSetupOptions treats an unknown flag as an error', () => {
  assert.throws(() => parseSetupOptions(['--alias']), /needs a value/u);
  assert.throws(() => parseSetupOptions(['--nope']), /unknown option/u);
});

test('t3Present is false without a settings file and true with one', () => {
  const { home, env } = fakeHome();
  try {
    assert.equal(t3Present(env), false);
    mkdirSync(path.join(env.T3CODE_HOME, 'userdata'), { recursive: true });
    writeFileSync(path.join(env.T3CODE_HOME, 'userdata', 'settings.json'), '{}\n', 'utf8');
    assert.equal(t3Present(env), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a dry run writes nothing in any directory', async () => {
  const { home, env } = fakeHome();
  const out = { text: '', write(chunk) { this.text += chunk; } };
  try {
    const result = await runSetup({ dryRun: true, force: true, env, stdout: out, aliases: ['dsh-cli'] });
    assert.equal(result.t3, 'absent');
    assert.equal(result.install.profile, 'would install');
    assert.equal(existsSync(env.DSH_HOME), false);
    assert.equal(existsSync(path.join(home, '.dsh-cli')), false);
    assert.match(out.text, /would write/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('setup registers the T3 provider when T3 settings exist', async () => {
  const { home, env } = fakeHome();
  const out = { text: '', write(chunk) { this.text += chunk; } };
  // The provider entry records the runtime path, so point the lookup at a file
  // that exists on every machine instead of depending on a Desktop install.
  const previousRuntime = process.env.DSH_CLI_RUNTIME_BIN;
  try {
    const runtime = path.join(home, 'bin.js');
    writeFileSync(runtime, '', 'utf8');
    process.env.DSH_CLI_RUNTIME_BIN = runtime;
    mkdirSync(path.join(env.T3CODE_HOME, 'userdata'), { recursive: true });
    writeFileSync(path.join(env.T3CODE_HOME, 'userdata', 'settings.json'), '{}\n', 'utf8');
    const result = await runSetup({ dryRun: true, force: true, env, stdout: out, installProfile: false });
    assert.equal(result.t3, 'registered');
    assert.deepEqual(readdirSync(path.join(env.T3CODE_HOME, 'userdata')), ['settings.json']);
  } finally {
    if (previousRuntime === undefined) delete process.env.DSH_CLI_RUNTIME_BIN;
    else process.env.DSH_CLI_RUNTIME_BIN = previousRuntime;
    rmSync(home, { recursive: true, force: true });
  }
});
