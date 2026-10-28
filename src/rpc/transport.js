/**
 * Newline-delimited JSON-RPC 2.0 transport for the DSH SDK runtime protocol.
 *
 * Wire format (verified against `@deepseek-ai/dsh-sdk-protocol`):
 * every `\n`-terminated line carries one JSON-RPC 2.0 message. A frame with both
 * `id` and `method` is a request, `id` alone is a response, `method` alone is a
 * notification. Malformed lines are ignored rather than thrown, because a peer
 * that writes one bad line must not take the session down.
 *
 * The transport owns framing and correlations only: it has no knowledge of DSH
 * methods, sessions or events. {@link DshRpcClient} adds that layer.
 *
 * Design notes:
 * - `StringDecoder` is used so a multi-byte UTF-8 sequence split across two
 *   chunks cannot corrupt a frame (chunks are NOT assumed to be whole lines).
 * - The pending map is keyed by the exact JSON-RPC id the peer will echo, so
 *   responses may arrive out of order — the protocol does not promise ordering.
 * - An unbounded line buffer is a memory-exhaustion vector, so a single frame
 *   has a configurable byte ceiling and exceeding it fails the transport.
 *
 * @module dsh-cli/rpc/transport
 */

import { StringDecoder } from 'node:string_decoder';

/** Default ceiling for one unterminated line, in bytes (64 MiB). */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

/** JSON-RPC error code returned when a peer requests an unhandled method. */
export const METHOD_NOT_FOUND = -32601;

/** JSON-RPC error code returned when a request handler throws. */
export const INTERNAL_ERROR = -32603;

/**
 * A JSON-RPC error response, preserving the wire `code` and optional `data`.
 */
export class JsonRpcResponseError extends Error {
  /**
   * @param {number | undefined} code Wire error code, or `undefined`.
   * @param {string} message Wire error message.
   * @param {unknown} [data] Optional structured error payload, verbatim.
   */
  constructor(code, message, data) {
    super(message);
    /** @type {number | undefined} */
    this.code = code;
    /** @type {unknown} */
    this.data = data;
    this.name = 'JsonRpcResponseError';
  }
}

/**
 * A transport-layer failure (closed pipe, oversized frame, write failure).
 * Distinct from {@link JsonRpcResponseError}, which is a well-formed error
 * *response* from a healthy peer.
 */
export class JsonRpcTransportError extends Error {
  /**
   * @param {string} message Human-readable description.
   * @param {string} code Stable machine code, e.g. `'LINE_TOO_LONG'`.
   * @param {unknown} [cause] Underlying error, when one exists.
   */
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause });
    /** @type {string} */
    this.code = code;
    this.name = 'JsonRpcTransportError';
  }
}

/**
 * Coerce an abort signal's reason into the rejection error.
 *
 * @param {AbortSignal} signal The signal that aborted.
 * @returns {Error} The signal reason when it is an Error, else an AbortError.
 */
export function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(
    `JSON-RPC request aborted: ${reason === undefined ? 'no reason' : String(reason)}`,
  );
  error.name = 'AbortError';
  /** @type {unknown} */
  error.code = 'ABORTED';
  return error;
}

/**
 * Normalize JSON-RPC `params` to a plain object; arrays and scalars collapse to
 * `{}` so handlers can read properties without guarding.
 *
 * @param {unknown} params Raw `params` member.
 * @returns {Record<string, unknown>} A plain object.
 */
function objectParams(params) {
  return params !== null && typeof params === 'object' && !Array.isArray(params)
    ? /** @type {Record<string, unknown>} */ (params)
    : {};
}

/**
 * @param {unknown} error Arbitrary thrown value.
 * @returns {string} A message safe to put on the wire.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @callback RequestHandler
 * @param {string} method Incoming method name.
 * @param {Record<string, unknown>} params Incoming params object.
 * @returns {unknown | Promise<unknown>} The response `result`.
 */

/**
 * @callback NotificationHandler
 * @param {string} method Notification method name.
 * @param {Record<string, unknown>} params Notification params object.
 * @returns {void}
 */

/**
 * @callback ErrorHandler
 * @param {Error} error Transport-level failure.
 * @returns {void}
 */

/** @typedef {{ resolve: (value: any) => void, reject: (error: Error) => void, detach: () => void }} PendingEntry */

/**
 * Line-framed JSON-RPC 2.0 endpoint over caller-owned streams.
 *
 * `start()` attaches listeners; `close()` detaches them and rejects everything
 * still pending without destroying the streams (the owner owns their lifetime).
 */
