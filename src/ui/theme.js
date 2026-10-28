/**
 * Colour/style palette and the small glyph vocabulary of the TUI.
 *
 * Two rules shape this file:
 *   1. Everything goes through `ansi.style`, so a single `NO_COLOR`/TTY verdict
 *      governs the whole UI — no component decides for itself.
 *   2. Every glyph has an ASCII fallback, because a Windows code page that is
 *      not UTF-8 would otherwise render `●` as `?` garbage.
 *
 * @module src/ui/theme
 */

import { createAnsi } from './ansi.js';

/** Named SGR codes used by the palette. */
const SGR = Object.freeze({
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  inverse: 7,
});

/**
 * Build a palette bound to one output stream.
 *
 * @param {{ color?: boolean, stream?: object, env?: Record<string, string|undefined> }} [options]
 * @returns {{ ansi: ReturnType<typeof createAnsi>, color: boolean, glyph: Record<string, string>, style: Record<string, (text: unknown) => string> }}
 */
export function createTheme({ color, stream, env } = {}) {
  const ansi = createAnsi({ color, stream, env });
  const s = ansi.style;

  const style = {
    reset: (text) => String(text ?? ''),
    dim: s(SGR.dim),
    bold: s(SGR.bold),
    italic: s(SGR.italic),
    underline: s(SGR.underline),
    inverse: s(SGR.inverse),
    /** Assistant prose. */
    assistant: (text) => String(text ?? ''),
    /** Chain-of-thought; dim + italic so it recedes. */
    reasoning: (text) => `${s(SGR.dim)(s(SGR.italic)(String(text ?? '')))}`,
    /** Tool name inside a card. */
    tool: s(SGR.bold),
    /** A human turn. */
    user: s(SGR.bold),
    ok: s(32),
    warn: s(33),
    error: s(31),
    info: s(36),
    accent: s(35),
    muted: (text) => `${s(SGR.dim)(String(text ?? ''))}`,
    /** `● Bash(cmd)` line. */
    running: (text) => `${s(33)(String(text ?? ''))}`,
    success: (text) => `${s(32)(String(text ?? ''))}`,
    failure: (text) => `${s(31)(String(text ?? ''))}`,
    /** Status line: dim background-ish treatment via inverse-free dim. */
    status: (text) => `${s(SGR.dim)(String(text ?? ''))}`,
    statusValue: s(SGR.bold),
    /** Highlighted row in the completion menu / selected history entry. */
    selected: (text) => `${s(SGR.inverse)(String(text ?? ''))}`,
  };

  const glyph = {
    filled: '●',
    hollow: '○',
    cross: '✗',
    arrow: '❯',
    bullet: '·',
    rule: '─',
    ellipsis: '…',
    foldHint: '⋯',
    prompt: '>',
    check: '✓',
    warn: '!',
  };

  return { ansi, color: ansi.enabled, glyph, style };
}

/**
 * Status → glyph + style mapping for tool cards.
 *
 * @param {string} status One of `running` | `success` | `error` | `cancelled`.
 * @returns {{ glyph: string, style: (text: unknown) => string, label: string }}
 */
export function toolStatusVisual(theme, status) {
  switch (status) {
    case 'success':
      return { glyph: theme.glyph.filled, style: theme.style.success, label: 'ok' };
    case 'error':
      return { glyph: theme.glyph.cross, style: theme.style.failure, label: 'failed' };
    case 'cancelled':
      return { glyph: theme.glyph.hollow, style: theme.style.muted, label: 'cancelled' };
    case 'running':
    default:
      return { glyph: theme.glyph.hollow, style: theme.style.running, label: 'running' };
  }
}
