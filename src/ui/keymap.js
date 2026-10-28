/**
 * Terminal key decoding + keymap, kept pure so it can be unit-tested without a
 * TTY.
 *
 * Input arrives from a raw-mode stdin as chunks that may contain (a) partial
 * escape sequences, (b) bracketed-paste payloads, (c) plain UTF-8 text. The
 * decoder is stateful: `decode(chunk)` returns complete key events and stashes
 * an incomplete tail for the next chunk.
 *
 * Supported bindings (also documented in the report's key table):
 *   Enter                 submit
 *   Shift+Enter / Ctrl+J  newline
 *   Up / Down             history when the caret is on the first/last line,
 *                         else move the caret
 *   Left / Right / Home / End / Ctrl+A / Ctrl+E   caret movement
 *   Ctrl+U / Ctrl+K / Ctrl+W                      kill line-start/line-end/word
 *   Backspace / Delete                            delete
 *   Tab                   accept completion (or re-indent, harmless)
 *   Ctrl+O                toggle result folding
 *   Ctrl+L                clear the screen
 *   Ctrl+C                abort turn, or quit when idle
 *   Ctrl+D                quit
 *
 * @module src/ui/keymap
 */

const KEYS = Object.freeze({
  enter: 'enter',
  newline: 'newline',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
  escape: 'escape',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  home: 'home',
  end: 'end',
  pageUp: 'pageUp',
  pageDown: 'pageDown',
  insert: 'insert',
  ctrlC: 'ctrl-c',
  ctrlD: 'ctrl-d',
  ctrlJ: 'ctrl-j',
  ctrlK: 'ctrl-k',
  ctrlL: 'ctrl-l',
  ctrlO: 'ctrl-o',
  ctrlU: 'ctrl-u',
  ctrlW: 'ctrl-w',
  ctrlA: 'ctrl-a',
  ctrlE: 'ctrl-e',
  ctrlR: 'ctrl-r',
  text: 'text',
  paste: 'paste',
  unknown: 'unknown',
});

export { KEYS };

/** CSI final bytes → key names for the sequences we care about. */
const CSI_KEYS = Object.freeze({
  A: KEYS.up,
  B: KEYS.down,
  C: KEYS.right,
  D: KEYS.left,
  H: KEYS.home,
  F: KEYS.end,
  Z: KEYS.tab, // Shift+Tab: treated as tab/back-completion
});

/**
 * Control bytes (0x00-0x1f) → key names. Anything not listed becomes `unknown`
 * so a stray control character never derails the editor.
 */
const CONTROL_KEYS = Object.freeze({
  0x01: KEYS.ctrlA,
  0x02: KEYS.left,
  0x03: KEYS.ctrlC,
  0x04: KEYS.ctrlD,
  0x05: KEYS.ctrlE,
  0x06: KEYS.right,
  0x08: KEYS.backspace,
  0x09: KEYS.tab,
  0x0a: KEYS.ctrlJ,
  0x0b: KEYS.ctrlK,
  0x0c: KEYS.ctrlL,
  0x0d: KEYS.enter,
  0x0e: KEYS.down,
  0x0f: KEYS.ctrlO,
  0x10: KEYS.up,
  0x12: KEYS.ctrlR,
  0x15: KEYS.ctrlU,
  0x17: KEYS.ctrlW,
  0x7f: KEYS.backspace,
});

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/**
 * Incremental decoder turning raw stdin chunks into key events.
 */
export class KeyDecoder {
  constructor() {
    /** Incomplete escape sequence or paste payload carried across chunks. */
    this.pending = '';
    /** True while inside a bracketed paste. */
    this.pasting = false;
  }

