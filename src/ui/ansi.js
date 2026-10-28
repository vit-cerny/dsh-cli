/**
 * Minimal ANSI escape toolkit for the dsh-cli terminal UI (task T3).
 *
 * Zero dependencies by design: the RAM budget is the project's headline
 * constraint, so the UI layer must not pull in chalk / ora / ink / blessed.
 * Everything here is hand-written escape sequence construction plus one
 * well-understood regular expression for stripping.
 *
 * Colour policy (must be honoured everywhere in src/ui):
 *   - `NO_COLOR` (set to any non-empty value) wins  -> plain text
 *   - `FORCE_COLOR=0|false`                          -> plain text
 *   - `FORCE_COLOR=<anything else>`                  -> colour on
 *   - `TERM=dumb`, `CLICOLOR=0`                      -> plain text
 *   - otherwise                                      -> colour only on a TTY
 *
 * Cursor/erase helpers are *always exported* but the UI only writes them when
 * `ansi.interactive` is true, so piping `dsh-cli` into a file stays clean.
 *
 * @module src/ui/ansi
 */

import process from 'node:process';

export const ESC = '\u001b';
export const CSI = `${ESC}[`;
export const OSC = `${ESC}]`;
export const ST = `${ESC}\\`;
export const BEL = '\u0007';
export const RESET = `${CSI}0m`;

/** Erase entire current line (cursor column is preserved). */
export const CLEAR_LINE = `${CSI}2K`;

/**
 * Return to column 0 and erase the whole row — the sequence used to repaint a
 * single live line without touching the transcript above it.
 *
 * @returns {string} Erase-and-home sequence.
 */
export function clearLineSequence() {
  return `\r${CLEAR_LINE}`;
}

/** Erase from cursor to end of line. */
export const CLEAR_LINE_RIGHT = `${CSI}K`;
/** Erase from cursor to end of screen. */
export const ERASE_DOWN = `${CSI}J`;
/** Erase entire screen then home the cursor. */
export const CLEAR_SCREEN = `${CSI}2J${CSI}H`;
/** Move cursor to top-left. */
export const HOME = `${CSI}H`;

/** Clamp a repeat count to a positive integer. */
function count(n) {
  const value = Math.trunc(Number(n));
  return !Number.isFinite(value) || value < 1 ? 1 : value;
}

/** Cursor movement / positioning sequences (1-based, like the terminal). */
export const cursor = Object.freeze({
  up: (n = 1) => `${CSI}${count(n)}A`,
  down: (n = 1) => `${CSI}${count(n)}B`,
  right: (n = 1) => `${CSI}${count(n)}C`,
  left: (n = 1) => `${CSI}${count(n)}D`,
  nextLine: (n = 1) => `${CSI}${count(n)}E`,
  prevLine: (n = 1) => `${CSI}${count(n)}F`,
  column: (col = 1) => `${CSI}${count(col)}G`,
  to: (row = 1, col = 1) => `${CSI}${count(row)};${count(col)}H`,
  save: `${CSI}s`,
  restore: `${CSI}u`,
  hide: `${CSI}?25l`,
  show: `${CSI}?25h`,
  /** Carriage return only — cheap way back to column 0. */
  cr: '\r',
});

/** Erase sequences. */
export const erase = Object.freeze({
  line: CLEAR_LINE,
  lineRight: CLEAR_LINE_RIGHT,
  down: ERASE_DOWN,
  up: `${CSI}1J`,
  screen: `${CSI}2J`,
});

const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// The classic ANSI regex shape (covers CSI, SGR, and simple escapes).
const CSI_SEQUENCE =
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nqry=><~]))/g;

/**
 * Remove every ANSI/OSC escape sequence from a string.
 *
 * @param {unknown} value Any value; non-strings are coerced.
 * @returns {string} Visible text only.
 */
export function stripAnsi(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (!text) return '';
  return text.replace(OSC_SEQUENCE, '').replace(CSI_SEQUENCE, '');
}

/**
 * Decide whether the given stream should receive colour codes.
 *
 * @param {object|null|undefined} stream Stream to inspect (uses `isTTY`).
 * @param {Record<string, string|undefined>} [env] Environment to read.
 * @returns {boolean} True when ANSI colour is allowed.
 */
export function detectColor(stream, env = process.env) {
  if (!stream) return false;
  const force = env?.FORCE_COLOR;
  if (force !== undefined && force !== null && force !== '') {
    if (String(force) === '0') return false;
    if (String(force).toLowerCase() === 'false') return false;
    return true;
  }
  const noColor = env?.NO_COLOR;
  if (noColor !== undefined && noColor !== null && noColor !== '') return false;
  if (env?.TERM === 'dumb') return false;
  if (env?.CLICOLOR === '0') return false;
  return Boolean(stream.isTTY);
}

/**
 * Sanitise a URI so an OSC 8 hyperlink can never smuggle terminal control
 * characters (a well known injection vector).
 *
 * @param {unknown} url Candidate URL.
 * @returns {string|null} Sanitised URL or null when unusable.
 */
export function sanitizeUrl(url) {
  const text = String(url ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!/^https?:\/\//i.test(text)) return null;
  if (/\s/.test(text)) return null;
  return text;
}

/**
 * Build the ANSI façade for one output stream.
 *
 * @param {object} [options] Options.
 * @param {object} [options.stream] Output stream (defaults to `process.stdout`).
 * @param {Record<string, string|undefined>} [options.env] Environment source.
 * @param {boolean} [options.color] Force colour on/off, bypassing detection.
 */
export function createAnsi({ stream = process.stdout, env = process.env, color } = {}) {
  const enabled = typeof color === 'boolean' ? color : detectColor(stream, env);
  const interactive = Boolean(stream && stream.isTTY);

  /**
   * Wrap `text` in the given SGR codes. Returns the identity function when
   * colour is disabled or no codes are supplied.
   *
   * @param {...(number|number[])} codes SGR parameters.
   * @returns {(text: unknown) => string} Painter.
   */
  const style = (...codes) => {
    const flat = codes.flat().filter((code) => Number.isInteger(code));
    if (!enabled || flat.length === 0) return (text) => String(text ?? '');
    const open = `${CSI}${flat.join(';')}m`;
    return (text) => `${open}${text ?? ''}${RESET}`;
  };

  return {
    /** Colour enabled? */
    enabled,
    /** Attached to a terminal (cursor movement is safe)? */
    interactive,
    stream,
    style,
    sgr: style,
    /** 256-colour foreground painter. */
    fg256: (n) => style(38, 5, Number(n) || 0),
    /** 256-colour background painter. */
    bg256: (n) => style(48, 5, Number(n) || 0),
    /** Truecolor foreground painter. */
    rgb: (r, g, b) => style(38, 2, Number(r) || 0, Number(g) || 0, Number(b) || 0),
    /**
     * OSC 8 hyperlink; degrades to the label when colour is off or the URL is
     * not a plain http(s) URL.
     *
     * @param {unknown} url Target URL.
     * @param {unknown} label Visible text.
     * @returns {string} Link or plain label.
     */
    link(url, label) {
      const safe = enabled ? sanitizeUrl(url) : null;
      const text = String(label ?? url ?? '');
      if (!safe) return text;
      return `${OSC}8;;${safe}${ST}${text}${OSC}8;;${ST}`;
    },
    /** Current terminal width, clamped to something renderable. */
    width(fallback = 80) {
      const columns = Number(stream?.columns);
      if (!Number.isFinite(columns) || columns <= 0) return fallback;
      return Math.max(20, Math.min(400, Math.trunc(columns)));
    },
    cursor,
    erase,
  };
}
