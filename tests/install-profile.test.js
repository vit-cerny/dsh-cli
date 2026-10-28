import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  COPIED_ROWS,
  PROFILE_BUNDLES,
  buildProfileManifest,
  buildProfilePatch,
  main,
  parseOptions,
  splitPatchRows,
} from '../scripts/install-profile.mjs';

const DESKTOP_PATCH = `# desktop patch
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
- id: desktop-shell
  name: dsh-plugin-desktop
- id: web
  config:
    searchProvider: deepseek-search-api
    fetchProvider: deepseek-fetch-api
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
- id: web-deepseek-api
  name: '@deepseek-ai/dsh-web-deepseek-api'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
`;

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

test('splitPatchRows keeps whole top-level rows and drops the preamble', () => {
  const rows = splitPatchRows(DESKTOP_PATCH);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['agent-default-model', 'desktop-shell', 'web', 'ui-chat', 'web-deepseek-api'],
  );
  assert.equal(rows[0].lines[0], '- id: agent-default-model');
});

test('buildProfilePatch copies only capability rows, never Electron UI rows', () => {
  const built = buildProfilePatch(DESKTOP_PATCH);
  assert.deepEqual(built.copied, ['agent-default-model', 'web', 'web-deepseek-api']);
  assert.ok(!built.text.includes('desktop-shell'));
  assert.ok(!built.text.includes('ui-chat'));
  assert.ok(built.text.includes('searchProvider: deepseek-search-api'));
  assert.ok(built.text.includes('apiKeyEnv: DEEPSEEK_API_KEY'));
  assert.ok(built.missing.includes('llm-pi-ai'));
});

test('the profile manifest mounts base plus the JSON-RPC server only', () => {
  const manifest = JSON.parse(buildProfileManifest());
  assert.deepEqual(manifest.dsh.profile.bundles, [...PROFILE_BUNDLES]);
  assert.equal(manifest.dependencies && Object.keys(manifest.dependencies).length, 0);
  assert.ok(!PROFILE_BUNDLES.includes('@deepseek-ai/dsh-web-app'));
});

test('the copied row list excludes the Electron-managed surface', () => {
  for (const forbidden of ['desktop-shell', 'ui-chat', 'agent-teams']) {
    assert.ok(!COPIED_ROWS.includes(forbidden));
  }
});

test('parseOptions rejects unknown flags and missing values', () => {
  assert.throws(() => parseOptions(['--nope'], {}), /unknown option/);
  assert.throws(() => parseOptions(['--home'], {}), /needs a value/);
  assert.throws(() => parseOptions(['--provider', 'p'], {}), /also needs --model/);
  const parsed = parseOptions(['--dry-run', '--home', 'X'], { DSH_HOME: 'Y' });
  assert.equal(parsed.dryRun, true);
  assert.ok(parsed.home.endsWith('X'));
  assert.ok(parsed.source.endsWith(path.join('profiles', 'desktop', 'cordis.patch.yml')));
  const pinned = parseOptions(['--provider', 'logfare', '--model', 'm'], {});
  assert.equal(pinned.provider, 'logfare');
  assert.equal(pinned.model, 'm');
});

test('a route override rewrites the copied default-route row in place', () => {
  const built = buildProfilePatch(DESKTOP_PATCH, COPIED_ROWS, {
    provider: 'logfare',
    model: 'some-model',
  });
  assert.match(built.text, /provider: logfare/);
  assert.match(built.text, /model: some-model/);
  assert.doesNotMatch(built.text, /provider: deepseek-official/);
  // Exactly one default-route row, or the loader would see two conflicting routes.
  assert.equal(built.text.split('- id: agent-default-model').length - 1, 1);
});

test('main writes the profile and never touches the source patch', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-install-'));
  try {
    const home = path.join(root, 'dsh-home');
    const source = path.join(root, 'desktop.patch.yml');
    writeFileSync(source, DESKTOP_PATCH, 'utf8');
    const before = readFileSync(source, 'utf8');

    const { io, out, err } = capture();
    const code = main(['--home', home, '--source', source], io);

    assert.equal(code, 0, err.join(''));
    assert.match(out.join(''), /copied: agent-default-model, web, web-deepseek-api/);
    assert.equal(readFileSync(source, 'utf8'), before);

    const installed = readFileSync(path.join(home, 'profiles', 'dsh-cli', 'cordis.patch.yml'), 'utf8');
    assert.ok(installed.includes('fetchProvider: deepseek-fetch-api'));
    const manifest = JSON.parse(readFileSync(path.join(home, 'profiles', 'dsh-cli', 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'dsh-profile-dsh-cli');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main refuses a source patch with no capability rows', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-install-'));
  try {
    const source = path.join(root, 'empty.patch.yml');
    writeFileSync(source, '- id: ui-chat\n  name: x\n', 'utf8');
    const { io, err } = capture();
    assert.equal(main(['--home', path.join(root, 'home'), '--source', source], io), 1);
    assert.match(err.join(''), /no capability rows/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main reports a missing source patch instead of writing a partial profile', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-install-'));
  try {
    const { io, err } = capture();
    const code = main(['--home', path.join(root, 'home'), '--source', path.join(root, 'absent.yml')], io);
    assert.equal(code, 1);
    assert.match(err.join(''), /not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
