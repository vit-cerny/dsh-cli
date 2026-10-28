/**
 * Pure line-editing model behind the multi-line prompt.
 *
 * Deliberately I/O-free: `src/ui/input.js` feeds it key names and prints what it
 * returns. That split is what makes the editor testable under `node --test`
 * without a TTY (`tests/ui-editor.test.js`), which the T3 brief requires.
 *
 * Model invariants:
 *   - `lines` always has >= 1 entry (an empty prompt is `['']`).
 *   - `row` in `[0, lines.length - 1]`, `col` in `[0, lines[row].length]`.
 *   - `col` is a UTF-16 index, but every movement step snaps it to code-point
 *     boundaries so surrogate pairs (emoji) are never split in half.
 *
 * @module src/ui/editor
 */

const HISTORY_LIMIT = 200;

/**
 * Snap an index to the nearest code-point boundary, walking forward.
 *
 * @param {string} text Line text.
 * @param {number} index Candidate index.
 * @returns {number} Safe index.
 */
function snapForward(text, index) {
  let i = Math.max(0, Math.min(index, text.length));
  const code = text.charCodeAt(i);
  if (Number.isNaN(code)) return text.length;
  // If we landed on a low surrogate, step forward one to keep the pair whole.
  return code >= 0xdc00 && code <= 0xdfff ? Math.min(i + 1, text.length) : i;
}

/**
 * Step one visible character left.
 *
 * @param {string} text Line text.
 * @param {number} index Current index.
 * @returns {number} New index.
 */
function stepLeft(text, index) {
  if (index <= 0) return 0;
  const prev = text.charCodeAt(index - 1);
  if (prev >= 0xdc00 && prev <= 0xdfff && index - 2 >= 0) return index - 2;
  return index - 1;
}

/**
 * Step one visible character right.
 *
 * @param {string} text Line text.
 * @param {number} index Current index.
 * @returns {number} New index.
 */
function stepRight(text, index) {
  if (index >= text.length) return text.length;
  const next = text.charCodeAt(index);
  if (next >= 0xdc00 && next <= 0xdfff) return Math.min(index + 2, text.length);
  return index + 1;
}

/**
 * Create an empty editor state.
 *
 * @returns {{ lines: string[], row: number, col: number, history: string[], historyIndex: number, draft: string[]|null }}
 */
export function createState() {
  return {
    lines: [''],
    row: 0,
    col: 0,
    history: [],
    /** `null` = editing fresh; otherwise we are browsing history. */
    historyIndex: -1,
    /** Draft preserved while browsing history, restored on the way back. */
    draft: null,
  };
}

/**
 * Immutable-ish contract for every action: mutate the state in place and
 * return `{ state, changed }`. All actions are safe on malformed input.
 */
export class Editor {
  /** @param {{ historyLimit?: number }} [options] */
  constructor({ historyLimit = HISTORY_LIMIT } = {}) {
    this.historyLimit = historyLimit;
    this.state = createState();
  }

  /** Current text with newlines, i.e. what a submit would send. */
  get text() {
    return this.state.lines.join('\n');
  }

  /** True when the prompt holds nothing but whitespace. */
  get isEmpty() {
    return this.text.trim() === '';
  }

  /** Reset to an empty prompt without touching history. */
  clear() {
    this.state.lines = [''];
    this.state.row = 0;
    this.state.col = 0;
    this.state.historyIndex = -1;
    this.state.draft = null;
    return this.state;
  }

  /**
   * Load previously submitted text for editing (used by history browsing).
   *
   * @param {string} text Multi-line text.
   */
  setText(text) {
    const lines = String(text ?? '').split('\n');
    this.state.lines = lines.length ? lines : [''];
    this.state.row = this.state.lines.length - 1;
    this.state.col = this.state.lines[this.state.row].length;
    return this.state;
  }

  /**
   * Insert text at the cursor. Embedded newlines split lines, matching a paste.
   *
   * @param {string} input Text to insert (may be multi-line).
   */
  insert(input) {
    const text = String(input ?? '');
    if (!text) return this.state;
    const { state } = this;
    const line = state.lines[state.row];
    const before = line.slice(0, state.col);
    const after = line.slice(state.col);
    const chunks = text.replace(/\r\n?/g, '\n').split('\n');
    if (chunks.length === 1) {
      state.lines[state.row] = before + chunks[0] + after;
      state.col += chunks[0].length;
      return state;
    }
    const replacement = [before + chunks[0], ...chunks.slice(1)];
    const lastIndex = replacement.length - 1;
    replacement[lastIndex] += after;
    state.lines.splice(state.row, 1, ...replacement);
    state.row += lastIndex;
    state.col = replacement[lastIndex].length - after.length;
    return state;
  }

  /** Insert a hard newline at the cursor (Ctrl+J / Shift+Enter). */
  newline() {
    return this.insert('\n');
  }

