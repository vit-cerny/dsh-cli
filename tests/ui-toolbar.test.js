/**
 * Toolbar and session-picker tests — the width-clipping and scroll guarantees.
 *
 * Every assertion runs on the returned string, so nothing here needs a TTY, a
 * stream or a process write: the module is pure by contract.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PICKER_ROWS, Toolbar, renderSessionPicker } from '../src/ui/toolbar.js';
import { createTheme } from '../src/ui/theme.js';
import { stripAnsi } from '../src/ui/ansi.js';
import { displayWidth } from '../src/ui/text.js';

const PLAIN = createTheme({ color: false });
const COLOUR = createTheme({ color: true });

/** Build a toolbar with colour off unless a test asks otherwise. */
function makeToolbar(options = {}) {
  return new Toolbar({ width: 80, theme: PLAIN, ...options });
}

/** A complete model, so each test can override exactly one field. */
function fullModel(patch = {}) {
  return {
    sessionTitle: 'dsh-cli',
    sessions: 3,
    provider: 'openai',
    model: 'gpt-6',
    tokens: 20522,
    cost: '$0.0042',
    rss: '250 MiB',
    status: 'busy',
    ...patch,
  };
}

/** Picker rows with predictable ids, titles, ages and cwds. */
function sessionRows(count, { activeIndex = 0 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `sess-${String(index).padStart(3, '0')}`,
    title: `session ${index}`,
    age: index === 0 ? '42s' : `${index}m`,
    cwd: 'C:/Users/example/dsh-cli',
    active: index === activeIndex,
  }));
}

/** Every separator occurrence in a plain row. */
function separators(line) {
  return line.match(/ · /g) ?? [];
}

test('full width renders every segment in contract order', () => {
  const toolbar = makeToolbar();
  const row = toolbar.render(fullModel());

  assert.equal(row, '[3 ❯ dsh-cli] · openai/gpt-6 · 20.5k tok · $0.0042 · 250 MiB · ● busy');
  assert.equal(row.includes('\u001b'), false, 'colour off emits no escapes');
  assert.ok(displayWidth(row) <= 80);
});

test('narrow width drops the least important segments and keeps the state marker', () => {
  const toolbar = makeToolbar({ width: 34 });
  const row = toolbar.render(fullModel());

  // The state marker is the reason the bar exists, so it goes last, not first.
  assert.ok(row.includes('busy'), `the state marker survives: ${row}`);
  assert.ok(row.startsWith('[3 ❯ dsh-cli]'), `session label survives: ${row}`);
  assert.equal(row.includes('250 MiB'), false, 'rss is the first thing dropped');
  assert.equal(row.includes('$0.0042'), false, 'cost dropped before tokens');
  assert.equal(row.endsWith(' · '), false, 'no separator outlives its segment');
  assert.ok(displayWidth(row) <= 34);
});

test('very narrow width clips the session label instead of erasing it', () => {
  const toolbar = makeToolbar({ width: 8 });
  const row = toolbar.render(fullModel({ status: '' }));

  assert.ok(row.startsWith('[3 ❯ '), `label still identifiable: ${row}`);
  assert.ok(row.endsWith(']'), 'the closing bracket is rebuilt, not orphaned');
  assert.ok(row.includes('…'), 'clipping is visible');
  assert.ok(displayWidth(row) <= 8, `width respected: ${displayWidth(row)}`);
});

test('empty fields leave no dangling or doubled separators', () => {
  const toolbar = makeToolbar();
  const row = toolbar.render(
    fullModel({ provider: '', model: '', tokens: null, cost: null, rss: null }),
  );

  assert.equal(row, '[3 ❯ dsh-cli] · ● busy');
  assert.equal(row.includes(' ·  · '), false);
  assert.equal(row.startsWith(' ·'), false);
  assert.equal(row.endsWith(' · '), false);
  assert.equal(separators(row).length, 1);
});

test('a model with nothing to show renders an empty row, not a stray separator', () => {
  const toolbar = makeToolbar();

  assert.equal(toolbar.render({}), '');
  assert.equal(toolbar.render(), '');
  assert.equal(toolbar.render({ tokens: null, cost: null, rss: null, status: '' }), '');
  assert.equal(toolbar.render({ sessions: 0 }), '', 'a count without a label is not a session');
});

