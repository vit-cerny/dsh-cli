/**
 * Full-screen TUI view: alternate screen, transcript viewport, bordered input,
 * status bar — the layout opencode uses.
 *
 * ## Why this exists
 *
 * The first interactive implementation printed the transcript into the normal
 * scrollback and then moved the cursor with relative offsets to redraw the
 * prompt underneath it. That design has an unbounded failure surface: every
 * repaint had to know exactly how many rows the prompt occupied, where the caret
 * had been left, and which cells an erase sequence would reach. Three separate
 * bugs came out of it — `cursor.up(0)` clamping to 1 and eating the line above,
 * `ED` acting from the caret column so old text survived underneath new, and a
 * second `ED` after the prompt block deleting the transcript below it.
 *
 * A fixed-size frame with absolute cursor addressing removes the whole class:
 * the owner composes an array of rows, and painting is "write the rows that
 * changed at their own coordinates". Nothing depends on where the cursor was.
 *
 * ## Layout
 *
 * ```
 *   ┌ transcript viewport ─────────────────────────────┐  rows 1 .. h-7
 *   │ ❯ what the user asked                            │
 *   │ ⏺ assistant answer                               │
 *   └──────────────────────────────────────────────────┘
 *                                                          spacer
 *   ╭──────────────────────────────────────────────────╮  input box
 *   │ ❯ typing here                                    │  (grows with content)
 *   ╰──────────────────────────────────────────────────╯
 *   model · cwd · tokens · cost · status                  status bar
 * ```
 *
 * @module src/ui/fullscreen
 */

import { CLEAR_LINE_RIGHT, CLEAR_SCREEN, cursor, ERASE_DOWN } from './ansi.js';
import { boxed } from './screen.js';
import { displayWidth, truncateToWidth, wrapText } from './text.js';

/** Rows the status bar occupies at the bottom of the frame. */
const STATUS_ROWS = 1;
/** Blank row between the transcript and the input box. */
const GAP_ROWS = 1;
/** Input box chrome: top border, content, bottom border. */
const BOX_CHROME_ROWS = 2;
/** Rows the optional header toolbar occupies, including its trailing rule. */
const HEADER_ROWS = 2;
/** Upper bound on retained transcript lines, so a long session stays bounded. */
export const MAX_TRANSCRIPT_LINES = 4000;

/** Enter / leave the alternate screen buffer. */
const ALT_SCREEN_ON = '\u001b[?1049h';
const ALT_SCREEN_OFF = '\u001b[?1049l';

/**
 * Sink that captures transcript output as lines instead of writing to the
 * terminal.
 *
 * The `Renderer` already knows how to format messages, tools and markdown, and
 * it writes to whatever stream it is given. Giving it this sink reuses all of
 * that unchanged: the formatter keeps working, and the lines land in a buffer
 * the full-screen view can paint. It also keeps the renderer's own line
 * bookkeeping (`atLineStart`, wrapping) intact, because from its point of view
 * it is still writing to a terminal.
 */
export class TranscriptSink {
  /**
   * @param {object} [options] Options.
   * @param {number} [options.columns] Wrap width.
   * @param {number} [options.limit] Retained line ceiling.
   */
  constructor({ columns = 80, limit = MAX_TRANSCRIPT_LINES } = {}) {
    this.columns = columns;
    this.limit = Math.max(200, Math.trunc(limit) || MAX_TRANSCRIPT_LINES);
    /** @type {string[]} Finished rows, oldest first. */
    this.lines = [];
    /** Text written since the last newline. */
    this.partial = '';
    this.isTTY = true;
  }

  /**
   * Accept a chunk from the renderer.
   *
   * @param {string} chunk Text, possibly containing newlines.
   * @returns {boolean} Always true (stream contract).
   */
  write(chunk) {
    const text = String(chunk ?? '');
    if (text === '') return true;
    const pieces = text.replace(/\r\n?/g, '\n').split('\n');
    for (const [index, piece] of pieces.entries()) {
      if (index > 0) {
        this.lines.push(this.partial);
        this.partial = '';
      }
      this.partial += piece;
    }
    this.#trim();
    return true;
  }

