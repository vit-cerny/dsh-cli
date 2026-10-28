import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_LAUNCHER,
  assertLauncherName,
  findShadowingCommand,
  isDesktopInjected,
  parseAliases,
  readState,
  runInstall,
  stateFile,
} from '../scripts/install.mjs';
import { uninstallPlan } from '../scripts/uninstall.mjs';

/** Original process PATH, restored after a test that has to fake one. */
const BASELINE_PATH = process.env.PATH;
const BASELINE_PATH_ALIAS = process.env.Path;

/**
 * Point the process at a fake PATH.
 *
 * `readUserPath` reads the live environment rather than the injected `env`, so a
 * PATH-collision test has to move the real one — and put it back.
 *
 * @param {{ PATH?: string, Path?: string }} values Path values to apply.
 */
function savePath(values) {
  process.env.PATH = values.PATH;
  process.env.Path = values.Path;
}

/** Restore the PATH a test replaced. */
function restorePath() {
  process.env.PATH = BASELINE_PATH;
  if (BASELINE_PATH_ALIAS === undefined) delete process.env.Path;
  else process.env.Path = BASELINE_PATH_ALIAS;
}

/**
 * A throwaway home so nothing here can read or write the real install.
 *
 * @returns {{ root: string, env: Record<string, string>, binDir: string }} Paths for one test.
 */
function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-aliases-'));
  const env = { USERPROFILE: root, HOME: root, DSH_HOME: path.join(root, '.dsh'), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const binDir = path.join(root, 'bin');
  // Collision detection reads the live PATH, so a test must own every entry of
  // it; otherwise the real installed launchers would shadow the sandbox ones.
  savePath({ PATH: binDir, Path: binDir });
  return { root, env, binDir };
}

test('launcher names reject separators and Windows device names', () => {
  assert.equal(assertLauncherName('dshc'), 'dshc');
  assert.equal(assertLauncherName('deepseek-cli.2'), 'deepseek-cli.2');
  for (const bad of ['../evil', 'a/b', 'a\\b', '', 'con', 'NUL', 'com1', 'lpt9', ' spaced']) {
    assert.throws(() => assertLauncherName(bad), /invalid launcher name/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('parseAliases splits lists, trims blanks and drops duplicates', () => {
  assert.deepEqual(parseAliases(['ds,dsx']), ['ds', 'dsx']);
  assert.deepEqual(parseAliases(['ds', 'ds']), ['ds']);
  assert.deepEqual(parseAliases([' a , , b ']), ['a', 'b']);
  assert.throws(() => parseAliases(['../x']), /invalid launcher name/);
});

test('install writes one launcher per alias and records them in the manifest', async () => {
  const { root, env, binDir } = sandbox();
  try {
    const result = await runInstall({
      env,
      platform: 'win32',
      binDir,
      installProfile: false,
      aliases: ['ds', 'dshh'],
      stdout: { write: () => {} },
    });

    assert.deepEqual(
      result.launchers.map((launcher) => path.basename(launcher)),
      ['dsh-cli.cmd', 'ds.cmd', 'dshh.cmd'],
    );
    for (const launcher of result.launchers) {
      assert.ok(existsSync(launcher), `missing ${launcher}`);
      // A wrapper, not a copy: editing the checkout must change the command.
      assert.match(readFileSync(launcher, 'utf8'), /src[\\/]main\.js/);
    }

    const state = readState(env);
    assert.equal(state.binDir, binDir);
    assert.deepEqual(
      state.launchers.map((entry) => entry.name),
      ['dsh-cli', 'ds', 'dshh'],
    );
  } finally {
    restorePath();
    rmSync(root, { recursive: true, force: true });
  }
});

test('install without aliases still writes the default launcher alone', async () => {
  const { root, env, binDir } = sandbox();
  try {
    const result = await runInstall({
      env,
      platform: 'win32',
      binDir,
      installProfile: false,
      stdout: { write: () => {} },
    });
    assert.equal(result.launchers.length, 1);
    assert.equal(path.basename(result.launchers[0]), `${DEFAULT_LAUNCHER}.cmd`);
  } finally {
    restorePath();
    rmSync(root, { recursive: true, force: true });
  }
});

test('uninstall removes exactly the recorded launchers, never a neighbour', async () => {
  const { root, env, binDir } = sandbox();
  try {
    await runInstall({
      env,
      platform: 'win32',
      binDir,
      installProfile: false,
      aliases: ['ds'],
      stdout: { write: () => {} },
    });
    // A file the installer did not create, in the same directory.
    const neighbour = path.join(binDir, 'unrelated.cmd');
    writeFileSync(neighbour, '@echo off\r\n', 'utf8');

    const plan = uninstallPlan({ env, platform: 'win32' });
    const launchers = plan.filter((entry) => entry.kind === 'launcher').map((entry) => path.basename(entry.target));
    assert.deepEqual(launchers, ['dsh-cli.cmd', 'ds.cmd']);
    assert.ok(!launchers.includes('unrelated.cmd'));
  } finally {
    restorePath();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a name already owned by another tool is refused, unless forced', async () => {
  const { root, env, binDir } = sandbox();
  try {
    // A pre-existing command earlier on PATH, as npm or node would be.
    const earlier = path.join(root, 'earlier');
    mkdirSync(earlier, { recursive: true });
    writeFileSync(path.join(earlier, 'node.cmd'), '@echo off\r\n', 'utf8');
    const pathEnv = { ...env, PATH: `${earlier};${binDir}`, Path: `${earlier};${binDir}` };
    savePath(pathEnv);

    await assert.rejects(
      runInstall({ env: pathEnv, platform: 'win32', binDir, installProfile: false, aliases: ['node'], stdout: { write: () => {} } }),
      /already provides that command/,
    );
    // Nothing was written for the refused run.
    assert.equal(existsSync(path.join(binDir, 'node.cmd')), false);

    // --force is the deliberate override.
    const forced = await runInstall({
      env: pathEnv,
      platform: 'win32',
      binDir,
      installProfile: false,
      aliases: ['node'],
      force: true,
      stdout: { write: () => {} },
    });
    assert.ok(forced.launchers.some((launcher) => path.basename(launcher) === 'node.cmd'));
  } finally {
    restorePath();
    restorePath();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the aliases this project exists to provide are not refused', () => {
  // `dsh` and `deepseek` are not installed by DSH Desktop; it only injects a
  // temporary shim for its own child sessions, which cannot shadow a real file.
  assert.equal(assertLauncherName('dsh'), 'dsh');
  assert.equal(assertLauncherName('deepseek'), 'deepseek');
  // Desktop's injected shim directory is not a collision.
  assert.equal(isDesktopInjected('C:\\Users\\w\\AppData\\Roaming\\DSH Desktop\\host-commands\\web\\generations\\x\\bin'), true);
  assert.equal(isDesktopInjected('C:\\Users\\w\\bin'), false);
});

test('a corrupt manifest falls back to the default launcher instead of throwing', () => {
  const { root, env, binDir } = sandbox();
  try {
    mkdirSync(path.dirname(stateFile(env)), { recursive: true });
    writeFileSync(stateFile(env), '{ not json', 'utf8');
    assert.equal(readState(env), undefined);
    const plan = uninstallPlan({ env, platform: 'win32', binDir });
    const launchers = plan.filter((entry) => entry.kind === 'launcher').map((entry) => path.basename(entry.target));
    assert.deepEqual(launchers, [`${DEFAULT_LAUNCHER}.cmd`]);
  } finally {
    restorePath();
    rmSync(root, { recursive: true, force: true });
  }
});
