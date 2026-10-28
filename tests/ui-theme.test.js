import assert from 'node:assert/strict';
import test from 'node:test';

import { createTheme, wantsNoDim } from '../src/ui/theme.js';

/** A TTY-shaped stream so colour detection has something to say yes to. */
function tty() {
  return { isTTY: true, columns: 80 };
}

const COLOR = { FORCE_COLOR: '1' };

test('DSH_CLI_NO_DIM drops the dim attribute so secondary text keeps contrast', () => {
  const dimmed = createTheme({ color: true, stream: tty(), env: COLOR });
  const plain = createTheme({ color: true, stream: tty(), env: { ...COLOR, DSH_CLI_NO_DIM: '1' } });

  // SGR 2 fades by an amount the terminal decides, which can fall under 4.5:1
  // on a light background. The opt-out must remove the code, not re-tint it.
  assert.match(dimmed.style.muted('cost unknown'), /\u001b\[2m/);
  assert.equal(plain.style.muted('cost unknown'), 'cost unknown');
  assert.equal(plain.style.status('idle'), 'idle');
  assert.equal(plain.style.dim('x'), 'x');
});

test('suppressing dim keeps other emphasis intact', () => {
  const plain = createTheme({ color: true, stream: tty(), env: { ...COLOR, DSH_CLI_NO_DIM: '1' } });
  // Reasoning stays visually distinct through italics alone.
  assert.match(plain.style.reasoning('thinking'), /\u001b\[3m/);
  assert.doesNotMatch(plain.style.reasoning('thinking'), /\u001b\[2m/);
  // Bold is unaffected: it is not a contrast reducer.
  assert.match(plain.style.bold('important'), /\u001b\[1m/);
});

test('wantsNoDim accepts the usual spellings and defaults to off', () => {
  assert.equal(wantsNoDim({}), false);
  assert.equal(wantsNoDim({ DSH_CLI_NO_DIM: '' }), false);
  for (const on of ['1', 'true', 'yes', 'on', 'TRUE']) {
    assert.equal(wantsNoDim({ DSH_CLI_NO_DIM: on }), true, `${on} should enable`);
  }
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(wantsNoDim({ DSH_CLI_NO_DIM: off }), false, `${off} should disable`);
  }
});

test('colour-off output is byte-identical with and without the dim opt-out', () => {
  // With no colour at all there is no attribute to drop, so the two modes must
  // agree; otherwise a piped log would differ by environment variable.
  const a = createTheme({ color: false, stream: tty(), env: {} });
  const b = createTheme({ color: false, stream: tty(), env: { DSH_CLI_NO_DIM: '1' } });
  for (const style of ['muted', 'status', 'reasoning', 'ok', 'error']) {
    assert.equal(a.style[style]('text'), b.style[style]('text'), `${style} differs`);
  }
});