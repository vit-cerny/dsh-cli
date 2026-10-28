import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import {
  JsonRpcResponseError,
  JsonRpcTransport,
  JsonRpcTransportError,
  abortError,
} from '../src/rpc/transport.js';

/**
 * Build a transport over in-memory streams.
 *
 * @param {object} [options] Extra transport options.
 * @returns {{transport: JsonRpcTransport, inbound: PassThrough, outbound: PassThrough,
 *   sent: () => object[], send: (frame: object) => void}} Test harness.
 */
function harness(options = {}) {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  /** @type {object[]} */
  const sent = [];

  outbound.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() !== '') sent.push(JSON.parse(line));
    }
  });

  const transport = new JsonRpcTransport({ input: inbound, output: outbound, ...options });
  transport.start();

  return {
    transport,
    inbound,
    outbound,
    sent,
    /** Write one raw frame as a newline-terminated line. */
    send: (frame) => inbound.write(`${JSON.stringify(frame)}\n`),
  };
}

describe('JsonRpcTransport framing', () => {
  it('decodes a frame split across two chunks', async () => {
    const { transport, inbound, send } = harness();
    const notification = new Promise((resolve) => {
      transport.onNotification((method, params) => resolve({ method, params }));
    });

    const frame = JSON.stringify({ jsonrpc: '2.0', method: 'session/status', params: { status: 'idle' } });
    // Split mid-JSON so neither chunk is a whole line.
    inbound.write(frame.slice(0, 17));
    inbound.write(frame.slice(17) + '\n');

    const received = await notification;
    assert.equal(received.method, 'session/status');
    assert.deepEqual(received.params, { status: 'idle' });
  });

  it('decodes a frame ending exactly on a chunk boundary', async () => {
    const { transport, inbound } = harness();
    const seen = [];
    transport.onNotification((method, params) => seen.push({ method, params }));

    inbound.write('{"jsonrpc":"2.0","method":"a"}');
    inbound.write('\n{"jsonrpc":"2.0","method":"b"}\n');
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(seen.map((n) => n.method), ['a', 'b']);
  });

  it('handles multi-byte UTF-8 split across chunks', async () => {
    const { transport, inbound } = harness();
    const notification = new Promise((resolve) => {
      transport.onNotification((_method, params) => resolve(params));
    });

    const line = `${JSON.stringify({ jsonrpc: '2.0', method: 'm', params: { t: '日本語' } })}\n`;
    const bytes = Buffer.from(line, 'utf8');
    // Slice inside the multi-byte character to prove StringDecoder is in use.
    const cut = bytes.indexOf(Buffer.from('日', 'utf8')) + 1;
    inbound.write(bytes.subarray(0, cut));
    inbound.write(bytes.subarray(cut));

    assert.deepEqual(await notification, { t: '日本語' });
  });

  it('ignores blank lines and malformed JSON without throwing', async () => {
    const { transport, inbound } = harness();
    const seen = [];
    transport.onNotification((method) => seen.push(method));

    inbound.write('\n\n   \nnot json at all\n{"jsonrpc":"2.0","method":"ok"}\n');
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(seen, ['ok']);
    assert.equal(transport.closed, false);
  });

  it('treats a non-object JSON line as ignorable', async () => {
    const { transport, inbound } = harness();
    const seen = [];
    transport.onNotification((method) => seen.push(method));

    inbound.write('42\n"str"\n[1,2]\nnull\n{"jsonrpc":"2.0","method":"ok"}\n');
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(seen, ['ok']);
  });

  it('accepts CRLF-terminated lines', async () => {
    const { transport, inbound } = harness();
    const seen = [];
    transport.onNotification((method) => seen.push(method));

    inbound.write('{"jsonrpc":"2.0","method":"crlf"}\r\n');
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(seen, ['crlf']);
  });
});

