/**
 * Terminal input for the dsh-cli TUI (task T3).
 *
 * Uses `node:readline`'s `emitKeypressEvents` for keypress parsing *and* for
 * its dead-reliable raw-mode handling (`setRawMode`, Ctrl+C on Windows), but
 * does not use the `Interface` prompt: we need our own multi-line box, which
 * `readline` cannot draw.
 *
 * The layout logic is exported as pure functions (`promptLines`,
 * `caretWindow`) so the editor can be tested under `node --test` without a TTY.
 *
 * @module src/ui/input
 */

import process from 'node:process';
import { ERASE_DOWN, cursor } from './ansi.js';
import { KeyDecoder } from './keymap.js';
import { displayWidth, truncateToWidth } from './text.js';

/**
 * Horizontal window over one logical line so the caret is always visible when
 * the text is wider than the terminal.
 *
 * @param {string} line Line text.
 * @param {number} col Caret index inside `line`.
 * @param {number} width Available columns.
 * @returns {{ text: string, caret: number }} Visible slice + caret column.
 */
export function caretWindow(line, col, width) {
  const limit = Math.max(1, Math.trunc(Number(width) || 1));
  const text = String(line ?? '');
  const caret = Math.max(0, Math.min(Number(col) || 0, text.length));
  if (displayWidth(text) <= limit) {
    return { text, caret: displayWidth(text.slice(0, caret)) };
  }
  // Keep a little look-behind so typing at the right edge still shows context.
  const margin = Math.max(4, Math.floor(limit / 3));
  let start = 0;
  while (start < caret && displayWidth(text.slice(start, caret)) > limit - margin) start += 1;
  const slice = text.slice(start);
  return {
    text: truncateToWidth(slice, limit),
    caret: displayWidth(text.slice(start, caret)),
  };
}

/**
 * Build the display rows for the editor snapshot.
 *
 * Row 0 is prefixed with `❯`, continuation rows with two spaces, matching the
 * Claude Code style prompt.
 *
 * @param {{ lines: string[], row: number, col: number }} snapshot Editor snapshot.
 * @param {{ columns: number, glyph?: string, style?: object }} options Options.
 * @returns {{ rows: string[], caretRow: number, caretCol: number }} Render plan.
 */
export function promptLines(snapshot, { columns, glyph = '❯', style } = {}) {
  const width = Math.max(8, Math.trunc(Number(columns) || 80));
  const lines = Array.isArray(snapshot?.lines) && snapshot.lines.length ? snapshot.lines : [''];
  const row = Math.max(0, Math.min(Number(snapshot?.row) || 0, lines.length - 1));
  const rows = [];
  let caretRow = 0;
  let caretCol = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const prefix = index === 0 ? `${glyph} ` : '  ';
    const prefixWidth = displayWidth(prefix);
    const isCaretRow = index === row;
    const window = caretWindow(
      lines[index],
      isCaretRow ? snapshot?.col ?? lines[index].length : lines[index].length,
      width - prefixWidth,
    );
    const painted = typeof style === 'function' ? style(window.text) : window.text;
    rows.push(`${prefix}${painted}`);
    if (isCaretRow) {
      caretRow = index;
      caretCol = prefixWidth + window.caret;
    }
  }
  return { rows, caretRow, caretCol };
}

/**
 * Drives the prompt: raw mode, keypress decoding, repaint on change.
 */
export class InputController {
  /**
   * @param {object} options Options.
   * @param {import('./editor.js').Editor} options.editor Line editor model.
   * @param {NodeJS.ReadStream} [options.stdin] Input stream.
   * @param {NodeJS.WriteStream} [options.stdout] Output stream.
   * @param {(action: string, payload?: any) => void} options.onAction Action sink.
   * @param {() => { columns: number, promptHint?: string }} [options.hints] Layout hints.
   * @param {() => string[]} [options.header] Rows pinned above the prompt.
   */
  constructor({ editor, stdin = process.stdin, stdout = process.stdout, onAction, hints, header, detached }) {
    this.editor = editor;
    this.stdin = stdin;
    this.stdout = stdout;
    this.detached = detached === true;
    this.onAction = onAction;
    this.hints = hints ?? (() => ({ columns: 80 }));
    /**
     * Rows pinned above the prompt, redrawn with it.
     *
     * The tab bar lives here rather than being repainted by seeking to row 1:
     * the prompt block is the only thing that knows how many rows it owns above
     * the caret, so it is the only place a redraw can run safely.
     */
    this.header = header ?? (() => []);
    this.decoder = new KeyDecoder();
    this.drawnRows = 0;
    this.started = false;
    this.hint = '';
    this._onData = this._onData.bind(this);
    this._onResize = this._onResize.bind(this);
  }

  /**
   * Whether this controller should draw.
   *
   * A detached controller only decodes keys: the fixed-frame view owns the
   * screen, and two painters on one terminal fight over the cursor.
   */
  get interactive() {
    return this.detached !== true && Boolean(this.stdout?.isTTY);
  }

