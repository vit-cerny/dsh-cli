import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import { findSessionFile, readSessionHistory } from '../src/cli/store.js';

function frame(events) {
  return zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`));
}

test('resume history reads appended zstd frames and ignores injected reminders', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-history-'));
  try {
    const file = path.join(root, 'session.v4.jsonl.zstd');
    const user = (text, source = { kind: 'user' }) => ({
      type: 'user/message', seq: 1, data: { content: [{ type: 'text', text }], source },
    });
    const assistant = (text) => ({
      type: 'assistant/message', seq: 2, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
    });
    writeFileSync(file, Buffer.concat([
      frame([{ type: 'session', version: 4, id: 's1', createdAt: 1 }]),
      frame([user('first prompt'), assistant('first answer')]),
      frame([user('<system-reminder>injected</system-reminder>', { kind: 'injection' }), user('second prompt'), assistant('second answer')]),
    ]));

    assert.deepEqual(readSessionHistory(file), [
      { role: 'user', text: 'first prompt' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'second prompt' },
      { role: 'assistant', text: 'second answer' },
    ]);
    assert.equal(findSessionFile([{ id: 's1', dir: root }], 's1'), file);
    assert.equal(findSessionFile([], 'missing'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('history handles a torn trailing frame and enforces a message cap', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-history-'));
  try {
    const file = path.join(root, 'session.v4.jsonl.zstd');
    const events = Array.from({ length: 4 }, (_, index) => ({
      type: 'user/message', seq: index, data: { content: [{ type: 'text', text: `prompt-${index}` }], source: { kind: 'user' } },
    }));
    const valid = frame(events);
    writeFileSync(file, Buffer.concat([valid, Buffer.from([0x28, 0xb5])]));
    const rows = readSessionHistory(file, { limit: 2 });
    assert.deepEqual(rows.map((row) => row.text), ['prompt-2', 'prompt-3']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
