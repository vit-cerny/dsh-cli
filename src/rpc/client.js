/**
 * DSH SDK runtime client: process lifecycle plus typed JSON-RPC methods.
 *
 * The runtime is a separate Node process speaking newline-delimited JSON-RPC
 * over stdio (verified: `@deepseek-ai/dsh-sdk-jsonrpc-server`). Its stdout
 * carries protocol frames only, so nothing in this module may write to the
 * child's stdout, and all diagnostics from the child are forwarded to an
 * injectable logger instead of being parsed.
 *
 * Handshake policy (explicit decision): this client does **not** silently
 * queue prompts behind an implicit handshake. Calling `prompt()` before
 * `initialize()` rejects with a clear `NOT_INITIALIZED` error; calling it
 * *during* an in-flight handshake awaits that handshake instead of racing it.
 * The runtime enforces this too (`-32603 "SDK server is not initialized"`),
 * but failing locally gives the caller an actionable message and no wasted
 * round trip.
 *
 * @module dsh-cli/rpc/client
 */

import { spawn as spawnProcess } from 'node:child_process';
import process from 'node:process';

import { resolveRuntimeBin } from '../cli/discover.js';
import {
  JsonRpcResponseError,
  JsonRpcTransport,
  JsonRpcTransportError,
} from './transport.js';

/**
 * Absolute path of the bundled DSH runtime entry point. Kept as the last-resort
 * default for the machine it was written on; {@link resolveRuntimeBin} finds the
 * install on any other one.
 */
export const DEFAULT_RUNTIME_BIN =
  'C:\\Program Files\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';

/** Default `--profile` passed to the runtime; the SDK profile mounts the server. */
export const DEFAULT_RUNTIME_PROFILE = 'sdk';

/** Default cap on retained stderr characters per client. */
const DEFAULT_STDERR_LIMIT = 64 * 1024;

/**
 * Leftover stderr, trimmed to the newest characters. Attached to errors so a
 * failed handshake explains itself without the caller wiring a logger.
 */
export class StderrRing {
  /** @param {number} [limit] Max characters retained. */
  constructor(limit = DEFAULT_STDERR_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError('StderrRing limit must be a positive safe integer');
    }
    /** @type {number} */
    this.limit = limit;
    /** @type {string} */
    this.text = '';
    /** @type {number} */
    this.dropped = 0;
  }

  /**
   * @param {string} chunk Newly read stderr text.
   * @returns {void}
   */
  push(chunk) {
    this.text += chunk;
    if (this.text.length > this.limit) {
      const overflow = this.text.length - this.limit;
      this.text = this.text.slice(overflow);
      this.dropped += overflow;
    }
  }

  /**
   * @returns {string} The retained tail, prefixed when earlier output was lost.
   */
  toString() {
    return this.dropped > 0
      ? `[…${this.dropped} chars dropped…]\n${this.text}`
      : this.text;
  }
}

/**
 * A logger that swallows everything. The default, so an unused client is quiet.
 *
 * @type {{ debug: (...a: unknown[]) => void, info: (...a: unknown[]) => void, warn: (...a: unknown[]) => void, error: (...a: unknown[]) => void }}
 */
const SILENT_LOGGER = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});

/**
 * Error raised when the client is used before a successful handshake.
 */
export class NotInitializedError extends Error {
  /**
   * @param {string} message Human-readable explanation.
   * @param {unknown} [cause] The handshake failure, when there was one.
   */
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'NotInitializedError';
    /** @type {string} */
    this.code = 'NOT_INITIALIZED';
  }
}

/**
 * Client for one DSH SDK runtime child process.
 *
 * Owns the child, the transport and the handshake. Methods map 1:1 onto the
 * verified wire contract; none of them invent capability the runtime lacks
 * (notably, there is no cancel method — see {@link SessionAbortedError}).
 */
