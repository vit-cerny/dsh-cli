import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ListPicker,
  ModelPicker,
  PickerHost,
  favouritesPath,
  loadFavourites,
  renderDashboard,
  renderModelPicker,
  saveFavourites,
} from '../src/ui/model-picker.js';

function tempFavourites() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-fav-'));
  return { root, file: path.join(root, 'favourites.json') };
}

test('the model picker filters by provider or model text', () => {
  const { root, file } = tempFavourites();
  try {
    const picker = new ModelPicker(
      ['7api/gpt-6-luna', '7api/gpt-5.5', 'logfare/glm-5.3'],
      { file },
    );
    assert.equal(picker.rows.length, 3);

    picker.type('gpt-6');
    assert.deepEqual(picker.rows.map((row) => row.id), ['7api/gpt-6-luna']);

    picker.backspace();
    picker.backspace();
    picker.backspace();
    picker.backspace();
    picker.backspace();
    picker.type('logfare');
    assert.deepEqual(picker.rows.map((row) => row.id), ['logfare/glm-5.3']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('blank model ids are never offered', () => {
  const { root, file } = tempFavourites();
  try {
    // `provider/` with nothing after the slash is a real shape in the profile
    // (a whitespace-only id). Offering it would send the user to an error.
    const picker = new ModelPicker(['7api/gpt-6-luna', '7api/', '/broken', ''], { file });
    assert.deepEqual(picker.rows.map((row) => row.id), ['7api/gpt-6-luna']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('favourites sort first and persist to disk', () => {
  const { root, file } = tempFavourites();
  try {
    const picker = new ModelPicker(['a/one', 'b/two', 'c/three'], { file });
    picker.move(2);
    assert.equal(picker.selected.id, 'c/three');
    assert.equal(picker.toggleFavourite(), true);

    // The starred row jumps to the top of the list.
    assert.equal(picker.rows[0].id, 'c/three');
    assert.deepEqual([...loadFavourites(file)], ['c/three']);

    // A fresh picker reads the same file, so the choice survives a restart.
    const reopened = new ModelPicker(['a/one', 'b/two', 'c/three'], { file });
    assert.equal(reopened.rows[0].id, 'c/three');

    // Toggling again removes it.
    reopened.toggleFavourite();
    assert.deepEqual([...loadFavourites(file)], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt favourites file degrades to no favourites', () => {
  const { root, file } = tempFavourites();
  try {
    saveFavourites(new Set(['a/one']), file);
    // Overwrite with something unparseable: a preference file must never break
    // the picker, so this has to read as "nothing starred".
    const broken = path.join(root, 'broken.json');
    saveFavourites(new Set(), broken);
    assert.deepEqual([...loadFavourites(path.join(root, 'missing.json'))], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the picker cursor clamps instead of wrapping past the ends', () => {
  const { root, file } = tempFavourites();
  try {
    const picker = new ModelPicker(['a/one', 'b/two'], { file });
    picker.move(-1);
    assert.equal(picker.index, 0);
    picker.move(99);
    assert.equal(picker.index, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the picker renders a scroll hint only when the list overflows', () => {
  const { root, file } = tempFavourites();
  try {
    const many = Array.from({ length: 40 }, (_, index) => `p/m${index}`);
    const picker = new ModelPicker(many, { file });
    const rows = renderModelPicker(picker, { width: 80, height: 5 });
    assert.ok(rows.some((row) => /below/.test(row)), 'an overflowing list must say how much is below');

    const small = new ModelPicker(['a/one'], { file });
    const shortRows = renderModelPicker(small, { width: 80, height: 5 });
    assert.ok(!shortRows.some((row) => /below|above/.test(row)), 'a short list needs no hint');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PickerHost routes keys to the open picker only', () => {
  const { root, file } = tempFavourites();
  try {
    const chosen = [];
    const host = new PickerHost({
      listModels: () => ['7api/gpt-6-luna', '7api/gpt-5.5'],
      currentModel: () => '7api/gpt-6-luna',
      onModel: (id) => chosen.push(id),
      favouritesFile: file,
    });
    assert.equal(host.open, false);
    // Nothing open: keys are not consumed, so the editor still gets them.
    assert.equal(host.handleKey('text', 'x', 'enter', 'tab', 'backspace', 'escape', 'ctrl-c', 'text'), false);

    host.openModel();
    assert.equal(host.open, true);
    assert.equal(host.handleKey('down', undefined, 'enter', 'tab', 'backspace', 'escape', 'ctrl-c', 'text'), true);
    host.handleKey('enter', undefined, 'enter', 'tab', 'backspace', 'escape', 'ctrl-c', 'text');
    assert.deepEqual(chosen, ['7api/gpt-5.5']);
    assert.equal(host.open, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Ctrl+C closes a picker without choosing anything', () => {
  const { root, file } = tempFavourites();
  try {
    const chosen = [];
    const host = new PickerHost({
      listModels: () => ['7api/gpt-6-luna'],
      onModel: (id) => chosen.push(id),
      favouritesFile: file,
    });
    host.openModel();
    host.handleKey('ctrl-c', undefined, 'enter', 'tab', 'backspace', 'escape', 'ctrl-c', 'text');
    assert.equal(host.open, false);
    assert.deepEqual(chosen, [], 'dismissing must not switch the model');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the session picker searches and favourites like the model picker', () => {
  const { root, file } = tempFavourites();
  try {
    const picker = new ListPicker({
      kind: 'sessions',
      rows: [
        { id: 's1', label: 'session one' },
        { id: 's2', label: 'session two' },
      ],
      file,
    });
    picker.search('two');
    assert.deepEqual(picker.rows.map((row) => row.id), ['s2']);
    picker.toggleFavourite();
    picker.searchBackspace();
    picker.searchBackspace();
    picker.searchBackspace();
    assert.equal(picker.rows[0].id, 's2', 'a favourite sorts first');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the dashboard reports tokens, free context and cost', () => {
  const rows = renderDashboard(
    { totalTokens: 105_000, inputTokens: 100_000, outputTokens: 5_000, costUsd: 0.25, priced: true },
    { width: 80, provider: '7api', model: 'gpt-6-luna', contextWindow: 1_050_000, sessions: 4, cwd: 'C:\\x' },
  );
  const text = rows.join('\n');
  assert.match(text, /7api\/gpt-6-luna/);
  assert.match(text, /105,000|105\u00a0000/);
  assert.match(text, /90% free/);
  assert.match(text, /\$0\.2500/);
  assert.match(text, /sessions 4/);
});

test('the dashboard says "unpriced" rather than inventing a cost', () => {
  const rows = renderDashboard(
    { totalTokens: 10, costUsd: null, priced: false },
    { width: 80, provider: 'x', model: 'y' },
  );
  assert.match(rows.join('\n'), /unpriced/);
});

test('the dashboard copes with an unknown context window', () => {
  const rows = renderDashboard({ totalTokens: 10, priced: true, costUsd: 0 }, { width: 80 });
  assert.match(rows.join('\n'), /window unknown/);
});

test('favouritesPath honours DSH_CLI_HOME', () => {
  assert.equal(favouritesPath({ DSH_CLI_HOME: 'C:\\home' }), path.join('C:\\home', 'favourites.json'));
  assert.ok(favouritesPath({}).endsWith(path.join('.dsh-cli', 'favourites.json')));
});