export class JsonRpcTransport {
  /** @type {import('node:stream').Readable} */
  #input;
  /** @type {import('node:stream').Writable} */
  #output;
  /** @type {StringDecoder} */
  #decoder = new StringDecoder('utf8');
  /** @type {string} Decoded characters not yet terminated by `\n`. */
  #buffer = '';
  /** @type {number} Byte length of `#buffer`, tracked incrementally (UTF-8 exact). */
  #bufferBytes = 0;
  /** @type {boolean} */
  #started = false;
  /** @type {boolean} */
  #closed = false;
  /** @type {Map<string, PendingEntry>} */
  #pending = new Map();
  /** @type {number} */
  #nextId = 0;
  /** @type {string} */
  #idPrefix;
  /** @type {number} */
  #maxLineBytes;
  /** @type {RequestHandler | undefined} */
  #requestHandler;
  /** @type {NotificationHandler | undefined} */
  #notificationHandler;
  /** @type {ErrorHandler | undefined} */
  #errorHandler;
  /** @type {Error | null} */
  #lastError = null;

  /**
   * @param {object} options Transport wiring.
   * @param {import('node:stream').Readable} options.input Stream of inbound bytes.
   * @param {import('node:stream').Writable} options.output Stream for outbound frames.
   * @param {number} [options.maxLineBytes] Ceiling for one unterminated line.
   * @param {string} [options.idPrefix] Prefix for generated request ids.
   */
  constructor({ input, output, maxLineBytes = DEFAULT_MAX_LINE_BYTES, idPrefix = 'cli' } = {}) {
    if (input === null || typeof input !== 'object' || typeof input.on !== 'function') {
      throw new TypeError('JsonRpcTransport requires a readable `input` stream');
    }
    if (output === null || typeof output !== 'object' || typeof output.write !== 'function') {
      throw new TypeError('JsonRpcTransport requires a writable `output` stream');
    }
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new TypeError('JsonRpcTransport maxLineBytes must be a positive safe integer');
    }
    this.#input = input;
    this.#output = output;
    this.#maxLineBytes = maxLineBytes;
    this.#idPrefix = idPrefix;
  }

  /** @returns {number} Requests awaiting a response. */
  get pendingCount() {
    return this.#pending.size;
  }

  /** @returns {boolean} True once the endpoint stopped reading or was closed. */
  get closed() {
    return this.#closed;
  }

  /** @returns {Error | null} The most recent transport-level failure. */
  get lastError() {
    return this.#lastError;
  }

  /**
   * Attach input listeners and begin reading frames. Idempotent.
   *
   * @returns {this} This transport, for chaining.
   */
  start() {
    if (this.#started || this.#closed) return this;
    this.#started = true;
    this.#input.on('data', this.#onData);
    this.#input.on('error', this.#onInputError);
    this.#input.on('end', this.#onInputEnd);
    return this;
  }

  /**
   * Detach listeners and reject pending requests. Safe before `start()`.
   * Idempotent; the streams themselves are left open for their owner.
   *
   * @param {Error} [reason] Rejection reason for pending requests.
   * @returns {void}
   */
  close(reason) {
    const error = reason ?? new JsonRpcTransportError('JSON-RPC transport closed', 'CLOSED');
    this.#detach();
    this.#closed = true;
    this.#failPending(error);
  }

  /**
   * Install the request handler, replacing any prior handler.
   *
   * @param {RequestHandler} handler Resolves to the response `result`.
   * @returns {void}
   */
  onRequest(handler) {
    this.#requestHandler = handler;
  }

  /**
   * Install the notification handler, replacing any prior handler.
   *
   * @param {NotificationHandler} handler Invoked per notification.
   * @returns {void}
   */
  onNotification(handler) {
    this.#notificationHandler = handler;
  }

  /**
   * Install the transport-failure handler, replacing any prior handler.
   * Transport failures also reject pending requests, so this is for reporting
   * only (a UI needs a reason, not just a rejected promise).
   *
   * @param {ErrorHandler} handler Receives the failure.
   * @returns {void}
   */
  onError(handler) {
    this.#errorHandler = handler;
  }

  /**
   * Send a request and await its response.
   *
   * @param {string} method JSON-RPC method name.
   * @param {unknown} [params] Request parameters.
   * @param {AbortSignal} [signal] Abandonment signal; aborting removes the
   *   pending entry (nothing is retained for a response that may never come)
   *   and rejects with the signal's reason.
   * @returns {Promise<any>} The response `result`.
   */
  request(method, params, signal) {
    if (typeof method !== 'string' || method === '') {
      return Promise.reject(new TypeError('request() requires a non-empty method string'));
    }
    if (this.#closed) {
      return Promise.reject(
        this.#lastError ?? new JsonRpcTransportError('JSON-RPC transport is closed', 'CLOSED'),
      );
    }

    const id = `${this.#idPrefix}_${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      /** @type {() => void} */
      let detach = () => {};

      if (signal !== undefined) {
        if (signal.aborted) {
          reject(abortError(signal));
          return;
        }
        const onAbort = () => {
          // The peer may still send a response; without this entry it is dropped.
          this.#pending.delete(id);
          detach();
          reject(abortError(signal));
        };
        detach = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.#pending.set(id, { resolve, reject, detach });

      const frame = { jsonrpc: '2.0', id, method };
      if (params !== undefined) frame.params = params;

      try {
        this.#write(frame);
      } catch (error) {
        this.#pending.delete(id);
        detach();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Send a notification (no id, no response expected).
   *
   * @param {string} method Notification method name.
   * @param {unknown} [params] Notification parameters.
   * @returns {void}
   */
  notify(method, params) {
    if (typeof method !== 'string' || method === '') {
      throw new TypeError('notify() requires a non-empty method string');
    }
    if (this.#closed) {
      throw this.#lastError ?? new JsonRpcTransportError('JSON-RPC transport is closed', 'CLOSED');
    }
    const frame = { jsonrpc: '2.0', method };
    if (params !== undefined) frame.params = params;
    this.#write(frame);
  }

  // ---------------------------------------------------------------- internals

  /**
   * Serialize and write one frame. Backpressure is intentionally ignored:
   * control frames are small, and Node buffers internally; a caller that needs
   * drain semantics owns the stream.
   *
   * @param {Record<string, unknown>} frame The message to send.
   * @returns {void}
   */
  #write(frame) {
    this.#output.write(`${JSON.stringify(frame)}\n`);
  }

  /** @type {(chunk: Buffer | string) => void} */
  #onData = (chunk) => {
    if (this.#closed) return;
    const isString = typeof chunk === 'string';
    // StringDecoder retains a split multi-byte sequence until the next chunk.
    const text = isString ? chunk : this.#decoder.write(chunk);
    // `chunk.length` is the exact byte count for a Buffer; strings are measured.
    const bytes = isString ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
    this.#buffer += text;
    // Only the bytes that survived as text belong to the current line; a
    // trailing partial sequence stays inside the decoder, not the buffer.
    this.#bufferBytes += text === '' ? 0 : bytes;
    this.#drain();
  };

  /**
   * Emit every complete line currently buffered.
   *
   * @returns {void}
   */
  #drain() {
    let cursor = 0;
    for (;;) {
      const newline = this.#buffer.indexOf('\n', cursor);
      if (newline < 0) break;

      // `trim()` also strips the `\r` a CRLF-terminated peer would send.
      const line = this.#buffer.slice(cursor, newline).trim();
      cursor = newline + 1;
      if (line !== '') this.#handleLine(line);
    }

    if (cursor > 0) {
      // One slice for the whole batch keeps a large chunk linear, not quadratic.
      this.#buffer = this.#buffer.slice(cursor);
      // Recomputed once per batch, not per chunk: a long line stays O(n) overall.
      this.#bufferBytes = Buffer.byteLength(this.#buffer, 'utf8');
    }

    // A peer that never terminates a line must not grow the buffer without bound.
    if (this.#bufferBytes > this.#maxLineBytes) this.#failOverlongLine();
  }

  /**
   * Dispatch one parsed frame by its members.
   *
   * @param {string} line A single non-empty, newline-free line.
   * @returns {void}
   */
  #handleLine(line) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A malformed line is ignored, never thrown: one bad frame must not kill
      // the session. Diagnostics stay available through the caller's logger.
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    const frame = /** @type {Record<string, unknown>} */ (parsed);
    const id = frame.id;
    const method = frame.method;
    const hasId = typeof id === 'string' || typeof id === 'number';
    const hasMethod = typeof method === 'string' && method !== '';

    if (hasId && hasMethod) {
      void this.#handleRequest(id, method, objectParams(frame.params));
      return;
    }
    if (hasId) {
      this.#handleResponse(id, frame);
      return;
    }
    if (hasMethod) {
      try {
        this.#notificationHandler?.(method, objectParams(frame.params));
      } catch (error) {
        // A throwing subscriber must not corrupt framing for later frames.
        this.#reportError(
          new JsonRpcTransportError(
            `notification handler failed for "${method}": ${messageOf(error)}`,
            'HANDLER_FAILED',
            error,
          ),
        );
      }
    }
  }

  /**
   * Answer an inbound request (unused by the DSH runtime today, but the
   * protocol defines it and the capability is reserved for future approvals).
   *
   * @param {string | number} id Request id to echo.
   * @param {string} method Requested method.
   * @param {Record<string, unknown>} params Request params.
   * @returns {Promise<void>} Resolves once the reply is written.
   */
  async #handleRequest(id, method, params) {
    const handler = this.#requestHandler;
    if (handler === undefined) {
      this.#writeSafely({
        jsonrpc: '2.0',
        id,
        error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(method, params);
      this.#writeSafely({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
    } catch (error) {
      this.#writeSafely({
        jsonrpc: '2.0',
        id,
        error: { code: INTERNAL_ERROR, message: messageOf(error) },
      });
    }
  }

  /**
   * Settle the pending request that owns this response id, if any.
   *
   * @param {string | number} id Response id.
   * @param {Record<string, unknown>} frame The full response frame.
   * @returns {void}
   */
  #handleResponse(id, frame) {
    const entry = this.#pending.get(id);
    if (entry === undefined) return; // late response for an aborted request
    this.#pending.delete(id);
    entry.detach();

    const error = frame.error;
    if (error !== null && typeof error === 'object') {
      const wire = /** @type {Record<string, unknown>} */ (error);
      entry.reject(
        new JsonRpcResponseError(
          typeof wire.code === 'number' ? wire.code : undefined,
          typeof wire.message === 'string' ? wire.message : 'JSON-RPC error',
          /** @type {unknown} */ (wire.data),
        ),
      );
      return;
    }
    entry.resolve(/** @type {unknown} */ (frame.result));
  }

  /**
   * Write a frame without letting a dead pipe take down the reader.
   *
   * @param {Record<string, unknown>} frame Frame to send.
   * @returns {void}
   */
  #writeSafely(frame) {
    if (this.#closed) return;
    try {
      this.#write(frame);
    } catch (error) {
      this.#reportError(
        new JsonRpcTransportError(`write failed: ${messageOf(error)}`, 'WRITE_FAILED', error),
      );
    }
  }

  /**
   * Fail the endpoint because one line exceeded the configured ceiling.
   * The partial frame is discarded: it can never be parsed.
   *
   * @returns {void}
   */
  #failOverlongLine() {
    const error = new JsonRpcTransportError(
      `JSON-RPC frame exceeded the ${this.#maxLineBytes} byte limit and was discarded`,
      'LINE_TOO_LONG',
    );
    this.#buffer = '';
    this.#bufferBytes = 0;
    this.#lastError = error;
    this.#reportError(error);
    this.#detach();
    this.#closed = true;
    this.#failPending(error);
  }

  /** @type {(error: Error) => void} */
  #onInputError = (error) => {
    if (this.#closed) return;
    const wrapped =
      error instanceof JsonRpcTransportError
        ? error
        : new JsonRpcTransportError(`input stream failed: ${messageOf(error)}`, 'INPUT_ERROR', error);
    this.#lastError = wrapped;
    this.#failPending(wrapped);
  };

  /** @type {() => void} */
  #onInputEnd = () => {
    if (this.#closed) return;
    // Flush any trailing multi-byte sequence the decoder still holds.
    this.#buffer += this.#decoder.end();
    this.#drain();
    const error = new JsonRpcTransportError('JSON-RPC input closed', 'INPUT_CLOSED');
    this.#lastError = error;
    this.#failPending(error);
  };

  /**
   * @param {Error} error Transport failure to publish.
   * @returns {void}
   */
  #reportError(error) {
    try {
      this.#errorHandler?.(error);
    } catch {
      // A throwing error handler must not mask the original failure.
    }
  }

  /**
   * @param {Error} error Rejection reason for every pending request.
   * @returns {void}
   */
  #failPending(error) {
    if (this.#pending.size === 0) return;
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) {
      entry.detach();
      entry.reject(error);
    }
  }

  /** Detach every input listener exactly once. @returns {void} */
  #detach() {
    if (!this.#started) return;
    this.#started = false;
    this.#input.off('data', this.#onData);
    this.#input.off('error', this.#onInputError);
    this.#input.off('end', this.#onInputEnd);
  }
}