export class DshRpcClient {
  /** @type {import('node:child_process').ChildProcess} */
  #child;
  /** @type {JsonRpcTransport} */
  #transport;
  /** @type {string} */
  #cwd;
  /** @type {string} */
  #provider;
  /** @type {string} */
  #model;
  /** @type {string | undefined} */
  #reasoningEffort;
  /** @type {number | undefined} */
  #maxTokens;
  /** @type {{ debug: Function, info: Function, warn: Function, error: Function }} */
  #logger;
  /** @type {StderrRing} */
  #stderr;
  /** @type {Promise<any> | null} */
  #handshake = null;
  /** @type {any} */
  #serverInfo = null;
  /** @type {boolean} */
  #closed = false;
  /** @type {{ method: string, params: Record<string, unknown> }[]} */
  #notificationHandlers = [];
  /** @type {((error: Error) => void)[]} */
  #errorHandlers = [];
  /** @type {() => void} */
  #unsubscribeTransportErrors = () => {};

  /**
   * Use {@link DshRpcClient.spawn}; construction alone does not start a process.
   *
   * @param {object} init Resolved wiring.
   * @private
   */
  constructor(init) {
    this.#child = init.child;
    this.#transport = init.transport;
    this.#cwd = init.cwd;
    this.#provider = init.provider;
    this.#model = init.model;
    this.#reasoningEffort = init.reasoningEffort;
    this.#maxTokens = init.maxTokens;
    this.#logger = init.logger;
    this.#stderr = init.stderr;
  }

