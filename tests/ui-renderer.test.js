/**
 * T3 renderer tests — requirement (1), (2), (3) and the NO_COLOR guarantee.
 *
 * Every assertion reads the *captured stream*, never the terminal, and every
 * ANSI assertion is paired with a plain-text assertion so a style regression
 * cannot hide behind an escape code.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FOLD_LINES, Renderer, shortenPath, summarizeToolInput } from '../src/ui/renderer.js';
import { stripAnsi } from '../src/ui/ansi.js';
import { FakeStream, colorStream } from './ui-helpers.js';

/** Build a renderer writing to a fake sink. */
function makeRenderer(options = {}) {
  const stdout = options.stdout ?? new FakeStream({ isTTY: false, columns: 80 });
  const renderer = new Renderer({ stdout, color: options.color ?? false, ...options });
  return { renderer, stdout };
}

test('(1) assistant-text event renders the text', () => {
  const { renderer, stdout } = makeRenderer();
  renderer.handle({ kind: 'turn-start', turn: 1 });
  renderer.handle({ kind: 'assistant-text', text: 'Hello' });
  renderer.handle({ kind: 'assistant-text', text: ', world' });
  renderer.handle({ kind: 'turn-end', turn: 1, reason: { kind: 'completed' } });

  const text = stdout.text;
  assert.match(text, /Hello, world/);
  // Streaming must append, not prefix each delta with a marker or newline.
  assert.ok(text.includes('Hello, world'), 'deltas are concatenated in place');
});

test('(1b) multiple assistant-text deltas stay on one line until a newline arrives', () => {
  const { renderer, stdout } = makeRenderer();
  for (const chunk of ['a', 'b', 'c', 'd']) {
    renderer.handle({ kind: 'assistant-text', text: chunk });
  }
  assert.equal(stdout.text.trimEnd(), 'abcd');
});

test('(2) tool-call → tool-result transitions from running to success', () => {
  const stdout = new FakeStream({ isTTY: false, columns: 80 });
  const renderer = new Renderer({ stdout, color: false });

  renderer.handle({ kind: 'tool-call', tool: 'Bash', input: { command: 'npm test' } });
  const runningCard = renderer.tools.at(-1);
  assert.equal(runningCard.status, 'running');
  assert.match(stdout.text, /Bash\(npm test\)/);

  renderer.handle({ kind: 'tool-result', tool: 'Bash', output: 'ok 1 test', isError: false });
  const doneCard = renderer.tools.at(-1);
  assert.equal(doneCard.status, 'success');
  assert.equal(doneCard.isError, false);
  const text = stdout.text;
  // The card is re-printed with the resolved status; the body follows it.
  assert.match(text, /Bash\(npm test\)/);
  assert.match(text, /ok 1 test/);
  assert.ok(text.includes('✓'), 'success glyph present');
});

test('(2a) normalized tool arguments and result text are rendered', () => {
  const { renderer, stdout } = makeRenderer();
  renderer.handle({ kind: 'tool-call', name: 'Read', callId: 'call-1', arguments: { path: 'a.js' } });
  renderer.handle({ kind: 'tool-result', callId: 'call-1', name: 'Read', text: 'file contents' });

  assert.match(stdout.text, /Read\(a\.js\)/);
  assert.match(stdout.text, /file contents/);
});

