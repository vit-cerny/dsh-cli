/**
 * Shared test doubles for the T3 UI tests.
 *
 * The UI is built against the *contract* owned by T2 (`src/session/driver.js`
 * and `src/session/events.js`). These fakes implement exactly that contract so
 * the UI can be asserted before/independently of the real session code, and so
 * no test ever touches a child process, a network socket or a real TTY.
 */

import { EventEmitter } from 'node:events';
import process from 'node:process';
import { stripAnsi } from '../src/ui/ansi.js';

/**
 * Minimal writable stream double. Captures everything and exposes the fields
 * the renderer reads (`isTTY`, `columns`).
 */
export class FakeStream {
  constructor({ isTTY = false, columns = 80 } = {}) {
    this.chunks = [];
    this.isTTY = isTTY;
    this.columns = columns;
    this.encoding = 'utf8';
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  on() {
    return this;
  }

  removeListener() {
    return this;
  }

  /** Raw captured output. */
  get raw() {
    return this.chunks.join('');
  }

  /** Captured output without ANSI escapes (what a pipe would receive). */
  get text() {
    return stripAnsi(this.raw);
  }

  /** Output split into visible lines. */
  get lines() {
    return this.text.split('\n');
  }

  /** Drop captured output. */
  clear() {
    this.chunks = [];
  }
}

/**
 * A readable stream double that replays scripted input lines and then EOFs,
 * mimicking `readline`'s async iterator in non-interactive mode.
 */
export class FakeStdin extends EventEmitter {
  constructor(lines = []) {
    super();
    this.lines = lines.slice();
    this.isTTY = false;
    this.paused = true;
  }

  setRawMode() {
    return this;
  }

  resume() {
    this.paused = false;
    return this;
  }

  pause() {
    this.paused = true;
    return this;
  }

  // `readline.createInterface({input})` needs an async iterator.
  async *[Symbol.asyncIterator]() {
    for (const line of this.lines) yield line;
  }
}

/**
 * Fake session driver honouring the T2 contract surface used by the UI:
 * `send`, `waitIdle`, `abort`, `on`, `transcript`.
 *
 * `script(id)` lets a test decide what a prompt produces; by default it emits
 * a turn with one assistant message.
 */
export class FakeDriver extends EventEmitter {
  constructor({ script } = {}) {
    super();
    this.transcript = [];
    this.sent = [];
    this.aborted = false;
    this.closed = false;
    this.idle = true;
    this.script = script ?? defaultScript;
    this._seq = 0;
  }

  /** Increment and return the next sequence number (real driver owns this). */
  nextSeq() {
    this._seq += 1;
    return this._seq;
  }

  /**
   * Emit a normalized event both on its kind channel and on `event`, exactly
   * like the real driver is specified to do.
   */
  emitEvent(event) {
    const normalized = { seq: this.nextSeq(), turn: 1, ...event };
    this.emit(event.kind, normalized);
    this.emit('event', normalized);
    return normalized;
  }

  async send(text) {
    const messageId = `msg-${this.sent.length + 1}`;
    this.sent.push({ text, messageId });
    this.idle = false;
    const events = this.script({ text, messageId });
    for (const event of events) this.emitEvent(event);
    this.idle = true;
    return messageId;
  }

  async waitIdle() {
    this.idle = true;
    return undefined;
  }

  abort() {
    this.aborted = true;
    this.idle = true;
  }

  close() {
    this.closed = true;
  }
}

/**
 * Default turn: start → streamed text → end. Text is delivered in small
 * deltas on purpose — the renderer must append, not repaint.
 */
export function defaultScript({ text }) {
  return [
    { kind: 'turn-start', turn: 1 },
    { kind: 'assistant-text', text: 'Echo: ' },
    { kind: 'assistant-text', text: String(text) },
    { kind: 'turn-end', turn: 1, reason: { kind: 'completed' } },
  ];
}

/** Convenience: a NO_COLOR-style environment for deterministic snapshots. */
export const NO_COLOR_ENV = Object.freeze({
  NO_COLOR: '1',
  TERM: 'dumb',
  FORCE_COLOR: undefined,
});

/** Fake stdout that is a TTY but never actually draws (for colour-on tests). */
export function colorStream(options = {}) {
  return new FakeStream({ isTTY: true, columns: 80, ...options });
}

export { process };
