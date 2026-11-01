import assert from 'node:assert/strict';
import test from 'node:test';

import { App } from '../src/ui/app.js';

/**
 * A fake TTY that records writes and can emit `resize`, like a real terminal.
 *
 * @param {{ columns?: number, rows?: number }} [size] Initial geometry.
 * @returns {object} Stream double with an `emitResize` helper.
 */
function fakeTty({ columns = 100, rows = 30 } = {}) {
  const listeners = new Map();
  const chunks = [];
  return {
    isTTY: true,
    columns,
    rows,
    chunks,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    removeListener(event, handler) {
      const list = listeners.get(event) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    setRawMode() {},
    resume() {},
    pause() {},
    /** Resize the fake terminal and fire the event Node would fire. */
    emitResize(nextColumns, nextRows) {
      this.columns = nextColumns;
      this.rows = nextRows;
      for (const handler of listeners.get('resize') ?? []) handler();
    },
    text() {
      return chunks.join('');
    },
  };
}

/** A driver that never sends anything, just satisfies the contract. */
function stubDriver() {
  return {
    sessionId: 'stub-session',
    client: { pid: undefined },
    async send() {
      return 'msg-1';
    },
    waitIdle: async () => {},
    on() {
      return () => {};
    },
    onEvent() {
      return () => {};
    },
    async close() {},
    async abort() {},
  };
}

test('a resize repaints at the new width instead of leaving the frame blank', async () => {
  const stdout = fakeTty({ columns: 100, rows: 30 });
  const stdin = fakeTty({ columns: 100, rows: 30 });
  const app = new App({
    driver: stubDriver(),
    stdout,
    stdin,
    interactive: true,
    version: '0.0.0',
    meta: { model: 'stub/model', cwd: 'C:\\work', sessionId: 'stub-session' },
  });

  const running = app.run();
  // Let the first paint land.
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const before = stdout.text();
  assert.match(before, /stub\/model/, 'the first frame should paint the model');
  const mark = before.length;

  stdout.emitResize(60, 20);
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  const after = stdout.text().slice(mark);
  assert.ok(after.length > 0, 'a resize must write a new frame');
  assert.match(after, /stub\/model/, 'the repainted frame must include the status bar again');

  // Every row of the new frame must fit the new width, or it would wrap.
  const { displayWidth } = await import('../src/ui/text.js');
  for (const sequence of after.split('\u001b[')) {
    const row = sequence.replace(/^[0-9;]*[A-Za-z]/, '');
    if (row.trim() === '') continue;
    assert.ok(displayWidth(row) <= 60, `row after resize is ${displayWidth(row)} wide, limit is 60`);
  }

  await app.requestQuit();
  await running;
});

test('the renderer wraps to the resized width, not the width it started at', async () => {
  const stdout = fakeTty({ columns: 100, rows: 30 });
  const stdin = fakeTty();
  const app = new App({
    driver: stubDriver(),
    stdout,
    stdin,
    interactive: true,
    version: '0.0.0',
    meta: { model: 'm', cwd: 'C:\\w', sessionId: 's' },
  });
  const running = app.run();
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  stdout.emitResize(48, 20);
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  // The transcript sink is what the renderer writes into; it must have been
  // told about the new width, or long lines would still be wrapped at 100.
  assert.equal(app.transcriptSink.columns, 48, 'the sink must re-wrap at the new width');

  await app.requestQuit();
  await running;
});