  /** Drop the oldest rows once the ceiling is exceeded. */
  #trim() {
    const overflow = this.lines.length - this.limit;
    if (overflow > 0) this.lines.splice(0, overflow);
  }

  /**
   * Replace the most recently written row.
   *
   * A tool call is reported twice — once when it starts and once with its
   * result — and a scrolling log would otherwise show both, as two near
   * identical cards for one call. Replacing the row in place is what makes the
   * transcript read like opencode's: one line per call whose glyph changes from
   * running to done.
   *
   * Declining (returning false) is the correct answer whenever the last write
   * is not on its own row, because then the target line has other content on it.
   *
   * @param {string} text Replacement row text.
   * @returns {boolean} True when the row was replaced.
   */
  replaceLast(text) {
    if (this.partial !== '') return false;
    if (this.lines.length === 0) return false;
    this.lines[this.lines.length - 1] = String(text ?? '');
    return true;
  }

  /** Every row, including the unfinished last one. */
  get rows() {
    return this.partial === '' ? this.lines.slice() : [...this.lines, this.partial];
  }

  /**
   * Re-wrap for a new width.
   *
   * The buffer holds rows that were already wrapped to the old width, so a
   * resize has to unwrap and re-wrap. This is only done on resize, never per
   * frame.
   *
   * @param {number} columns New width.
   * @returns {void}
   */
  setColumns(columns) {
    const next = Math.max(20, Math.trunc(columns) || 80);
    if (next === this.columns) return;
    this.columns = next;
    // Rows are re-wrapped by their visible text; styling is preserved per row.
    const rewrapped = [];
    for (const row of this.rows) {
      for (const line of wrapText(row, next)) rewrapped.push(line);
    }
    this.lines = rewrapped.slice(-this.limit);
    this.partial = '';
  }

  /** Clear the transcript (used by `/clear`). */
  clear() {
    this.lines = [];
    this.partial = '';
  }
}

/**
 * The full-screen view.
 */
export class FullScreenView {
  /**
   * @param {object} options Options.
   * @param {NodeJS.WriteStream} options.stdout Output stream (must be a TTY).
   * @param {TranscriptSink} options.sink Transcript buffer.
   * @param {object} options.theme Theme from `createTheme`.
   * @param {() => number} [options.columns] Width provider.
   * @param {() => number} [options.rows] Height provider.
   */
  constructor({ stdout, sink, theme, columns, rows }) {
    this.stdout = stdout;
    this.sink = sink;
    this.theme = theme;
    this.getColumns = columns ?? (() => Number(stdout?.columns) || 80);
    this.getRows = rows ?? (() => Number(stdout?.rows) || 24);
    /** Row offset from the top of the transcript, for scrolling. */
    this.scroll = 0;
    this.started = false;
    /** Last painted frame, for the diff. */
    this.painted = [];
  }

  /** Whether the stream can host a full-screen UI. */
  get interactive() {
    return Boolean(this.stdout?.isTTY);
  }

  /** Width available to content. */
  get columns() {
    return Math.max(20, Math.trunc(this.getColumns()) || 80);
  }

  /** Height available to content. */
  get rows() {
    return Math.max(6, Math.trunc(this.getRows()) || 24);
  }

  /** Enter the alternate screen and hide the cursor. */
  start() {
    if (this.started || !this.interactive) return;
    this.started = true;
    // The alternate screen means the shell's scrollback is restored intact on
    // exit — quitting the TUI must not leave a half-painted frame in the user's
    // history. `?1049h` is the variant that also clears; `?47h` does not.
    this.stdout.write(`${ALT_SCREEN_ON}${CLEAR_SCREEN}${cursor.hide}`);
  }