  /** Delete the character before the cursor. */
  backspace() {
    const { state } = this;
    const line = state.lines[state.row];
    if (state.col === 0) {
      if (state.row === 0) return state;
      const previous = state.lines[state.row - 1];
      state.lines.splice(state.row - 1, 2, previous + line);
      state.row -= 1;
      state.col = previous.length;
      return state;
    }
    const from = stepLeft(line, state.col);
    state.lines[state.row] = line.slice(0, from) + line.slice(state.col);
    state.col = from;
    return state;
  }

  /** Delete the character under the cursor (Delete key). */
  deleteForward() {
    const { state } = this;
    const line = state.lines[state.row];
    if (state.col >= line.length) {
      if (state.row >= state.lines.length - 1) return state;
      state.lines.splice(state.row, 2, line + state.lines[state.row + 1]);
      return state;
    }
    const to = stepRight(line, state.col);
    state.lines[state.row] = line.slice(0, state.col) + line.slice(to);
    return state;
  }

  /** Delete from the cursor back to the start of the line (Ctrl+U). */
  killToLineStart() {
    const { state } = this;
    const line = state.lines[state.row];
    state.lines[state.row] = line.slice(state.col);
    state.col = 0;
    return state;
  }

  /** Delete from the cursor to the end of the line (Ctrl+K). */
  killToLineEnd() {
    const { state } = this;
    const line = state.lines[state.row];
    state.lines[state.row] = line.slice(0, state.col);
    return state;
  }

  /** Delete the word before the cursor (Ctrl+W / Alt+Backspace). */
  killWordBefore() {
    const { state } = this;
    const line = state.lines[state.row];
    if (state.col === 0) return this.backspace();
    let index = state.col;
    while (index > 0 && /\s/.test(line[index - 1])) index -= 1;
    while (index > 0 && !/\s/.test(line[index - 1])) index -= 1;
    state.lines[state.row] = line.slice(0, index) + line.slice(state.col);
    state.col = index;
    return state;
  }

  /**
   * Move the cursor.
   *
   * @param {'left'|'right'|'up'|'down'|'home'|'end'} direction Direction.
   */
  move(direction) {
    const { state } = this;
    const line = state.lines[state.row];
    switch (direction) {
      case 'left':
        state.col = stepLeft(line, state.col);
        break;
      case 'right':
        state.col = stepRight(line, state.col);
        break;
      case 'up':
        if (state.row > 0) {
          state.row -= 1;
          state.col = snapForward(state.lines[state.row], Math.min(state.col, state.lines[state.row].length));
        }
        break;
      case 'down':
        if (state.row < state.lines.length - 1) {
          state.row += 1;
          state.col = snapForward(state.lines[state.row], Math.min(state.col, state.lines[state.row].length));
        }
        break;
      case 'home':
        state.col = 0;
        break;
      case 'end':
        state.col = line.length;
        break;
      default:
        break;
    }
    return state;
  }

  /**
   * Push submitted text onto history (deduplicating consecutive repeats).
   *
   * @param {string} text Submitted text.
   */
  commitHistory(text) {
    const value = String(text ?? '');
    if (!value.trim()) return this.state;
    const { history } = this.state;
    if (history[history.length - 1] !== value) {
      history.push(value);
      if (history.length > this.historyLimit) history.splice(0, history.length - this.historyLimit);
    }
    this.state.historyIndex = -1;
    this.state.draft = null;
    return this.state;
  }

  /**
   * History navigation.
   *
   * @param {number} delta -1 = older (↑), +1 = newer (↓).
   * @returns {boolean} True when the suggestion list should be refreshed.
   */
  browseHistory(delta) {
    const { state } = this;
    if (state.history.length === 0) return false;
    if (state.historyIndex === -1 && delta > 0) return false;
    if (state.historyIndex === -1) {
      state.draft = state.lines.slice();
      state.historyIndex = state.history.length - 1;
    } else {
      state.historyIndex += delta;
    }
    if (state.historyIndex < -1) state.historyIndex = -1;
    if (state.historyIndex >= state.history.length) state.historyIndex = state.history.length - 1;
    if (state.historyIndex === -1) {
      this.setText((state.draft ?? ['']).join('\n'));
      state.draft = null;
      return true;
    }
    this.setText(state.history[state.historyIndex]);
    return true;
  }

  /**
   * Move to the next/previous completion suggestion (Tab / Up / Down while the
   * suggestion list is open).
   *
   * @param {number} delta Direction.
   * @param {number} count Number of suggestions.
   */
  cycleSuggestion(delta, count) {
    if (!count) return 0;
    this.suggestionIndex = (((this.suggestionIndex ?? -1) + delta) % count + count) % count;
    return this.suggestionIndex;
  }

  /** Renderable snapshot: lines plus a caret position per line. */
  snapshot() {
    const { lines, row, col } = this.state;
    return { lines: lines.slice(), row, col };
  }
}
