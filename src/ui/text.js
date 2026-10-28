/**
 * Pure text/width helpers shared by the renderer and the input line editor.
 *
 * These functions are deliberately free of I/O and of ANSI *generation*, which
 * keeps them trivially testable under `node --test` (no TTY required).
 *
 * Note: functions that measure (`displayWidth`) tolerate ANSI input, while
 * functions that rewrite (`truncateToWidth`, `wrapText`) expect plain text —
 * the caller styles the finished lines. That keeps colour handling in exactly
 * one place (`theme.js`) instead of tangled into the wrapping logic.
 *
 * @module src/ui/text
 */

import { stripAnsi } from './ansi.js';

const ZERO_WIDTH = new Set([
  0x200b,
  0x200c,
  0x200d,
  0x2060,
  0xfeff,
]);

/**
 * East-Asian-width-ish test for double-width code points. Not a full Unicode
 * table, but covers CJK, Hangul, fullwidth forms and emoji — the cases that
 * actually break terminal layouts.
 *
 * @param {number} cp Code point.
 * @returns {boolean} True when the glyph occupies two columns.
 */
function isWide(cp) {
  if (cp < 0x1100) return false;
  return (
    cp <= 0x115f || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK radicals .. Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * Combining marks and variation selectors take no column.
 *
 * @param {number} cp Code point.
 * @returns {boolean} True when zero-width.
 */
function isCombining(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20f0) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff)
  );
}

/**
 * Display width of a single character.
 *
 * @param {string} ch One code point (surrogate pairs allowed).
 * @returns {number} 0, 1 or 2 columns.
 */
export function charWidth(ch) {
  if (!ch) return 0;
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (ZERO_WIDTH.has(cp)) return 0;
  if (isCombining(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

/**
 * Visible width of a string, ignoring ANSI escapes.
 *
 * @param {unknown} value Text (may contain ANSI).
 * @returns {number} Column count.
 */
export function displayWidth(value) {
  const text = stripAnsi(value === null || value === undefined ? '' : value);
  let total = 0;
  for (const ch of text) total += charWidth(ch);
  return total;
}

/**
 * Hard-cut plain text to a column budget, appending an ellipsis when cut.
 *
 * @param {unknown} value Plain text.
 * @param {number} width Column budget.
 * @param {string} [ellipsis] Marker appended on truncation.
 * @returns {string} Truncated text.
 */
export function truncateToWidth(value, width, ellipsis = '…') {
  const text = String(value ?? '');
  const limit = Math.max(0, Math.floor(Number(width) || 0));
  if (displayWidth(text) <= limit) return text;
  const marker = displayWidth(ellipsis) <= limit ? ellipsis : '';
  const budget = Math.max(0, limit - displayWidth(marker));
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return out + marker;
}

/**
 * Pad plain text with spaces up to a column budget (never truncates).
 *
 * @param {unknown} value Plain text.
 * @param {number} width Target columns.
 * @returns {string} Padded text.
 */
export function padToWidth(value, width) {
  const text = String(value ?? '');
  const deficit = Math.floor(Number(width) || 0) - displayWidth(text);
  return deficit > 0 ? text + ' '.repeat(deficit) : text;
}

/**
 * Word-wrap plain text, honouring explicit newlines and hard-splitting tokens
 * that cannot fit on a line at all.
 *
 * @param {unknown} value Plain text.
 * @param {number} width Column budget per line.
 * @param {{ tabs?: number }} [options] Options (`tabs` expands to spaces).
 * @returns {string[]} Wrapped lines (never empty for non-empty input).
 */
export function wrapText(value, width, { tabs = 4 } = {}) {
  const limit = Math.max(1, Math.floor(Number(width) || 1));
  const spaces = ' '.repeat(Math.max(0, Math.trunc(tabs)));
  const source = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, spaces);
  const lines = [];

  for (const logical of source.split('\n')) {
    if (displayWidth(logical) <= limit) {
      lines.push(logical);
      continue;
    }
    let line = '';
    let used = 0;
    let lastSpace = -1;
    for (const ch of logical) {
      const w = charWidth(ch);
      if (used + w > limit) {
        if (lastSpace > 0) {
          lines.push(line.slice(0, lastSpace));
          line = line.slice(lastSpace + 1);
          used = displayWidth(line);
          lastSpace = -1;
          if (used + w > limit) {
            lines.push(line);
            line = '';
            used = 0;
          }
        } else {
          lines.push(line);
          line = '';
          used = 0;
        }
      }
      line += ch;
      used += w;
      if (ch === ' ') lastSpace = line.length - 1;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Split a list into the visible head plus a hidden remainder count.
 *
 * @param {string[]} lines Lines to fold.
 * @param {number} [max] Lines kept visible (default 8, per the T3 spec).
 * @returns {{ lines: string[], hidden: number }} Fold result.
 */
export function foldLines(lines, max = 8) {
  const list = Array.isArray(lines) ? lines : [];
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  if (list.length <= limit) return { lines: list.slice(), hidden: 0 };
  return { lines: list.slice(0, limit), hidden: list.length - limit };
}

/**
 * Prefix every line with `prefix` (first line can use a different one).
 *
 * @param {string[]} lines Lines.
 * @param {string} prefix Prefix for continuation lines.
 * @param {string} [first] Prefix for the first line.
 * @returns {string[]} Prefixed lines.
 */
export function indentLines(lines, prefix, first = prefix) {
  return (Array.isArray(lines) ? lines : []).map((line, index) =>
    `${index === 0 ? first : prefix}${line}`,
  );
}

/**
 * Human-friendly duration for the status line.
 *
 * @param {number} ms Milliseconds.
 * @returns {string} e.g. `0.4s`, `1.2s`, `2m03s`.
 */
export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '0s';
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m${String(rest).padStart(2, '0')}s`;
}
