import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionDriver } from '../src/session/driver.js';
import { runOnce } from '../src/cli/run.js';

function makeDriver(options = {}) {
  const client = {
    onNotification(handler) { this.notification = handler; return () => {}; },
    onError() { return () => {}; },
    prompt: async () => ({ messageId: 'message-1' }),
    wait: async () => {},
    abort: async () => {},
    resume: async () => {},
    close: async () => {},
    shutdown: async () => {},
  };
  const driver = new SessionDriver({
    client,
    sessionId: 'test-session',
    maxEvents: 100,
    maxTranscriptEntries: options.maxTranscriptEntries ?? 3,
    maxTranscriptChars: options.maxTranscriptChars ?? 100,
  });
  // Drive raw SDK notifications through the public notification callback.
  const event = (type, data = {}) => {
    client.notification('session.event', {
      sessionId: 'test-session',
      event: { type, seq: data.seq ?? 1, data },
    });
  };
  return { driver, event, client };
}

test('driver retains bounded display transcript while listeners receive full streamed assistant text', () => {
  const { driver, event } = makeDriver({ maxTranscriptEntries: 2, maxTranscriptChars: 5 });
  const streamed = [];
  driver.on('assistant-text', (item) => streamed.push(item.text));
  event('user/message', { message: { id: 'u1', content: [{ type: 'text', text: 'prompt' }] }, turn: 1 });
  event('assistant/message', { message: { id: 'a1', content: [{ type: 'text', text: '123456789' }] }, turn: 1 });
  assert.deepEqual(streamed, ['123456789']);
  assert.ok(driver.transcript.length <= 2);
  assert.ok(driver.transcript.reduce((n, row) => n + row.text.length + row.reasoning.length, 0) <= 5);
  assert.equal(driver.lastAssistantText, '56789');
});

test('a new turn does not inherit the previous turn terminal state', async () => {
  const { driver, event, client } = makeDriver();
  await driver.send('first prompt');
  event('turn/start', { turn: 1, seq: 1 });
  client.notification('session.status', { sessionId: 'test-session', status: 'idle' });
  event('turn/end', { turn: 1, seq: 2, reason: { kind: 'completed' } });
  assert.equal((await driver.waitIdle()).completed, true);

  await driver.send('second prompt');
  const pending = driver.waitIdle({ timeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  event('turn/start', { turn: 2, seq: 3 });
  event('assistant/message', {
    turn: 2,
    seq: 4,
    message: { content: [{ type: 'text', text: 'second answer' }] },
  });
  event('turn/end', { turn: 2, seq: 5, reason: { kind: 'completed' } });
  assert.equal((await pending).text, 'second answer');
});

test('runOnce writes the entire one-shot assistant stream to stdout', async () => {
  const chunks = [];
  const driver = {
    on(name, callback) { this[name] = callback; },
    async send() {
      this['assistant-text']({ text: 'first chunk' });
      this['assistant-text']({ text: ' second chunk' });
    },
    async waitIdle() { return { completed: true, reason: { kind: 'completed' }, text: '' }; },
    async close() {},
  };
  const code = await runOnce({ cwd: process.cwd(), provider: 'p', model: 'm', runtimeBin: 'node', runtimeArgs: [] }, 'prompt', {
    stdout: { write(chunk) { chunks.push(String(chunk)); return true; } },
    stderr: { write() { return true; } },
    driverFactory: async () => driver,
  });
  assert.equal(code, 0);
  assert.equal(chunks.join(''), 'first chunk second chunk\n');
});

test('runOnce streams to stdout before the turn settles (no full-response buffer)', async () => {
  const chunks = [];
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const driver = {
    on(name, callback) { this[name] = callback; },
    async send() {
      this['assistant-text']({ text: 'a'.repeat(4096) });
    },
    waitIdle() { return idle; },
    async close() {},
  };
  const done = runOnce({ cwd: process.cwd(), provider: 'p', model: 'm', runtimeBin: 'node', runtimeArgs: [] }, 'prompt', {
    stdout: { write(chunk) { chunks.push(String(chunk)); return true; } },
    stderr: { write() { return true; } },
    driverFactory: async () => driver,
  });
  // The first chunk must already be out while waitIdle is still pending.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chunks.join(''), 'a'.repeat(4096));
  resolveIdle({ completed: true, reason: { kind: 'completed' }, text: '' });
  assert.equal(await done, 0);
  assert.equal(chunks.join(''), `${'a'.repeat(4096)}\n`);
});

test('runOnce falls back to the summary text when nothing streamed', async () => {
  const chunks = [];
  const driver = {
    on(name, callback) { this[name] = callback; },
    async send() {},
    async waitIdle() { return { completed: true, reason: { kind: 'completed' }, text: 'tail text  ' }; },
    async close() {},
  };
  const code = await runOnce({ cwd: process.cwd(), provider: 'p', model: 'm', runtimeBin: 'node', runtimeArgs: [] }, 'prompt', {
    stdout: { write(chunk) { chunks.push(String(chunk)); return true; } },
    stderr: { write() { return true; } },
    driverFactory: async () => driver,
  });
  assert.equal(code, 0);
  assert.equal(chunks.join(''), 'tail text\n');
});

test('entry-count eviction does not alter the DSH-facing event stream', () => {
  const { driver, event } = makeDriver({ maxTranscriptEntries: 2, maxTranscriptChars: 100 });
  const observed = [];
  driver.on('event', (item) => observed.push(item.kind));
  event('user/message', { message: { content: [{ type: 'text', text: 'one' }] }, turn: 1 });
  event('assistant/message', { message: { content: [{ type: 'text', text: 'answer' }] }, turn: 1 });
  event('user/message', { message: { content: [{ type: 'text', text: 'two' }] }, turn: 2 });
  assert.ok(driver.transcript.length <= 2);
  assert.equal(observed.filter((kind) => kind === 'user').length, 2);
  assert.equal(observed.filter((kind) => kind === 'assistant-text').length, 1);
});
