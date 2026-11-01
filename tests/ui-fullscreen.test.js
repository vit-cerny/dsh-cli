import assert from 'node:assert/strict';
import test from 'node:test';

import { FullScreenView, TranscriptSink } from '../src/ui/fullscreen.js';
import { createTheme } from '../src/ui/theme.js';
import { displayWidth } from '../src/ui/text.js';

/**
 * A stream that records everything and reports a fixed geometry.
 *
 * @param {{ columns?: number, rows?: number }} [size] Frame size.
 * @returns {{ stdout: object, chunks: string[], text: () => string }}
 */
function recorder({ columns = 80, rows = 24 } = {}) {
  const chunks = [];
  const stdout = {
    isTTY: true,
    columns,
    rows,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
  return { stdout, chunks, text: () => chunks.join('') };
}

/** Build a view plus its dependencies. */
function mount(size) {
  const { stdout, chunks, text } = recorder(size);
  const sink = new TranscriptSink({ columns: size?.columns ?? 80 });
  const theme = createTheme({ color: false, stream: stdout });
  const view = new FullScreenView({
    stdout,
    sink,
    theme,
    columns: () => stdout.columns,
    rows: () => stdout.rows,
  });
  return { view, sink, stdout, chunks, text };
}

/** A minimal editor snapshot. */
function editorAt(lines, row = lines.length - 1, col = (lines[row] ?? '').length) {
  return { lines, row, col };
}

/**
 * Read the final frame out of the recorded writes by replaying cursor moves.
 *
 * The view writes absolute positions (`CSI row ; col H`), so a tiny replay is
 * enough to reconstruct the screen the terminal would show.
 *
 * @param {string[]} chunks Recorded writes.
 * @param {number} rows Frame height.
 * @param {number} columns Frame width.
 * @returns {string[]} Rendered rows.
 */
function replay(chunks, rows, columns) {
  const screen = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ' '));
  let row = 0;
  let col = 0;
  const text = chunks.join('');
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '\u001b') {
      const match = /^\u001b\[(\d+);(\d+)H/.exec(text.slice(index));
      if (match !== null) {
        row = Number(match[1]) - 1;
        col = Number(match[2]) - 1;
        index += match[0].length - 1;
        continue;
      }
      // Skip any other escape sequence (SGR, erase, cursor show/hide).
      const other = /^\u001b\[[0-9;?]*[A-Za-z]/.exec(text.slice(index));
      if (other !== null) {
        index += other[0].length - 1;
        continue;
      }
      continue;
    }
    if (ch === '\r') {
      col = 0;
      continue;
    }
    if (ch === '\n') {
      row += 1;
      continue;
    }
    if (row >= 0 && row < rows && col >= 0 && col < columns) screen[row][col] = ch;
    col += 1;
  }
  return screen.map((cells) => cells.join('').trimEnd());
}