  /** Leave the alternate screen and restore the cursor. */
  stop() {
    if (!this.started) return;
    this.started = false;
    this.stdout.write(`${cursor.show}${ALT_SCREEN_OFF}`);
  }

  /** Rows reserved for the transcript viewport. */
  get viewportRows() {
    const boxRows = BOX_CHROME_ROWS + this.inputRows;
    return Math.max(1, this.rows - boxRows - STATUS_ROWS - GAP_ROWS);
  }

  /** Input rows needed for the current prompt (set by the caller each frame). */
  inputRows = 1;

  /**
   * Compose and paint one frame.
   *
   * @param {object} state Frame state.
   * @param {{ lines: string[], row: number, col: number }} state.editor Editor snapshot.
   * @param {string[]} [state.hint] Hint rows (completion menu).
   * @param {string[]} [state.status] Status bar segments (plain, pre-styled).
   * @param {string[]} [state.header] Toolbar rows drawn above the transcript.
   * @param {boolean} [state.busy] Whether a turn is running.
   * @returns {void}
   */
  paint({ editor, hint = [], status = [], header = [], busy = false }) {
    if (!this.interactive) return;
    const width = this.columns;
    const height = this.rows;

    // --- input box -------------------------------------------------------
    const promptRows = this.#promptRows(editor, width);
    this.inputRows = Math.max(1, promptRows.length);
    // One column of slack: a row that exactly fills the terminal width trips
    // the deferred-wrap flag, and the next write then scrolls the screen by a
    // line — which shifts every row of the frame and corrupts the layout.
    const boxWidth = Math.max(20, width - 1);
    const box = boxed({
      lines: promptRows,
      width: boxWidth,
      border: this.theme.style.muted,
    });

    // --- vertical budget --------------------------------------------------
    // Everything except the transcript is fixed: the input box, the gap above
    // it, the hint menu and the status bar. The transcript gets whatever is
    // left, so the status bar is pinned to the last row instead of being pushed
    // off the bottom whenever a completion menu opens.
    const fixed = GAP_ROWS + box.length + hint.length + STATUS_ROWS + (header.length > 0 ? header.length : 0);
    const viewport = Math.max(1, height - fixed);

    // --- transcript viewport ---------------------------------------------
    const all = this.sink.rows;
    // Scrolling is expressed from the bottom: 0 = pinned to the newest row.
    const end = Math.max(0, all.length - this.scroll);
    const start = Math.max(0, end - viewport);
    const visible = all.slice(start, end);
    // The transcript is bottom-aligned: blank rows belong above it, next to the
    // input, not under it. Padding at the top keeps the newest line adjacent to
    // the prompt, which is where the eye already is.
    while (visible.length < viewport) visible.unshift('');

    // --- status bar -------------------------------------------------------
    // Segments arrive most-important-first. Fit as many as possible and drop
    // the rest, so narrow terminals lose the cwd (recoverable, obvious) rather
    // than the state marker (the thing the bar exists to say).
    const statusRow = this.#fitSegments(status, width);

    // --- assemble ---------------------------------------------------------
    // The header (toolbar) is pinned above the transcript, so session, project
    // and menu state stay visible no matter how far the transcript scrolls.
    const frame = [...header.map((row) => truncateToWidth(row, width))];
    frame.push(...visible);
    for (let index = 0; index < GAP_ROWS; index += 1) frame.push('');
    frame.push(...box);
    frame.push(...hint);
    frame.push(truncateToWidth(statusRow, width));

    this.#paintFrame(frame, width, height);

    // Place the caret inside the box. Row index of the caret within the frame:
    const boxTop = header.length + viewport + GAP_ROWS + 1; // +1 for the top border row
    const caretRow = boxTop + (editor?.row ?? 0);
    const caretCol = 3 + this.#caretColumn(promptRows, editor);
    this.stdout.write(`${cursor.to(Math.min(height, caretRow), Math.max(1, caretCol))}${cursor.show}`);
  }