  /**
   * Spawn the runtime and wire it to a transport.
   *
   * Resolves only once the OS reports the process started, so a bad runtime
   * path fails here rather than at handshake time.
   *
   * @param {object} options Spawn and handshake options.
   * @param {string} options.cwd Working directory for both the child and the session.
   * @param {string} options.provider Provider route id, e.g. `deepseek-official`.
   * @param {string} options.model Model id, e.g. `deepseek-flash`.
   * @param {string} [options.reasoningEffort] Adapter-specific effort id.
   * @param {number} [options.maxTokens] Positive per-conversation output cap.
   * @param {string} [options.runtimeCommand] Runtime entry point override
   *   (defaults to `DSH_CLI_RUNTIME_BIN`, then {@link DEFAULT_RUNTIME_BIN}).
   * @param {string[]} [options.runtimeArgs] Arguments (defaults to `--profile sdk`).
   * @param {string} [options.nodePath] Node executable (defaults to `process.execPath`).
   * @param {Record<string, string>} [options.env] Extra child environment.
   * @param {{ debug: Function, info: Function, warn: Function, error: Function }} [options.logger]
   *   Receives forwarded stderr lines and lifecycle notes.
   * @param {number} [options.maxLineBytes] Frame ceiling for the transport.
   * @param {number} [options.stderrLimit] Retained stderr characters.
   * @returns {Promise<DshRpcClient>} A started, not yet initialized client.
   */
  static async spawn(options) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('DshRpcClient.spawn requires an options object');
    }
    const { cwd, provider, model } = options;
    if (typeof cwd !== 'string' || cwd === '') {
      throw new TypeError('DshRpcClient.spawn requires a non-empty cwd string');
    }
    if (typeof provider !== 'string' || provider === '') {
      throw new TypeError('DshRpcClient.spawn requires a non-empty provider string');
    }
    if (typeof model !== 'string' || model === '') {
      throw new TypeError('DshRpcClient.spawn requires a non-empty model string');
    }
    if (
      options.reasoningEffort !== undefined &&
      (typeof options.reasoningEffort !== 'string' || options.reasoningEffort === '')
    ) {
      throw new TypeError('reasoningEffort must be a non-empty string when provided');
    }
    if (
      options.maxTokens !== undefined &&
      (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)
    ) {
      throw new TypeError('maxTokens must be a positive safe integer when provided');
    }

    const runtimeCommand =
      options.runtimeCommand ??
      process.env.DSH_CLI_RUNTIME_BIN ??
      resolveRuntimeBin().bin ??
      DEFAULT_RUNTIME_BIN;
    const runtimeArgs = options.runtimeArgs ?? ['--profile', DEFAULT_RUNTIME_PROFILE];
    const nodePath = options.nodePath ?? process.execPath;
    const logger = { ...SILENT_LOGGER, ...(options.logger ?? {}) };
    const stderr = new StderrRing(options.stderrLimit ?? DEFAULT_STDERR_LIMIT);

    logger.debug?.(`dsh-rpc: spawning ${runtimeCommand} ${runtimeArgs.join(' ')}`);

    const child = spawnProcess(nodePath, [runtimeCommand, ...runtimeArgs], {
      cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      // stdin/stdout carry protocol frames; stderr is diagnostics only.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onError);
        resolve(undefined);
      };
      const onError = (error) => {
        child.off('spawn', onSpawn);
        reject(
          new JsonRpcTransportError(
            `failed to spawn the DSH runtime at "${runtimeCommand}": ${error.message}`,
            'SPAWN_FAILED',
            error,
          ),
        );
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
      // ENOENT leaves stdio in an error state on some platforms. Retain one
      // listener after the spawn attempt so rejection cannot become a crash.
      child.on('error', () => {});
    });

    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new JsonRpcTransportError(
        'the DSH runtime did not expose stdin/stdout/stderr pipes',
        'NO_STDIO',
      );
    }

    const transport = new JsonRpcTransport({
      input: child.stdout,
      output: child.stdin,
      maxLineBytes: options.maxLineBytes,
    });

    const client = new DshRpcClient({
      child,
      transport,
      cwd,
      provider,
      model,
      reasoningEffort: options.reasoningEffort,
      maxTokens: options.maxTokens,
      logger,
      stderr,
    });

    // Keep the child's diagnostics visible without polluting the protocol stream.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') logger.debug?.(`dsh-runtime: ${line}`);
      }
    });

    transport.onError((error) => client.#emitError(error));
    const rejectOnFailure = (error) => client.#transport.close(error);
    const unsubscribeErrors = client.onError(rejectOnFailure);
    client.#unsubscribeTransportErrors = unsubscribeErrors;
    transport.start();

    // A late async spawn/read failure is still owned by this client.
    child.on('error', (error) => {
      client.#emitError(
        new JsonRpcTransportError(`DSH runtime process failed: ${error.message}`, 'PROCESS_ERROR', error),
      );
    });

    child.on('exit', (code, signal) => {
      client.#emitError(
        new JsonRpcTransportError(
          `DSH runtime exited (code=${String(code)}, signal=${String(signal)})`,
          'PROCESS_EXITED',
        ),
      );
    });

    // stdin/stdout are pipes; without a listener a downstream EPIPE is fatal.
    child.stdin.on('error', (error) => {
      client.#emitError(
        new JsonRpcTransportError(
          `DSH runtime stdin failed: ${error.message}`,
          'STDIN_ERROR',
          error,
        ),
      );
    });

    return client;
  }

  /** @returns {number} Requests awaiting a response. */
  get pendingCount() {
    return this.#transport.pendingCount;
  }

  /** @returns {any} The `serverInfo` returned by a successful handshake, else `null`. */
  get serverInfo() {
    return this.#serverInfo;
  }

  /** @returns {boolean} True once the handshake completed successfully. */
  get initialized() {
    return this.#serverInfo !== null;
  }

  /** @returns {boolean} True once the client was closed or the child died. */
  get closed() {
    return this.#closed;
  }

  /** @returns {number} Runtime process id. */
  get pid() {
    return this.#child.pid ?? -1;
  }

  /** @returns {string} Retained runtime stderr, for error reports. */
  get stderr() {
    return this.#stderr.toString();
  }

  /** @returns {string} The working directory sent in the handshake. */
  get cwd() {
    return this.#cwd;
  }

  /** @returns {import('node:child_process').ChildProcess} The runtime child. */
  get child() {
    return this.#child;
  }

  /**
   * Subscribe to server→client notifications.
   *
   * @param {(method: string, params: Record<string, unknown>) => void} handler
   *   Called for every notification, in arrival order.
   * @returns {() => void} Unsubscribe function.
   */
  onNotification(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('onNotification requires a function');
    }
    this.#transport.onNotification((method, params) => {
      for (const subscriber of [...this.#notificationHandlers]) subscriber(method, params);
    });
    this.#notificationHandlers.push(handler);
    return () => {
      const index = this.#notificationHandlers.indexOf(handler);
      if (index >= 0) this.#notificationHandlers.splice(index, 1);
    };
  }

  /**
   * Subscribe to transport-level failures (closed pipe, child exit, bad frame).
   *
   * @param {(error: Error) => void} handler Receives the failure.
   * @returns {() => void} Unsubscribe function.
   */
  onError(handler) {
    if (typeof handler !== 'function') throw new TypeError('onError requires a function');
    this.#errorHandlers.push(handler);
    return () => {
      const index = this.#errorHandlers.indexOf(handler);
      if (index >= 0) this.#errorHandlers.splice(index, 1);
    };
  }

  /**
   * Perform the handshake. Idempotent and safe to call concurrently: every
   * caller awaits the same promise, and a failed handshake is not cached, so a
   * retry is possible while the process is still alive.
   *
   * The runtime resolves provider/model/effort during `initialize`, so a bad
   * route fails here rather than on the first prompt.
   *
   * @param {object} [overrides] Late overrides of the spawn-time values.
   * @param {AbortSignal} [signal] Abandonment signal.
   * @returns {Promise<any>} The `serverInfo` object.
   */
  initialize(overrides = {}, signal) {
    if (this.#serverInfo !== null) return Promise.resolve(this.#serverInfo);
    if (this.#handshake !== null) return this.#handshake;

    const params = {
      cwd: overrides.cwd ?? this.#cwd,
      provider: overrides.provider ?? this.#provider,
      model: overrides.model ?? this.#model,
    };
    const reasoningEffort = overrides.reasoningEffort ?? this.#reasoningEffort;
    const maxTokens = overrides.maxTokens ?? this.#maxTokens;
    if (reasoningEffort !== undefined) params.reasoningEffort = reasoningEffort;
    if (maxTokens !== undefined) params.maxTokens = maxTokens;

    // Record the effective route so later calls cannot disagree with the wire.
    this.#cwd = params.cwd;
    this.#provider = params.provider;
    this.#model = params.model;

    const attempt = this.#transport
      .request('initialize', params, signal)
      .then((result) => {
        this.#serverInfo = result;
        this.#logger.info?.(
          `dsh-rpc: initialized ${String(result?.serverInfo?.name)} v${String(result?.serverInfo?.version)}`,
        );
        return result;
      })
      .catch((error) => {
        // Do not cache the failure: the process may still be usable.
        if (this.#handshake === attempt) this.#handshake = null;
        throw this.#decorate(error, 'initialize failed');
      });

    this.#handshake = attempt;
    return attempt;
  }

  /**
   * Queue one user prompt.
   *
   * @param {string} sessionId Target session id; created on first use.
   * @param {{ type: string, text?: string, [key: string]: unknown }[]} contentBlocks
   *   Non-empty content block array; `[{ type: 'text', text }]` is the common case.
   * @param {AbortSignal} [signal] Abandonment signal for the *enqueue* only —
   *   see {@link SessionAbortedError} on why this cannot cancel the turn.
   * @returns {Promise<{ messageId: string }>} Durable enqueue receipt. This
   *   identifies the queued user message, not its assistant reply.
   */
  async prompt(sessionId, contentBlocks, signal) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new TypeError('prompt() requires a non-empty sessionId');
    }
    if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
      throw new TypeError('prompt() requires a non-empty contentBlocks array');
    }
    await this.#requireHandshake('prompt');

    try {
      return await this.#transport.request(
        'session/prompt',
        { sessionId, contentBlocks },
        signal,
      );
    } catch (error) {
      throw this.#decorate(error, 'session/prompt failed');
    }
  }

  /**
   * Reopen a persisted session without sending input.
   *
   * @param {string} sessionId Persisted session id.
   * @param {AbortSignal} [signal] Abandonment signal.
   * @returns {Promise<Record<string, never>>} `{}` once the session is ready.
   */
  async resume(sessionId, signal) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new TypeError('resume() requires a non-empty sessionId');
    }
    await this.#requireHandshake('session/resume');
    try {
      return await this.#transport.request('session/resume', { sessionId }, signal);
    } catch (error) {
      throw this.#decorate(error, 'session/resume failed');
    }
  }

  /**
   * Block until the session and its managed descendants are idle.
   *
   * Notifications emitted during the wait arrive before the response, so a
   * caller may observe events after the promise settles; use
   * {@link SessionDriver.waitIdle} when event ordering matters.
   *
   * @param {string} sessionId An already created session.
   * @param {AbortSignal} [signal] Abandonment signal.
   * @returns {Promise<Record<string, never>>} `{}` once idle.
   */
  async wait(sessionId, signal) {
    if (typeof sessionId !== 'string') {
      throw new TypeError('wait() requires a sessionId string');
    }
    await this.#requireHandshake('session/wait');
    try {
      return await this.#transport.request('session/wait', { sessionId }, signal);
    } catch (error) {
      throw this.#decorate(error, 'session/wait failed');
    }
  }

  /**
   * @param {string} sessionId Target session; an unknown id is created.
   * @param {AbortSignal} [signal] Abandonment signal.
   * @returns {Promise<{ cwd: string }>} The session's effective directory.
   */
  async getCwd(sessionId, signal) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new TypeError('getCwd() requires a non-empty sessionId');
    }
    await this.#requireHandshake('session/working-directory/get');
    try {
      return await this.#transport.request(
        'session/working-directory/get',
        { sessionId },
        signal,
      );
    } catch (error) {
      throw this.#decorate(error, 'session/working-directory/get failed');
    }
  }

  /**
   * @param {string} sessionId Target session; an unknown id is created.
   * @param {string} path Absolute or current-directory-relative path.
   * @param {AbortSignal} [signal] Abandonment signal.
   * @returns {Promise<{ cwd: string }>} The validated absolute directory.
   */
  async setCwd(sessionId, path, signal) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new TypeError('setCwd() requires a non-empty sessionId');
    }
    if (typeof path !== 'string' || path === '') {
      throw new TypeError('setCwd() requires a non-empty path string');
    }
    await this.#requireHandshake('session/working-directory/set');
    try {
      return await this.#transport.request(
        'session/working-directory/set',
        { sessionId, path },
        signal,
      );
    } catch (error) {
      throw this.#decorate(error, 'session/working-directory/set failed');
    }
  }

  /**
   * Ask the runtime to dispose its agents and exit. The runtime answers, then
   * exits 0 on its own; this method does not kill the process.
   *
   * @param {AbortSignal} [signal] Abandonment signal.
   * @returns {Promise<Record<string, never>>} `{}` when teardown succeeded.
   */
  async shutdown(signal) {
    await this.#requireHandshake('shutdown');
    try {
      return await this.#transport.request('shutdown', undefined, signal);
    } catch (error) {
      throw this.#decorate(error, 'shutdown failed');
    }
  }

  /**
   * Tear down the client locally: detach the transport and terminate the child.
   * Idempotent. Use this when the runtime is unresponsive or a turn must be
   * abandoned — the protocol has no cancel method.
   *
   * @param {{ graceMs?: number }} [options] Wait before the final kill (`SIGKILL` off Windows).
   * @returns {Promise<void>} Resolves once teardown was signalled.
   */
  async close({ graceMs = 2000 } = {}) {
    if (this.#closed) return;
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
      throw new TypeError('close() graceMs must be a non-negative safe integer');
    }
    this.#closed = true;
    this.#unsubscribeTransportErrors();
    this.#transport.close(
      new JsonRpcTransportError('DSH runtime client closed', 'CLIENT_CLOSED'),
    );
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;

    const exited = new Promise((resolve) => this.#child.once('exit', () => resolve(undefined)));
    this.#child.kill();
    const timer = setTimeout(() => {
      if (this.#child.exitCode === null && this.#child.signalCode === null) {
        this.#child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
      }
    }, graceMs);
    // Do not hold the event loop open just for the kill timer.
    if (typeof timer.unref === 'function') timer.unref();
    await exited;
    clearTimeout(timer);
  }

  // ---------------------------------------------------------------- internals

  /**
   * Resolve once the handshake completed, or explain precisely why it did not.
   *
   * @param {string} caller Method name used in the error message.
   * @returns {Promise<void>} Rejects with {@link NotInitializedError}.
   */
  async #requireHandshake(caller) {
    if (this.#serverInfo !== null) return;
    if (this.#closed) {
      throw new NotInitializedError(
        `${caller}() cannot run: the client is closed. Call initialize() on a live client first.`,
      );
    }
    const handshake = this.#handshake;
    if (handshake === null) {
      throw new NotInitializedError(
        `${caller}() requires a completed handshake: call initialize() and await it first ` +
          '(the DSH runtime rejects prompts before initialize).',
      );
    }
    try {
      await handshake;
    } catch (error) {
      throw new NotInitializedError(
        `${caller}() cannot run: the initialize() handshake failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      );
    }
  }

  /**
   * Attach runtime stderr and a stable `stage` marker to a wire or transport
   * error, so a caller can report the failure without extra plumbing.
   *
   * @param {unknown} error Thrown value.
   * @param {string} stage Human-readable stage label.
   * @returns {Error} The same error instance where possible.
   */
  #decorate(error, stage) {
    const normalised = error instanceof Error ? error : new Error(String(error));
    if (normalised instanceof JsonRpcResponseError || normalised instanceof JsonRpcTransportError) {
      if (normalised.stage === undefined) normalised.stage = stage;
      const tail = this.#stderr.toString().trim();
      if (normalised.runtimeStderr === undefined && tail !== '') {
        normalised.runtimeStderr = tail;
      }
      if (normalised instanceof JsonRpcResponseError && normalised.code === undefined) {
        this.#logger.warn?.(`dsh-rpc: ${stage} failed without a wire error code`);
      }
    }
    this.#logger.debug?.(`dsh-rpc: ${stage}: ${normalised.message}`);
    return normalised;
  }

  /**
   * @param {Error} error Failure to publish.
   * @returns {void}
   */
  #emitError(error) {
    for (const handler of [...this.#errorHandlers]) {
      try {
        handler(error);
      } catch (nested) {
        this.#logger.error?.(`dsh-rpc: error handler threw: ${String(nested)}`);
      }
    }
  }
}

/**
 * Raised when a caller asks to cancel a turn, which the protocol cannot do.
 *
 * The DSH SDK protocol deliberately ships **no** cancel and no session-close
 * method: abandoning a turn means terminating the runtime process, which also
 * discards any other session that process owns. This error exists so that
 * limitation surfaces as a typed, documented fact instead of a lie.
 */
export class SessionAbortedError extends Error {
  /**
   * @param {string} message Explanation including the recommended recovery.
   */
  constructor(message) {
    super(message);
    this.name = 'SessionAbortedError';
    /** @type {string} */
    this.code = 'CANCEL_UNSUPPORTED';
    /** @type {boolean} */
    this.cancelled = false;
  }
}
