import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { availableModels } from '../src/cli/interactive.js';

const RUNTIME = path.join(os.tmpdir(), 'dsh-cli-model-runtime.js');

function sandbox(patch) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-models-'));
  const dshHome = path.join(root, '.dsh');
  const profileDir = path.join(dshHome, 'profiles', 'dsh-cli');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(path.join(profileDir, 'package.json'), '{"name":"x"}\n');
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patch);
  writeFileSync(RUNTIME, '');
  return {
    root,
    context: {
      dshHome,
      profile: 'dsh-cli',
      provider: 'current',
      model: 'm1',
      env: { DSH_HOME: dshHome, DSH_CLI_RUNTIME_BIN: RUNTIME },
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const PATCH = `- id: llm-pi-ai
  config:
    providers:
      current:
        models:
          - id: m1
          - id: m2
      other:
        models:
          - id: x1
`;

test('availableModels lists provider/model pairs with the active provider first', () => {
  const box = sandbox(PATCH);
  try {
    const rows = availableModels(box.context);
    assert.deepEqual(rows, ['current/m1', 'current/m2', 'other/x1']);
  } finally {
    box.cleanup();
  }
});

test('availableModels drops blank ids and reports the truncation', () => {
  const box = sandbox(`- id: llm-pi-ai
  config:
    providers:
      current:
        models:
          - id: m1
          - id: ''
          - id: m2
      other:
        models:
          - id: x1
`);
  try {
    const rows = availableModels(box.context, 2);
    assert.deepEqual(rows, ['current/m1', 'current/m2', '… 1 more (dsh-cli models)']);
    assert.ok(!rows.some((row) => row.endsWith('/')));
  } finally {
    box.cleanup();
  }
});

test('availableModels degrades to an empty list when the profile is unreadable', () => {
  assert.deepEqual(
    availableModels({ dshHome: 'C:\\definitely-missing', profile: 'nope', provider: 'p', model: 'm' }),
    [],
  );
});
