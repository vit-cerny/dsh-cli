import assert from 'node:assert/strict';
import test from 'node:test';

import { actionForKey, KEYS, KeyDecoder } from '../src/ui/keymap.js';

test('DEL (0x7F) decodes as backspace, not literal text', () => {
  // Every terminal sends 0x7F for Backspace. It is not below 0x20, so a decoder
  // that only checks that range inserts an invisible character instead and the
  // visible prompt never shrinks — the reported "backspace is broken" bug.
  assert.deepEqual(new KeyDecoder().decode('\u007f').map((event) => event.key), [KEYS.backspace]);
  assert.deepEqual(new KeyDecoder().decode('hello\u007f').map((event) => event.key), [
    KEYS.text,
    KEYS.backspace,
  ]);
  // Ctrl+H is the other byte some terminals send for the same key.
  assert.deepEqual(new KeyDecoder().decode('\u0008').map((event) => event.key), [KEYS.backspace]);
});

test('a chunk mixing text and DEL splits into ordered events', () => {
  const events = new KeyDecoder().decode('ab\u007fcd\u007f');
  assert.deepEqual(events.map((event) => event.key), [
    KEYS.text,
    KEYS.backspace,
    KEYS.text,
    KEYS.backspace,
  ]);
  assert.equal(events[0].text, 'ab');
  assert.equal(events[2].text, 'cd');
});

test('Enter submits even when the slash-command menu is open', () => {
  // Typing `/help` opens the completion menu. If Enter accepted the suggestion
  // the command would be re-inserted as text and never run — the exact bug that
  // made /help produce no output in a real PTY.
  assert.equal(actionForKey(KEYS.enter, { suggestionOpen: true }), 'submit');
  assert.equal(actionForKey(KEYS.enter, { suggestionOpen: false }), 'submit');
  assert.equal(actionForKey(KEYS.enter, {}), 'submit');
});

test('Tab accepts the suggestion, and moves the toolbar without one', () => {
  assert.equal(actionForKey(KEYS.tab, { suggestionOpen: true }), 'accept-suggestion');
  // With no menu open, Tab is the only way to reach the top toolbar tabs.
  assert.equal(actionForKey(KEYS.tab, { suggestionOpen: false }), 'toolbar-next');
});

test('arrow keys navigate the menu before they move the caret', () => {
  assert.equal(actionForKey(KEYS.up, { suggestionOpen: true }), 'suggestion-prev');
  assert.equal(actionForKey(KEYS.down, { suggestionOpen: true }), 'suggestion-next');
  assert.equal(actionForKey(KEYS.up, { suggestionOpen: false, atFirstLine: true }), 'history-prev');
});

test('Ctrl+J inserts a newline instead of submitting', () => {
  assert.equal(actionForKey(KEYS.ctrlJ, { suggestionOpen: true }), 'newline');
});

test('a lone Escape is flushed, so Escape can close a menu', () => {
  // A terminal sends a bare ESC as one byte with nothing after it. The decoder
  // holds it waiting for a possible `[A`-style continuation, so without an
  // explicit flush Escape never arrives and nothing can be dismissed with it.
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.decode('\u001b'), []);
  assert.deepEqual(decoder.flush().map((event) => event.key), [KEYS.escape]);
  // Flushing twice must not synthesize a second Escape.
  assert.deepEqual(decoder.flush(), []);
});

test('a real sequence is never mistaken for a lone Escape', () => {
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.decode('\u001b[B').map((event) => event.key), [KEYS.down]);
  assert.deepEqual(decoder.flush(), []);
});