test('start enters the alternate screen, stop leaves it', () => {
  const { view, text } = mount();
  view.start();
  assert.match(text(), /\u001b\[\?1049h/, 'start must enter the alternate screen');
  assert.match(text(), /\u001b\[\?25l/, 'start must hide the cursor');
  view.stop();
  assert.match(text(), /\u001b\[\?1049l/, 'stop must leave the alternate screen');
  assert.match(text(), /\u001b\[\?25h/, 'stop must restore the cursor');
});

test('a frame never exceeds the terminal width, so no row can wrap', () => {
  for (const columns of [40, 60, 80, 100, 200]) {
    const { view, text } = mount({ columns, rows: 20 });
    view.start();
    view.paint({
      editor: editorAt([`â¯ ${'x'.repeat(columns * 2)}`]),
      // A long model id and cwd are the realistic overflow source.
      status: [`model-${'y'.repeat(60)}`, `C:\\${'z'.repeat(120)}`],
      hint: [`/${'w'.repeat(columns * 2)}`],
    });
    const rows = replay([text()], 20, columns);
    for (const [index, row] of rows.entries()) {
      assert.ok(
        displayWidth(row) <= columns,
        `columns=${columns}: row ${index + 1} is ${displayWidth(row)} wide`,
      );
    }
  }
});

test('the input box is a closed rectangle at every supported width', () => {
  for (const columns of [20, 40, 80, 120]) {
    const { view, text } = mount({ columns, rows: 16 });
    view.start();
    view.paint({ editor: editorAt(['hello']), status: ['idle'] });
    const rows = replay([text()], 16, columns);
    const top = rows.findIndex((row) => row.includes('â•­'));
    const bottom = rows.findIndex((row) => row.includes('â•°'));
    assert.ok(top >= 0, `columns=${columns}: no top border`);
    assert.ok(bottom > top, `columns=${columns}: no bottom border`);
    const open = rows[top].indexOf('â•­');
    const close = rows[top].indexOf('â•®');
    assert.ok(close > open, `columns=${columns}: top border is not closed`);
    assert.equal(rows[bottom].indexOf('â•°'), open, `columns=${columns}: corners misaligned`);
    assert.equal(rows[bottom].indexOf('â•¯'), close, `columns=${columns}: bottom corners misaligned`);
    for (let index = top + 1; index < bottom; index += 1) {
      assert.equal(rows[index][open], 'â”‚', `columns=${columns}: row ${index + 1} lost its left border`);
      assert.equal(rows[index][close], 'â”‚', `columns=${columns}: row ${index + 1} lost its right border`);
    }
  }
});

test('the status bar keeps its state marker when the terminal is narrow', () => {
  // Regression: the row used to be truncated from the right, and the state
  // marker was last, so a 40-column terminal never showed busy/idle at all.
  const { view, text } = mount({ columns: 40, rows: 12 });
  view.start();
  view.paint({
    editor: editorAt(['']),
    status: ['idle', 'gpt-6-luna', '$0.0000', 'C:\\Users\\user\\a-long-directory-name'],
  });
  const rows = replay([text()], 12, 40);
  assert.match(rows[11], /idle/, 'narrow status bar must still show the state marker');
});

test('the status bar is always the last row', () => {
  const { view, text } = mount({ columns: 100, rows: 30 });
  view.start();
  // A four-row completion menu must not push the status bar off the screen.
  view.paint({
    editor: editorAt(['/']),
    hint: ['/help', '/sessions', '/usage', '/plugins'],
    status: ['idle', 'gpt-6-luna'],
  });
  const rows = replay([text()], 30, 100);
  assert.match(rows[29], /idle/, 'status bar must stay pinned to the final row');
});

test('long input wraps inside the box instead of being cut off', () => {
  const { view, text } = mount({ columns: 40, rows: 16 });
  view.start();
  view.paint({ editor: editorAt(['abcdefghij klmnopqrst uvwxyz0123 456789']), status: ['idle'] });
  const rows = replay([text()], 16, 40);
  const joined = rows.join('\n');
  assert.ok(joined.includes('abcdefghij'), 'the start of the input must be visible');
  assert.ok(joined.includes('456789'), 'the end of the input must be visible');
});

test('a repaint of identical state writes nothing after the first frame', () => {
  const { view, chunks } = mount({ columns: 80, rows: 20 });
  view.start();
  const editor = editorAt(['stable']);
  view.paint({ editor, status: ['idle'] });
  const afterFirst = chunks.length;
  view.paint({ editor, status: ['idle'] });
  // The caret is repositioned each paint; the frame itself must not be redrawn.
  const repaint = chunks.slice(afterFirst).join('');
  assert.ok(!repaint.includes('stable'), 'an unchanged frame must not be rewritten');
});

test('invalidate forces the next paint to rewrite every row', () => {
  const { view, text } = mount({ columns: 60, rows: 14 });
  view.start();
  const editor = editorAt(['same']);
  view.paint({ editor, status: ['idle'] });
  const mark = text().length;
  // An unchanged repaint still repositions the caret, but must not rewrite the
  // content rows; only `invalidate` brings the text back.
  view.paint({ editor, status: ['idle'] });
  assert.ok(!text().slice(mark).includes('same'), 'unchanged repaint must not rewrite content');
  const before = text().length;
  view.invalidate();
  view.paint({ editor, status: ['idle'] });
  assert.ok(text().slice(before).includes('same'), 'invalidate must redraw the content');
});