test('(2b) failing tool-result is marked failed and coloured red when colour is on', () => {
  const stdout = colorStream({ columns: 80 });
  const renderer = new Renderer({ stdout, color: true });

  renderer.handle({ kind: 'tool-call', tool: 'Read', input: { file_path: '/nope/missing.txt' } });
  renderer.handle({
    kind: 'tool-result',
    tool: 'Read',
    output: 'ENOENT: no such file',
    isError: true,
  });

  const card = renderer.tools.at(-1);
  assert.equal(card.status, 'error');
  assert.equal(card.isError, true);

  const raw = stdout.raw;
  assert.ok(raw.includes('\u001b['), 'colour enabled produces SGR codes');
  // 31 = red foreground; the failure branch paints with it.
  assert.match(raw, /\u001b\[31m/, 'failure rendered with red SGR');
  assert.match(stripAnsi(raw), /failed/);
  assert.match(stripAnsi(raw), /ENOENT: no such file/);
});

test('(2c) a tool-result with no matching call still renders without throwing', () => {
  const { renderer, stdout } = makeRenderer();
  assert.doesNotThrow(() =>
    renderer.handle({ kind: 'tool-result', tool: 'Grep', output: 'result', isError: false }),
  );
  assert.match(stdout.text, /Grep/);
  assert.match(stdout.text, /result/);
});

test('(3) long tool output is folded to 8 lines by default', () => {
  const { renderer, stdout } = makeRenderer();
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

  renderer.handle({ kind: 'tool-call', tool: 'Bash', input: { command: 'seq 20' } });
  renderer.handle({ kind: 'tool-result', tool: 'Bash', output: lines.join('\n'), isError: false });

  const text = stdout.text;
  assert.equal(FOLD_LINES, 8, 'spec default is 8 visible lines');
  assert.match(text, /line 8\b/, '8th line is visible');
  assert.doesNotMatch(text, /line 9\b/, '9th line is folded away');
  assert.match(text, /12 more lines/);
  assert.match(text, /Ctrl\+O/);
});

test('(3b) Ctrl+O expansion shows every line and reports the collapsed size', () => {
  const { renderer, stdout } = makeRenderer();
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

  renderer.handle({ kind: 'tool-call', tool: 'Bash', input: { command: 'seq 20' } });
  renderer.handle({ kind: 'tool-result', tool: 'Bash', output: lines.join('\n'), isError: false });
  assert.equal(renderer.folds.expanded, false);

  const expanded = renderer.toggleFold();
  assert.equal(expanded, true);
  renderer.renderToolBody(renderer.tools.at(-1));

  const text = stdout.text;
  assert.match(text, /line 9\b/);
  assert.match(text, /line 20\b/);
});

test('(3c) short output is not folded and gets no fold hint', () => {
  const { renderer, stdout } = makeRenderer();
  renderer.handle({ kind: 'tool-call', tool: 'Bash', input: { command: 'echo hi' } });
  renderer.handle({ kind: 'tool-result', tool: 'Bash', output: 'hi', isError: false });
  assert.match(stdout.text, /hi/);
  assert.doesNotMatch(stdout.text, /Ctrl\+O/);
});

test('(5) NO_COLOR=1 / non-TTY output contains no ANSI escapes at all', () => {
  const stdout = new FakeStream({ isTTY: true, columns: 80 });
  const renderer = new Renderer({ stdout, env: { NO_COLOR: '1' }, color: undefined });

  renderer.banner({ version: '0.0.1', model: 'deepseek-v4.1-flash' });
  renderer.handle({ kind: 'turn-start', turn: 1 });
  renderer.handle({ kind: 'assistant-text', text: 'plain text only' });
  renderer.handle({ kind: 'tool-call', tool: 'Bash', input: { command: 'ls' } });
  renderer.handle({ kind: 'tool-result', tool: 'Bash', output: 'file.txt', isError: true });
  renderer.handle({ kind: 'turn-end', turn: 1 });
  renderer.statusLine();

  const raw = stdout.raw;
  assert.equal(raw.includes('\u001b'), false, 'no ESC byte anywhere');
  assert.equal(stripAnsi(raw), raw, 'stripAnsi is a no-op on plain output');
  assert.match(raw, /plain text only/);
});

test('(5b) a non-TTY stream disables colour even without NO_COLOR', () => {
  const stdout = new FakeStream({ isTTY: false, columns: 80 });
  const renderer = new Renderer({ stdout, env: {} });
  assert.equal(renderer.colorEnabled, false);
  renderer.handle({ kind: 'assistant-text', text: 'x' });
  assert.equal(stdout.raw.includes('\u001b'), false);
});

test('width adaptation + resize handling', () => {
  const stdout = new FakeStream({ isTTY: true, columns: 50 });
  const renderer = new Renderer({ stdout, color: false });
  assert.equal(renderer.columns, 50);
  stdout.columns = 100;
  assert.equal(renderer.columns, 100, 'reads columns live');

  let reported = 0;
  renderer.watchResize((columns) => {
    reported = columns;
  });
  stdout.columns = 73;
  // FakeStream.on() is inert, so invoke through the exposed handler directly to
  // assert the plumbing rather than the EventEmitter.
  renderer.onWidthChange(73);
  assert.equal(reported, 73);
  assert.equal(typeof renderer._resizeHandler, 'undefined' === 'undefined' ? 'function' : 'x');
});

test('very wide CJK lines wrap without exceeding the width', () => {
  const { renderer, stdout } = makeRenderer({ columns: 40 });
  renderer.handle({ kind: 'tool-call', tool: 'Bash', input: { command: 'echo cjk' } });
  renderer.handle({
    kind: 'tool-result',
    tool: 'Bash',
    output: '这是一个很长的中文输出行，用来验证宽度计算是否正确。',
    isError: false,
  });
  for (const line of stdout.text.split('\n')) {
    assert.ok(displayWidthOf(line) <= 40, `line within width: ${line}`);
  }
});

/** Local width helper so the test does not import the module under test twice. */
function displayWidthOf(line) {
  let width = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    width += cp >= 0x2e80 && cp <= 0xa4cf ? 2 : 1;
  }
  return width;
}