  /**
   * Join as many status segments as fit, dropping from the end.
   *
   * @param {string[]} segments Pre-styled segments, most important first.
   * @param {number} width Available columns.
   * @returns {string} The status row, never wider than `width`.
   */
  #fitSegments(segments, width) {
    const separator = this.theme.style.muted(' · ');
    const kept = [];
    for (const segment of segments) {
      const candidate = [...kept, segment].join(separator);
      if (displayWidth(candidate) > width) break;
      kept.push(segment);
    }
    // A single segment wider than the frame (a very long model id) is truncated
    // rather than dropped: an empty status bar says less than a clipped one.
    if (kept.length === 0 && segments.length > 0) {
      return truncateToWidth(segments[0], width);
    }
    return kept.join(separator);
  }

  /**
   * Build the prompt rows inside the box.
   *
   * @param {{ lines: string[], row: number, col: number }} editor Editor snapshot.
   * @param {number} width Frame width.
   * @returns {string[]} Rows, first row carries the prompt glyph.
   */
  #promptRows(editor, width) {
    const lines = Array.isArray(editor?.lines) && editor.lines.length > 0 ? editor.lines : [''];
    const inner = Math.max(4, width - 4);
    const rows = [];
    for (const [index, line] of lines.entries()) {
      const prefix = index === 0 ? '❯ ' : '  ';
      // Wrap long input so it stays inside the box instead of being cut off.
      const wrapped = wrapText(line, Math.max(4, inner - displayWidth(prefix)));
      for (const [chunkIndex, chunk] of wrapped.entries()) {
        rows.push(`${chunkIndex === 0 ? prefix : '  '}${chunk}`);
      }
    }
    return rows;
  }

  /**
   * Caret column inside the box, for the current editor position.
   *
   * @param {string[]} promptRows Rendered prompt rows.
   * @param {{ row: number, col: number, lines: string[] }} editor Editor snapshot.
   * @returns {number} 1-based column offset from the box's left edge.
   */
  #caretColumn(promptRows, editor) {
    const row = Math.max(0, Math.min(editor?.row ?? 0, promptRows.length - 1));
    const prefix = row === 0 ? 2 : 2;
    const text = (editor?.lines ?? [''])[editor?.row ?? 0] ?? '';
    const col = Math.max(0, Math.min(editor?.col ?? 0, text.length));
    return prefix + displayWidth(text.slice(0, col));
  }

  /**
   * Write only the rows that differ from the previous frame.
   *
   * @param {string[]} frame Composed rows.
   * @param {number} width Frame width.
   * @param {number} height Frame height.
   * @returns {void}
   */
  #paintFrame(frame, width, height) {
    let out = '';
    for (let index = 0; index < height; index += 1) {
      const row = truncateToWidth(frame[index] ?? '', width);
      if (this.painted[index] === row) continue;
      out += `${cursor.to(index + 1, 1)}${row}${CLEAR_LINE_RIGHT}`;
    }
    this.painted = frame.slice(0, height).map((row) => truncateToWidth(row ?? '', width));
    if (out !== '') this.stdout.write(out);
  }

  /** Force the next paint to rewrite every row. */
  invalidate() {
    this.painted = [];
  }

  /** Clear the visible screen (used by Ctrl+L). */
  clearScreen() {
    this.stdout.write(`${CLEAR_SCREEN}${ERASE_DOWN}`);
    this.invalidate();
  }

  /**
   * Scroll the transcript viewport.
   *
   * @param {number} delta Positive scrolls up (towards older lines).
   * @returns {boolean} True when the offset changed.
   */
  scrollBy(delta) {
    const maxScroll = Math.max(0, this.sink.rows.length - this.viewportRows);
    const next = Math.max(0, Math.min(maxScroll, this.scroll + delta));
    if (next === this.scroll) return false;
    this.scroll = next;
    return true;
  }
}
