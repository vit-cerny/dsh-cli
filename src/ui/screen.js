/**
 * Box drawing for the full-screen TUI.
 *
 * The interactive UI composes a whole frame and addresses it absolutely, so the
 * only drawing primitive it needs is the rounded input box — the rest of the
 * frame is plain rows. Keeping this separate from `fullscreen.js` lets the
 * geometry be unit-tested without a stream.
 *
 * @module src/ui/screen
 */

import { displayWidth, truncateToWidth } from './text.js';

/**
 * Compose a bordered box around a block of content lines.
 *
 * Uses the same rounded corners opencode uses, so the input reads as a distinct
 * surface rather than another line of transcript.
 *
 * @param {object} options Options.
 * @param {string[]} options.lines Content rows (already styled).
 * @param {number} options.width Total box width including both borders.
 * @param {string} [options.title] Optional label drawn into the top border.
 * @param {(text: string) => string} [options.border] Border painter.
 * @param {(text: string) => string} [options.titleStyle] Title painter.
 * @returns {string[]} Box rows, top border first.
 */
export function boxed({ lines, width, title = '', border = (text) => text, titleStyle = (text) => text }) {
  const total = Math.max(8, Math.trunc(width) || 8);
  const inner = total - 4; // "│ " + content + " │"
  const body = lines.length > 0 ? lines : [''];
  const rows = [];

  if (title === '') {
    rows.push(border(`╭${'─'.repeat(total - 2)}╮`));
  } else {
    const label = truncateToWidth(` ${title} `, Math.max(1, total - 4));
    const used = displayWidth(label);
    const rest = Math.max(0, total - 2 - used - 1);
    rows.push(`${border('╭─')}${titleStyle(label)}${border(`${'─'.repeat(rest)}╮`)}`);
  }

  for (const line of body) {
    const fitted = truncateToWidth(line, inner);
    const padding = Math.max(0, inner - displayWidth(fitted));
    rows.push(`${border('│')} ${fitted}${' '.repeat(padding)} ${border('│')}`);
  }
  rows.push(border(`╰${'─'.repeat(total - 2)}╯`));
  return rows;
}