test('provider or model alone still reads as one segment', () => {
  const toolbar = makeToolbar();

  assert.equal(toolbar.render({ provider: 'openai' }), 'openai');
  assert.equal(toolbar.render({ model: 'gpt-6' }), 'gpt-6');
});

test('interactive rendering pads to the full width for an in-place repaint', () => {
  const toolbar = makeToolbar({ width: 80, interactive: true });
  const row = toolbar.render(fullModel({ status: 'idle' }));

  assert.equal(displayWidth(row), 80, 'the old frame is fully overwritten');
  assert.match(row, /○ idle +$/, 'padding trails the content, never leads it');
});

test('non-interactive rendering has no trailing blanks', () => {
  const row = makeToolbar({ width: 60 }).render(fullModel());

  assert.equal(row, row.trimEnd());
});

test('colour-on wrapping leaves the visible text identical', () => {
  const coloured = makeToolbar({ theme: COLOUR }).render(fullModel());
  const plain = makeToolbar().render(fullModel());

  assert.ok(coloured.includes('\u001b['), 'SGR codes present when colour is on');
  assert.equal(stripAnsi(coloured), plain);
});

test('tokens are abbreviated and never rendered for a null count', () => {
  const toolbar = makeToolbar();

  assert.match(toolbar.render({ tokens: 999 }), /^999 tok$/);
  assert.match(toolbar.render({ tokens: 12000 }), /^12k tok$/);
  assert.match(toolbar.render({ tokens: 1_250_000 }), /^1\.25M tok$/);
  assert.equal(toolbar.render({ tokens: null }), '');
});

test('the picker marks the active row and keeps ids aligned', () => {
  const rows = sessionRows(3, { activeIndex: 1 });
  const lines = renderSessionPicker(rows, { width: 80, theme: PLAIN });

  assert.equal(Array.isArray(lines), true);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].startsWith('  sess-000'), true, 'inactive rows start with blank columns');
  assert.ok(lines[1].startsWith('❯ sess-001'), `active row marked: ${lines[1]}`);
  assert.match(lines[1], /session 1/);
  assert.match(lines[1], /1m/);
  assert.equal(lines.filter((line) => line.startsWith('❯')).length, 1, 'exactly one marker');
  // Ids share a column, so a scan down the list stays readable.
  assert.deepEqual(
    lines.map((line) => line.indexOf('sess-')),
    [2, 2, 2],
  );
});

test('the picker clips a long title to the column budget', () => {
  const rows = [
    {
      id: 'sess-long',
      title: 'a session title that is far too long to fit in one row of the picker',
      age: '3h',
      cwd: 'C:/Users/example/some/deeply/nested/workspace/dsh-cli',
      active: true,
    },
  ];
  const lines = renderSessionPicker(rows, { width: 60, theme: PLAIN });

  assert.equal(lines.length, 1);
  assert.ok(displayWidth(lines[0]) <= 60, `row within budget: ${displayWidth(lines[0])}`);
  assert.ok(lines[0].includes('…'), 'long title clipped with an ellipsis');
  assert.ok(lines[0].includes('sess-long'));
  assert.ok(lines[0].includes('3h'));
  assert.equal(lines[0].includes('deeply'), false, 'cwd is middle-elided, not printed whole');
});

test('the picker scrolls to keep the active row visible', () => {
  const rows = sessionRows(30, { activeIndex: 25 });
  const lines = renderSessionPicker(rows, { width: 80, height: 5, theme: PLAIN });

  assert.equal(lines.length, 6, 'five rows plus the hidden-count hint');
  const body = lines.slice(0, 5);
  assert.ok(body.some((line) => line.includes('sess-025')), 'active row is inside the window');
  assert.ok(body.some((line) => line.startsWith('❯ ')));
  assert.equal(body.some((line) => line.includes('sess-000')), false, 'the head scrolled away');
  assert.match(lines[5], /23 above/);
  assert.match(lines[5], /2 below/);
});