  /** Enter raw mode and begin listening for keys. */
  start() {
    if (this.started) return;
    this.started = true;
    if (typeof this.stdin.setRawMode === 'function') {
      this.stdin.setRawMode(true);
    }
    this.stdin.resume?.();
    // No `readline.emitKeypressEvents` here: it installs a competing `data`
    // listener that consumes keypresses, so Enter reached readline's parser and
    // never arrived at `_onData`. The KeyDecoder already handles raw bytes.
    this.stdin.on('data', this._onData);
    if (typeof this.stdout.on === 'function') this.stdout.on('resize', this._onResize);
    this.render();
  }

  /** Leave raw mode and detach listeners. */
  stop() {
    if (!this.started) return;
    this.started = false;
    if (typeof this.stdin.removeListener === 'function') this.stdin.removeListener('data', this._onData);
    if (typeof this.stdout.removeListener === 'function') {
      this.stdout.removeListener('resize', this._onResize);
    }
    if (typeof this.stdin.setRawMode === 'function') {
      try {
        this.stdin.setRawMode(false);
      } catch {
        /* stream already closed */
      }
    }
    this.stdin.pause?.();
  }

  /** @param {Buffer|string} chunk Raw stdin. */
  _onData(chunk) {
    for (const event of this.decoder.decode(chunk)) {
      if (event.key === 'ctrl-c') {
        // Ctrl+C is surfaced as a real SIGINT (the atomic stream write is not
        // available here), so the owner's SIGINT path — restore terminal state
        // and, in the TUI, abort or quit — is the single implementation instead
        // of a second one inside the key handler.
        try {
          process.kill(process.pid, 'SIGINT');
        } catch {
          /* no SIGINT support: the key is then simply ignored */
        }
        continue;
      }
      try {
        this.onAction?.(event.key, event.text);
      } catch (error) {
        // Never let a handler typo kill the terminal session.
        this.stdout.write(`\r\ninput error: ${error?.message ?? error}\r\n`);
      }
    }
  }

  _onResize() {
    this.drawnRows = 0;
    this.render();
  }

  /** Update the transient hint line shown under the prompt. */
  setHint(hint) {
    this.hint = String(hint ?? '');
  }

  /**
   * Repaint only the prompt block: move up over the previously drawn rows,
   * clear them, redraw, then place the caret. The transcript above is never
   * touched, which is what keeps a long session cheap to keep on screen.
   *
   * @returns {void}
   */
  render() {
    if (!this.interactive) return;
    const { columns } = this.hints();
    const plan = promptLines(this.editor.snapshot(), { columns });
    // Header rows come first so they scroll away with the block rather than
    // being pinned by absolute addressing.
    // Header rows are padded to the full width by the toolbar, so trimming has
    // to happen before clipping. The budget leaves one column spare because
    // `truncateToWidth` spends a column on its ellipsis: a row that still filled
    // the line would wrap on the newline and leave one stray character behind.
    const budget = Math.max(1, columns - 2);
    const headerRows = this.header().map((row) => {
      const plain = String(row ?? '').trimEnd();
      return plain === '' ? '' : truncateToWidth(plain, budget);
    });
    const rows = [...headerRows, ...plan.rows];
    // `plan.caretRow` counts from the first prompt row; shift it past the header.
    const caretRow = plan.caretRow + headerRows.length;

    let out = '';
    if (this.drawnRows > 0) {
      // Return to column 1 first. The caret sits at the prompt column, and
      // ERASE_DOWN clears only from the current column rightward, so erasing
      // from there left the first characters of the top row behind ("ds" from
      // the banner) once the block grew a hint list.
      out += `${cursor.up(this.drawnRows)}${cursor.column(1)}${ERASE_DOWN}`;
    }
    for (const row of rows) out += `${row}\n`;
    const hintRows = this.hint
      ? String(this.hint)
          .split('\n')
          .map((line) => truncateToWidth(line, columns))
      : [];
    for (const row of hintRows) out += `${row}\n`;

    // The writes above leave the caret on the line *below* the block, so the
    // distance back to the caret row equals the block height minus the row.
    this.drawnRows = rows.length + hintRows.length;
    // Rows between the block top and the caret. `erase` rewinds exactly this
    // far, then clears downward: rewinding the full block height instead landed
    // one row above the block and ate the banner's last line.
    this.caretOffset = caretRow;
    const back = this.drawnRows - caretRow;
    if (back > 0) out += cursor.up(back);
    out += cursor.column(plan.caretCol + 1);
    this.stdout.write(out);
  }

  /** Wipe the prompt block (called before transcript output is printed). */
  erase() {
    if (!this.interactive || this.drawnRows === 0) return;
    // `up(0)` clamps to one row in some terminals, so skip the move when the
    // caret already sits on the block's first row. The caret also keeps its
    // column across the move, and ERASE_DOWN only clears from that column
    // rightward, so return to column 1 first or the row's left edge survives.
    const rewind = Number.isInteger(this.caretOffset) ? this.caretOffset : 0;
    this.stdout.write(`${rewind > 0 ? cursor.up(rewind) : ''}${cursor.column(1)}${ERASE_DOWN}`);
    this.drawnRows = 0;
    this.caretOffset = 0;
  }
}
