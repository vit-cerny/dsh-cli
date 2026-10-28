/**
 * Public surface of the dsh-cli terminal UI (task T3).
 *
 * Nothing above `src/main.js` should import the individual modules: keeping one
 * barrel makes the T8 wiring (and any future renderer swap) a one-line change.
 *
 * @module src/ui
 */

export {
  BEL,
  CLEAR_LINE,
  CLEAR_SCREEN,
  CSI,
  ERASE_DOWN,
  ESC,
  HOME,
  OSC,
  RESET,
  ST,
  clearLineSequence,
  createAnsi,
  cursor,
  detectColor,
  erase,
  sanitizeUrl,
  stripAnsi,
} from './ansi.js';

export {
  charWidth,
  displayWidth,
  foldLines,
  formatDuration,
  indentLines,
  padToWidth,
  truncateToWidth,
  wrapText,
} from './text.js';

export { createTheme, toolStatusVisual } from './theme.js';
export { Editor, createState } from './editor.js';
export { KeyDecoder, KEYS, actionForKey } from './keymap.js';
export {
  FOLD_LINES,
  Renderer,
  shortenPath,
  summarizeToolInput,
} from './renderer.js';
export {
  CommandRegistry,
  KEY_BINDINGS,
  createCommandRegistry,
  parseCommand,
} from './commands.js';
export { InputController, caretWindow, promptLines } from './input.js';
export { App, runApp, subscribeDriver } from './app.js';
export { PICKER_ROWS, Toolbar, renderSessionPicker } from './toolbar.js';