test('an explicit cursor takes precedence over the active row', () => {
  const rows = sessionRows(10, { activeIndex: 3 });
  const lines = renderSessionPicker(rows, { width: 80, height: 10, selected: 5, theme: PLAIN });

  const cursor = lines.filter((line) => line.startsWith('❯ '));
  assert.equal(cursor.length, 1, 'the arrow follows the cursor');
  assert.match(cursor[0], /sess-005/);
  assert.ok(lines[3].startsWith('● '), 'the attached session keeps a marker of its own');
});

test('the window follows the cursor to the tail of the list', () => {
  const rows = sessionRows(30);
  const lines = renderSessionPicker(rows, { width: 80, height: 4, selected: 29, theme: PLAIN });

  assert.match(lines[3], /^❯ .*sess-029/);
  assert.match(lines[4], /26 above/);
  assert.equal(lines[4].includes('below'), false, 'nothing hides past the tail');
});

test('a short list fits without a hint line', () => {
  const lines = renderSessionPicker(sessionRows(3), { width: 80, theme: PLAIN });

  assert.equal(lines.length, 3);
  assert.equal(lines.some((line) => line.includes('above')), false);
});

test('the picker tolerates an empty or malformed list', () => {
  // An empty picker must explain itself; a blank screen reads as broken.
  for (const input of [[], null, undefined, [null, 'x', 7]]) {
    const lines = renderSessionPicker(input);
    assert.equal(lines.length, 1, `${JSON.stringify(input)} should render one hint line`);
    assert.match(stripAnsi(lines[0]), /no sessions yet/);
  }
});

test('picker rows stay within budget at every width', () => {
  const rows = sessionRows(2, { activeIndex: 1 });
  for (let width = 1; width <= 100; width += 1) {
    for (const line of renderSessionPicker(rows, { width, theme: PLAIN })) {
      assert.ok(displayWidth(line) <= width, `width ${width}: ${displayWidth(line)} — ${line}`);
    }
  }
});

test('Toolbar.pick renders the list its session menu opens', () => {
  const toolbar = makeToolbar({ width: 70, height: 4 });
  const lines = toolbar.pick({ rows: sessionRows(12, { activeIndex: 6 }) });

  assert.equal(lines.length, 5, 'four rows plus hint at the instance height');
  assert.ok(lines.slice(0, 4).some((line) => line.includes('sess-006')));
  assert.equal(PICKER_ROWS, 10, 'default picker height');
  // No rows still yields the empty-state hint rather than a blank menu.
  assert.match(stripAnsi(toolbar.pick({})[0]), /no sessions yet/);
  assert.match(stripAnsi(toolbar.pick({ sessions: [] })[0]), /no sessions yet/);
});

test('no toolbar row ever exceeds the instance width', () => {
  const toolbar = makeToolbar({ width: 40, interactive: true });
  for (let width = 1; width <= 120; width += 1) {
    toolbar.width = width;
    const row = toolbar.render(fullModel());
    assert.ok(displayWidth(row) <= width, `width ${width}: ${row}`);
  }
});

test('a resize changes the next paint', () => {
  const toolbar = makeToolbar({ width: 100 });
  assert.match(toolbar.render(fullModel()), /\$0\.0042/);

  toolbar.width = 24;
  const narrow = toolbar.render(fullModel());
  assert.equal(narrow.includes('$0.0042'), false);
  assert.ok(displayWidth(narrow) <= 24);
});

test('a toolbar built without a theme still renders plain text', () => {
  const row = new Toolbar({ width: 80 }).render(fullModel());

  assert.equal(row.includes('\u001b'), false);
  assert.match(row, /\[3 ❯ dsh-cli\]/);
});

test('an unknown status label is shown verbatim', () => {
  assert.match(makeToolbar().render({ status: 'reconnecting' }), /^reconnecting$/);
});

test('numeric picker ages are formatted rather than printed raw', () => {
  const lines = renderSessionPicker([{ id: 's1', title: 'aged', age: 1500, active: true }], {
    width: 60,
    theme: PLAIN,
  });

  assert.match(lines[0], /1\.5s/);
});