describe('JsonRpcTransport request/response correlation', () => {
  it('writes a request frame and resolves with its result', async () => {
    const { transport, sent, send } = harness();

    const pending = transport.request('initialize', { cwd: '.', provider: 'p', model: 'm' });
    await new Promise((r) => setImmediate(r));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].jsonrpc, '2.0');
    assert.equal(sent[0].method, 'initialize');
    assert.deepEqual(sent[0].params, { cwd: '.', provider: 'p', model: 'm' });
    assert.equal(typeof sent[0].id, 'string');

    send({ jsonrpc: '2.0', id: sent[0].id, result: { serverInfo: { name: 'n' } } });
    assert.deepEqual(await pending, { serverInfo: { name: 'n' } });
    assert.equal(transport.pendingCount, 0);
  });

  it('matches responses that arrive out of order', async () => {
    const { transport, sent, send } = harness();

    const first = transport.request('a');
    const second = transport.request('b');
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 2);

    send({ jsonrpc: '2.0', id: sent[1].id, result: 'second' });
    send({ jsonrpc: '2.0', id: sent[0].id, result: 'first' });

    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
  });

  it('rejects with JsonRpcResponseError and preserves code and data', async () => {
    const { transport, sent, send } = harness();

    const pending = transport.request('session/prompt', { sessionId: 's' });
    await new Promise((r) => setImmediate(r));
    send({
      jsonrpc: '2.0',
      id: sent[0].id,
      error: { code: -32603, message: 'SDK server is not initialized', data: { at: 'prompt' } },
    });

    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof JsonRpcResponseError);
      assert.equal(error.code, -32603);
      assert.equal(error.name, 'JsonRpcResponseError');
      assert.equal(error.message, 'SDK server is not initialized');
      assert.deepEqual(error.data, { at: 'prompt' });
      return true;
    });
  });

  it('preserves -32601 for an unknown method', async () => {
    const { transport, sent, send } = harness();
    const pending = transport.request('nope');
    await new Promise((r) => setImmediate(r));
    send({ jsonrpc: '2.0', id: sent[0].id, error: { code: -32601, message: 'method not found: nope' } });

    await assert.rejects(pending, (error) => error.code === -32601);
  });

  it('leaves the error code undefined when the wire omits it', async () => {
    const { transport, sent, send } = harness();
    const pending = transport.request('x');
    await new Promise((r) => setImmediate(r));
    send({ jsonrpc: '2.0', id: sent[0].id, error: { message: 'bare' } });

    await assert.rejects(pending, (error) => {
      assert.equal(error.code, undefined);
      assert.equal(error.message, 'bare');
      return true;
    });
  });

  it('ignores a response whose id was never requested', async () => {
    const { transport, send } = harness();
    const seen = [];
    transport.onNotification((method) => seen.push(method));

    send({ jsonrpc: '2.0', id: 'ghost', result: {} });
    send({ jsonrpc: '2.0', method: 'still-works' });
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(seen, ['still-works']);
    assert.equal(transport.pendingCount, 0);
  });

  it('sends a notification without an id', async () => {
    const { transport, sent } = harness();
    transport.notify('session/event', { a: 1 });
    await new Promise((r) => setImmediate(r));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'session/event');
    assert.equal('id' in sent[0], false);
    assert.deepEqual(sent[0].params, { a: 1 });
  });
});