  /**
   * Feed a chunk of raw input.
   *
   * @param {string|Buffer} chunk Raw input.
   * @returns {Array<{ key: string, text?: string }>} Complete key events.
   */
  decode(chunk) {
    const input = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const events = [];
    let carry = this.pending;
    this.pending = '';
    // A lone ESC only means "escape" if what follows is not the rest of a
    // sequence — otherwise pressing Esc then typing `a` would swallow the `a`.
    if (carry === '\u001b' && !/^[[O]/u.test(input)) {
      events.push({ key: KEYS.escape });
      carry = '';
    }
    let buffer = carry + input;

    // Bracketed paste: consume everything between 200~ and 201~ verbatim.
    if (this.pasting) {
      const end = buffer.indexOf(PASTE_END);
      if (end === -1) {
        if (buffer) events.push({ key: KEYS.paste, text: buffer });
        return events;
      }
      const payload = buffer.slice(0, end);
      if (payload) events.push({ key: KEYS.paste, text: payload });
      buffer = buffer.slice(end + PASTE_END.length);
      this.pasting = false;
    }

    while (buffer.length > 0) {
      const escIndex = buffer.indexOf('\u001b');
      if (escIndex === -1) {
        // Plain text; strip any remaining control characters.
        let text = '';
        for (const ch of buffer) {
          const code = ch.codePointAt(0) ?? 0;
          if (code < 0x20) {
            const mapped = CONTROL_KEYS[code];
            if (text) {
              events.push({ key: KEYS.text, text });
              text = '';
            }
            events.push({ key: mapped ?? KEYS.unknown, text: mapped ? undefined : ch });
            continue;
          }
          text += ch;
        }
        if (text) events.push({ key: KEYS.text, text });
        buffer = '';
        break;
      }

      if (escIndex > 0) {
        events.push({ key: KEYS.text, text: buffer.slice(0, escIndex) });
        buffer = buffer.slice(escIndex);
      }

      // buffer now starts with ESC.
      if (buffer.startsWith(PASTE_START)) {
        if (buffer.length === PASTE_START.length) {
          this.pending = buffer; // need more data to disambiguate
          return events;
        }
        const rest = buffer.slice(PASTE_START.length);
        const end = rest.indexOf(PASTE_END);
        if (end === -1) {
          this.pasting = true;
          if (rest) events.push({ key: KEYS.paste, text: rest });
          return events;
        }
        events.push({ key: KEYS.paste, text: rest.slice(0, end) });
        buffer = rest.slice(end + PASTE_END.length);
        continue;
      }

      if (buffer.length >= 2 && buffer[1] === '[') {
        // CSI: find the final byte in 0x40-0x7e.
        let end = 2;
        while (end < buffer.length) {
          const code = buffer.charCodeAt(end);
          if (code >= 0x40 && code <= 0x7e) break;
          end += 1;
        }
        if (end >= buffer.length) {
          this.pending = buffer; // incomplete, wait for the rest
          return events;
        }
        const final = buffer[end];
        const params = buffer.slice(2, end);
        const mapped = CSI_KEYS[final];
        if (final === '~') {
          const numeric = Number(params.split(';')[0]);
          const tildeKey =
            numeric === 1 || numeric === 7
              ? KEYS.home
              : numeric === 4 || numeric === 8
                ? KEYS.end
                : numeric === 3
                  ? KEYS.delete
                  : numeric === 5
                    ? KEYS.pageUp
                    : numeric === 6
                      ? KEYS.pageDown
                      : numeric === 2
                        ? KEYS.insert
                        : KEYS.unknown;
          events.push({ key: tildeKey });
        } else if (mapped) {
          events.push({ key: mapped });
        } else {
          events.push({ key: KEYS.unknown, text: buffer.slice(0, end + 1) });
        }
        buffer = buffer.slice(end + 1);
        continue;
      }

      if (buffer.length >= 2 && buffer[1] === 'O') {
        if (buffer.length < 3) {
          this.pending = buffer;
          return events;
        }
        const mapped = CSI_KEYS[buffer[2]];
        events.push({ key: mapped ?? KEYS.unknown, text: mapped ? undefined : buffer.slice(0, 3) });
        buffer = buffer.slice(3);
        continue;
      }

      if (buffer.length === 1) {
        this.pending = buffer; // lone ESC; could be the start of a longer seq
        return events;
      }

      // ESC + printable = Alt-ish chord; treat the pairing as a single key we
      // do not bind, so it cannot leak characters into the buffer.
      events.push({ key: KEYS.unknown, text: buffer.slice(0, 2) });
      buffer = buffer.slice(2);
    }

    return events;
  }
}

/**
 * Map decoded key events to high-level UI actions. Keeping this pure means the
 * editor behaviour can be asserted in tests without any stream plumbing.
 *
 * @param {string} key Key name from {@link KEYS}.
 * @param {{ busy?: boolean, suggestionOpen?: boolean, multiline?: boolean, atFirstLine?: boolean, atLastLine?: boolean }} [ctx]
 * @returns {string} Action name consumed by `App.act()`.
 */
export function actionForKey(key, ctx = {}) {
  switch (key) {
    case KEYS.enter:
      return ctx.suggestionOpen ? 'accept-suggestion' : 'submit';
    case KEYS.newline:
    case KEYS.ctrlJ:
      return 'newline';
    case KEYS.tab:
      return ctx.suggestionOpen ? 'accept-suggestion' : 'noop';
    case KEYS.up:
      if (ctx.suggestionOpen) return 'suggestion-prev';
      return ctx.atFirstLine ? 'history-prev' : 'caret-up';
    case KEYS.down:
      if (ctx.suggestionOpen) return 'suggestion-next';
      return ctx.atLastLine ? 'history-next' : 'caret-down';
    case KEYS.left:
      return 'caret-left';
    case KEYS.right:
      return 'caret-right';
    case KEYS.home:
    case KEYS.ctrlA:
      return 'caret-home';
    case KEYS.end:
    case KEYS.ctrlE:
      return 'caret-end';
    case KEYS.backspace:
      return 'backspace';
    case KEYS.delete:
      return 'delete';
    case KEYS.ctrlU:
      return 'kill-line-start';
    case KEYS.ctrlK:
      return 'kill-line-end';
    case KEYS.ctrlW:
      return 'kill-word';
    case KEYS.ctrlO:
      return 'toggle-fold';
    case KEYS.ctrlL:
      return 'clear-screen';
    case KEYS.ctrlC:
      return ctx.busy ? 'abort' : 'interrupt';
    case KEYS.ctrlD:
      return 'quit';
    case KEYS.escape:
      return ctx.suggestionOpen ? 'dismiss-suggestion' : 'noop';
    case KEYS.paste:
      return 'paste';
    case KEYS.text:
      return 'insert';
    default:
      return 'noop';
  }
}