test('summarizeToolInput prefers the meaningful field', () => {
  assert.equal(summarizeToolInput({ command: 'npm  test' }), 'npm test');
  assert.equal(summarizeToolInput({ file_path: 'a.js', content: 'x' }), 'a.js');
  assert.equal(summarizeToolInput('raw string'), 'raw string');
  assert.equal(summarizeToolInput(null), '');
});

test('shortenPath elides the middle of absolute paths', () => {
  assert.equal(shortenPath('C:\\a\\b', 40), 'C:\\a\\b');
  const short = shortenPath('C:/Users/example/dsh-cli/src/ui/renderer.js', 24);
  assert.ok(short.length <= 24);
  assert.ok(short.includes('…'));
});

test('the echoed system prompt is hidden unless explicitly requested', () => {
  const hidden = makeRenderer();
  hidden.renderer.handle({ kind: 'system', text: 'x'.repeat(5000) });
  assert.equal(hidden.stdout.text, '');

  const shown = makeRenderer({ env: { DSH_CLI_SHOW_SYSTEM: '1' } });
  shown.renderer.handle({ kind: 'system', text: 'x'.repeat(5000) });
  assert.match(shown.stdout.text, /system prompt \(5000 chars\)/);
});

test('a short system notice still renders', () => {
  const { renderer, stdout } = makeRenderer();
  renderer.handle({ kind: 'system', text: 'compaction finished' });
  assert.match(stdout.text, /compaction finished/);
});

test('chain-of-thought prints by default and can be muted', () => {
  // Watching the agent reason is how a slow turn is told from a stuck one, so
  // reasoning prints unless it is explicitly turned off.
  const { renderer, stdout } = makeRenderer();
  renderer.handle({ kind: 'assistant-reasoning', text: 'private thinking' });
  renderer.handle({ kind: 'assistant-text', text: 'answer' });
  assert.match(stdout.text, /private thinking/);
  assert.match(stdout.text, /answer/);

  const hidden = makeRenderer({ env: { DSH_CLI_REASONING: '0' } });
  hidden.renderer.handle({ kind: 'assistant-reasoning', text: 'hidden thinking' });
  hidden.renderer.handle({ kind: 'assistant-text', text: 'still answered' });
  assert.doesNotMatch(hidden.stdout.text, /hidden thinking/);
  assert.match(hidden.stdout.text, /still answered/);
});

test('one tool call reported twice renders a single card', () => {
  const { renderer, stdout } = makeRenderer();
  renderer.handle({ kind: 'tool-call', callId: 'call-1', name: 'read', arguments: { file_path: 'a.js' } });
  renderer.handle({ kind: 'tool-call', callId: 'call-1', name: 'read', arguments: { file_path: 'a.js' } });
  assert.equal(renderer.tools.length, 1);
  assert.equal(stdout.text.split('read(').length - 1, 1);
});