describe('JsonRpcTransport cancellation', () => {
  it('rejects and drops the pending entry when the signal aborts', async () => {
    const { transport, sent, send } = harness();
    const controller = new AbortController();

    const pending = transport.request('session/wait', { sessionId: 's' }, controller.signal);
    await new Promise((r) => setImmediate(r));
    assert.equal(transport.pendingCount, 1);

    controller.abort(new Error('user cancelled'));

    await assert.rejects(pending, /user cancelled/);
    assert.equal(transport.pendingCount, 0);

    // A late response for the abandoned request must not throw or resurrect it.
    send({ jsonrpc: '2.0', id: sent[0].id, result: {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(transport.pendingCount, 0);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const { transport, sent } = harness();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(transport.request('x', undefined, controller.signal), /aborted/i);
    await new Promise((r) => setImmediate(r));
    // Nothing was written: the request never went out.
    assert.equal(sent.length, 0);
  });

  it('does not fire the abort handler after a successful response', async () => {
    const { transport, sent, send } = harness();
    const controller = new AbortController();

    const pending = transport.request('x', undefined, controller.signal);
    await new Promise((r) => setImmediate(r));
    send({ jsonrpc: '2.0', id: sent[0].id, result: 'done' });
    assert.equal(await pending, 'done');

    // Aborting after settlement must be a no-op (no unhandled rejection).
    controller.abort(new Error('late abort'));
    assert.equal(transport.pendingCount, 0);
  });

  it('abortError falls back to an AbortError for non-Error reasons', () => {
    const controller = new AbortController();
    controller.abort('just a string');
    const error = abortError(controller.signal);
    assert.equal(error.name, 'AbortError');
    assert.match(error.message, /just a string/);
  });
});

describe('JsonRpcTransport failure paths', () => {
  it('rejects all pending requests when the input ends', async () => {
    const { transport, inbound } = harness();
    const a = transport.request('a');
    const b = transport.request('b');
    await new Promise((r) => setImmediate(r));

    inbound.end();

    await assert.rejects(a, /input closed/i);
    await assert.rejects(b, /input closed/i);
    assert.equal(transport.pendingCount, 0);
  });

  it('rejects pending requests when the input errors', async () => {
    const { transport, inbound } = harness();
    const pending = transport.request('a');
    await new Promise((r) => setImmediate(r));

    inbound.emit('error', new Error('EPIPE'));

    await assert.rejects(pending, /EPIPE/);
  });

  it('close() rejects pending requests and refuses new ones', async () => {
    const { transport } = harness();
    const pending = transport.request('a');
    await new Promise((r) => setImmediate(r));

    transport.close();

    await assert.rejects(pending, /closed/i);
    assert.equal(transport.closed, true);
    await assert.rejects(transport.request('b'), /closed/i);
  });

  it('fails the transport when one line exceeds maxLineBytes', async () => {
    const { transport, inbound } = harness({ maxLineBytes: 64 });
    const errors = [];
    transport.onError((error) => errors.push(error));
    const pending = transport.request('a');
    await new Promise((r) => setImmediate(r));

    inbound.write('x'.repeat(200));

    await assert.rejects(pending, /exceeded the 64 byte limit/);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof JsonRpcTransportError);
    assert.equal(errors[0].code, 'LINE_TOO_LONG');
    assert.equal(transport.closed, true);
  });

  it('does not fail on a long line that is still under the limit', async () => {
    const { transport, inbound } = harness({ maxLineBytes: 1024 });
    const seen = [];
    transport.onNotification((method, params) => seen.push(params.text.length));

    const text = 'y'.repeat(500);
    inbound.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'm', params: { text } })}\n`);
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(seen, [500]);
    assert.equal(transport.closed, false);
  });

  it('answers an inbound request with -32601 when no handler is installed', async () => {
    const { sent, send } = harness();
    send({ jsonrpc: '2.0', id: 'srv-1', method: 'unknown/method', params: {} });
    await new Promise((r) => setImmediate(r));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 'srv-1');
    assert.equal(sent[0].error.code, -32601);
  });

  it('answers an inbound request with its result when a handler is installed', async () => {
    const { transport, sent, send } = harness();
    transport.onRequest(async (method, params) => ({ echo: method, params }));

    send({ jsonrpc: '2.0', id: 7, method: 'custom', params: { a: 1 } });
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(sent[0], {
      jsonrpc: '2.0',
      id: 7,
      result: { echo: 'custom', params: { a: 1 } },
    });
  });

  it('answers an inbound request with -32603 when the handler throws', async () => {
    const { transport, sent, send } = harness();
    transport.onRequest(() => {
      throw new Error('handler exploded');
    });

    send({ jsonrpc: '2.0', id: 1, method: 'x' });
    await new Promise((r) => setImmediate(r));

    assert.equal(sent[0].error.code, -32603);
    assert.match(sent[0].error.message, /handler exploded/);
  });

  it('keeps framing intact when a notification handler throws', async () => {
    const { transport, inbound } = harness();
    const errors = [];
    const seen = [];
    transport.onError((error) => errors.push(error));
    transport.onNotification((method) => {
      if (method === 'bad') throw new Error('subscriber bug');
      seen.push(method);
    });

    inbound.write('{"jsonrpc":"2.0","method":"bad"}\n{"jsonrpc":"2.0","method":"good"}\n');
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(seen, ['good']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'HANDLER_FAILED');
  });

  it('validates constructor arguments', () => {
    assert.throws(() => new JsonRpcTransport({}), /readable `input`/);
    assert.throws(
      () => new JsonRpcTransport({ input: new PassThrough() }),
      /writable `output`/,
    );
    assert.throws(
      () =>
        new JsonRpcTransport({
          input: new PassThrough(),
          output: new PassThrough(),
          maxLineBytes: 0,
        }),
      /maxLineBytes/,
    );
  });
});
