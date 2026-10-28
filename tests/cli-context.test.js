import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseRouteFromPatch, resolveContext, resolveDshHome } from '../src/cli/context.js';

const RUNTIME = path.join(os.tmpdir(), 'dsh-runtime-placeholder');

function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-ctx-'));
  const dshHome = path.join(root, '.dsh');
  mkdirSync(dshHome, { recursive: true });
  // resolveContext rejects a runtime path that does not exist.
  writeFileSync(RUNTIME, '');
  return {
    root,
    dshHome,
    env: { DSH_HOME: dshHome, DSH_CLI_RUNTIME_BIN: RUNTIME },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeProfile(dshHome, name, patch) {
  const dir = path.join(dshHome, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
  writeFileSync(path.join(dir, 'cordis.patch.yml'), patch);
}

const ROUTE_PATCH = `- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high
`;

test('resolveDshHome honours DSH_HOME and otherwise uses ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\custom' }), 'C:\\custom');
  assert.ok(resolveDshHome({}).endsWith('.dsh'));
});

test('parseRouteFromPatch reads the agent-default-model route', () => {
  assert.deepEqual(parseRouteFromPatch(ROUTE_PATCH), {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  });
});

test('parseRouteFromPatch ignores interpolated values', () => {
  const route = parseRouteFromPatch(`
- id: agent-default-model
  config:
    provider: \${SOME_PROVIDER}
    model: 'quoted-model'
`);
  assert.equal(route.provider, undefined);
  assert.equal(route.model, 'quoted-model');
});

test('the session profile defaults to sdk when no derived profile exists', () => {
  const box = sandbox();
  try {
    const context = resolveContext({ options: {}, env: box.env });
    assert.equal(context.profile, 'sdk');
    assert.deepEqual(context.runtimeArgs, ['--profile', 'sdk']);
  } finally {
    box.cleanup();
  }
});

test('inventory falls back to the desktop profile when no derived profile exists', () => {
  const box = sandbox();
  try {
    const context = resolveContext({ options: {}, env: box.env, kind: 'inventory' });
    assert.equal(context.profile, 'desktop');
  } finally {
    box.cleanup();
  }
});

test('an installed dsh-cli profile becomes the session default', () => {
  const box = sandbox();
  try {
    writeProfile(box.dshHome, 'dsh-cli', ROUTE_PATCH);
    const context = resolveContext({ options: {}, env: box.env });
    assert.equal(context.profile, 'dsh-cli');
    assert.equal(context.provider, 'deepseek-official');
    assert.equal(context.model, 'deepseek-flash');
  } finally {
    box.cleanup();
  }
});

test('DSH_CLI_PROFILE and explicit flags still win over the derived profile', () => {
  const box = sandbox();
  try {
    writeProfile(box.dshHome, 'dsh-cli', ROUTE_PATCH);
    writeProfile(box.dshHome, 'other', ROUTE_PATCH);

    const byEnv = resolveContext({ options: {}, env: { ...box.env, DSH_CLI_PROFILE: 'other' } });
    assert.equal(byEnv.profile, 'other');

    const byFlag = resolveContext({
      options: { profile: 'other', model: 'chosen-model' },
      env: box.env,
    });
    assert.equal(byFlag.profile, 'other');
    assert.equal(byFlag.model, 'chosen-model');
  } finally {
    box.cleanup();
  }
});

test('a route override does not inherit the profile reasoning effort', () => {
  const box = sandbox();
  try {
    writeProfile(box.dshHome, 'dsh-cli', ROUTE_PATCH);
    const inherited = resolveContext({ options: {}, env: box.env });
    assert.equal(inherited.reasoningEffort, 'high');

    // An explicit route may target a model without that capability.
    const overridden = resolveContext({
      options: { provider: 'logfare', model: 'some-model' },
      env: box.env,
    });
    assert.equal(overridden.reasoningEffort, undefined);
    assert.equal(overridden.provider, 'logfare');
  } finally {
    box.cleanup();
  }
});

test('a missing working directory is a user-facing CliError', () => {
  const box = sandbox();
  try {
    assert.throws(
      () => resolveContext({ options: { cwd: path.join(box.root, 'nope') }, env: box.env }),
      /working directory does not exist/,
    );
  } finally {
    box.cleanup();
  }
});
