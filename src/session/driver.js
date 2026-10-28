/**
 * Session driver: one DSH session on top of {@link DshRpcClient}.
 *
 * Responsibilities:
 * - own the session id and the transcript a UI renders;
 * - turn the raw notification stream into normalized events (see
 *   `./events.js`) and fan them out to subscribers;
 * - provide a reliable `waitIdle()` that cannot return before the turn that
 *   triggered it actually finished.
 *
 * `waitIdle()` deliberately combines both signals the runtime offers, because
 * neither alone is sufficient:
 *
 * - `session/wait` answers only after the agent and its managed descendants
 *   are idle, and it rejects if the agent failed without a terminal event. But
 *   its response is not synchronised with the client's event delivery, so on
 *   its own it can resolve before the last `turn/end` was consumed.
 * - `session.status` transitions to `idle` on the same terms but carries no
 *   failure information and can briefly flap.
 *
 * So `waitIdle()` awaits `session/wait` *and* observes the terminal
 * `turn/end` / `status: idle` pair for this session, returning only when the
 * server has confirmed and the client has consumed.
 *
 * ## Cancellation limitation (documented, not worked around)
 *
 * The SDK protocol has **no cancel and no session-close method**. {@link abort}
 * therefore kills the runtime child process and reports
 * `CANCEL_UNSUPPORTED`. It cannot preserve the turn's partial output beyond
 * what was already received, and it destroys every session owned by that
 * process — not just this one. Nothing here pretends otherwise.
 *
 * @module dsh-cli/session/driver
 */

import process from 'node:process';

import { DshRpcClient, SessionAbortedError } from '../rpc/client.js';
import {
  isCompletedTurnEnd,
  isFailedTurnEnd,
  normalizeNotification,
} from './events.js';

/** Default session id prefix; the runtime accepts any non-empty string. */
const DEFAULT_SESSION_PREFIX = 'dsh-cli';
/** Interactive history limit; dropping display state never changes DSH's durable history. */
const DEFAULT_MAX_TRANSCRIPT_ENTRIES = 1000;
/** Max UTF-16 code units retained across transcript text and reasoning fields. */
const DEFAULT_MAX_TRANSCRIPT_CHARS = 2_000_000;

/**
 * Build a fresh session id.
 *
 * The runtime derives session storage from this id, so it must be unique per
 * conversation and filesystem-safe.
 *
 * @param {string} [prefix] Id prefix.
 * @returns {string} A new session id.
 */
export function createSessionId(prefix = DEFAULT_SESSION_PREFIX) {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${stamp}-${random}`;
}

/**
 * One assistant message under construction, used to assemble `transcript`
 * entries from the normalized event stream.
 *
 * @typedef {object} TranscriptEntry
 * @property {'user' | 'assistant' | 'system' | 'tool'} role Message role.
 * @property {string} [id] Stable id when the runtime supplied one.
 * @property {string} text Concatenated visible text.
 * @property {string} reasoning Concatenated reasoning text.
 * @property {{ callId?: string, name?: string, arguments?: unknown }[]} toolCalls
 * @property {{ callId?: string, name?: string, text: string, isError: boolean }[]} toolResults
 * @property {number} [turn] Turn number this entry belongs to.
 * @property {number} [step] Step number this entry belongs to.
 * @property {number} [seq] First sequence number seen for the entry.
 */

/**
 * Drives one DSH session and emits a normalized event stream.
 *
 * @example
 * const driver = await SessionDriver.open({ cwd, provider, model });
 * driver.on('assistant-text', (e) => process.stdout.write(e.text));
 * await driver.send('Reply with exactly: PONG');
 * const result = await driver.waitIdle();
 * await driver.close();
 */
export class SessionDriver {
  /** @type {DshRpcClient} */
  #client;
  /** @type {string} */
  #sessionId;
  /** @type {Map<string, Set<(event: object) => void>>} */
  #listeners = new Map();
  /** @type {() => void} */
  #unsubscribeNotifications = () => {};
  /** @type {() => void} */
  #unsubscribeErrors = () => {};
  /** @type {object[]} */
  #events = [];
  /** @type {TranscriptEntry[]} */
  #transcript = [];
  /** @type {number} */
  #maxEvents;
  /** @type {number} */
  #maxTranscriptEntries;
  /** @type {number} */
  #maxTranscriptChars;
  /** @type {number} */
  #transcriptChars = 0;
  /** @type {number | undefined} */
  #currentTurn;
  /** @type {number | undefined} */
  #currentStep;
  /** @type {boolean} */
  #sawInitialStatus = false;
  /** True between `send()` and the first event of the turn it enqueued. */
  #awaitingTurn = false;
  /** @type {'running' | 'idle' | 'unknown'} */
  #status = 'unknown';
  /** @type {{ resolve: () => void, reject: (e: Error) => void }[]} */
  #idleWaiters = [];
  /** @type {Error | null} */
  #failure = null;
  /** @type {boolean} */
  #closed = false;
  /** @type {string} */
  #lastAssistantText = '';
  /** @type {number} */
  #lastAssistantTextChars = 0;
  /** @type {TranscriptEntry | null} */
  #openAssistant = null;

  /**
   * Use {@link SessionDriver.open}.
   *
   * @param {object} init Resolved wiring.
   * @private
   */
  constructor(init) {
    this.#client = init.client;
    this.#sessionId = init.sessionId;
    this.#maxEvents = init.maxEvents;
    this.#maxTranscriptEntries = init.maxTranscriptEntries;
    this.#maxTranscriptChars = init.maxTranscriptChars;

    const offNotifications = this.#client.onNotification((method, params) => {
      this.#ingest(method, params);
    });
    if (typeof offNotifications === 'function') this.#unsubscribeNotifications = offNotifications;

    // A dead runtime must wake any pending waitIdle() instead of hanging it.
    const offErrors = this.#client.onError((error) => {
      if (this.#closed) return;
      this.#failure = error;
      this.#rejectIdleWaiters(error);
    });
    if (typeof offErrors === 'function') this.#unsubscribeErrors = offErrors;
  }

  /**
   * Spawn a runtime, perform the handshake, and return a ready driver.
   *
   * @param {Parameters<typeof DshRpcClient.spawn>[0] & {
   *   sessionId?: string, maxEvents?: number, maxTranscriptEntries?: number, maxTranscriptChars?: number }} options Spawn options plus
   *   session identity and display-retention controls.
   * @returns {Promise<SessionDriver>} A driver whose handshake completed.
   */
  static async open(options) {
    const client = await DshRpcClient.spawn(options);
    try {
      await client.initialize();
    } catch (error) {
      await client.close();
      throw error;
    }
    return new SessionDriver({
      client,
      sessionId: options.sessionId ?? createSessionId(),
      maxEvents: options.maxEvents ?? 10000,
      maxTranscriptEntries: options.maxTranscriptEntries ?? DEFAULT_MAX_TRANSCRIPT_ENTRIES,
      maxTranscriptChars: options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS,
    });
  }

  /** @returns {string} The session id used on the wire. */
  get sessionId() {
    return this.#sessionId;
  }

  /** @returns {DshRpcClient} The underlying client (for `setCwd`, `stderr`, …). */
  get client() {
    return this.#client;
  }

  /** @returns {'running' | 'idle' | 'unknown'} Last observed whole-agent status. */
  get status() {
    return this.#status;
  }

  /** @returns {boolean} True when the last turn ended normally. */
  get lastTurnCompleted() {
    return this.#lastTurnEnd?.reason?.kind === 'completed';
  }

  /**
   * The retained normalized event list (bounded by `maxEvents`, oldest dropped
   * first). Consumers that need the whole stream should subscribe instead.
   *
   * @returns {readonly object[]} Normalized events in arrival order.
   */
  get events() {
    return this.#events;
  }

  /**
   * The recent display conversation, bounded by entry count and text/reasoning
   * character budget. Older UI entries may be evicted; DSH's durable session
   * history is untouched. Assistant output is delivered in full to subscribers.
   *
   * Role mapping follows the runtime's own message roles: `user/message`
   * becomes `user`, assistant content becomes `assistant`, `system/message`
   * becomes `system`, and tool results are attached to the assistant entry
   * that issued the corresponding call.
   *
   * @returns {readonly TranscriptEntry[]} Entries in arrival order.
   */
  get transcript() {
    return this.#transcript;
  }

  /** @returns {object | undefined} The most recent `turn/end` event. */
  get #lastTurnEnd() {
    if (this.#awaitingTurn || this.#currentTurn === undefined) return undefined;
    for (let index = this.#events.length - 1; index >= 0; index -= 1) {
      const event = this.#events[index];
      if (event.kind === 'turn-end' && event.turn === this.#currentTurn) return event;
    }
    return undefined;
  }

  /**
   * Recent assistant text from the last turn, bounded to maxTranscriptChars.
   * Subscribe to `assistant-text` for the complete stream.
   *
   * @returns {string} Retained text tail, or `''` before the first assistant message.
   */
  get lastAssistantText() {
    return this.#lastAssistantText;
  }

  /**
   * Subscribe to the normalized event stream.
   *
   * `'event'` receives every event; a `kind` (e.g. `'assistant-text'`,
   * `'turn-end'`) receives only matching events. Both fires for one event.
   *
   * @param {string} eventName `'event'`, a kind, or `'error'`.
   * @param {(payload: any) => void} listener Callback.
   * @returns {() => void} Unsubscribe function.
   */
  on(eventName, listener) {
    if (typeof eventName !== 'string' || eventName === '') {
      throw new TypeError('on() requires a non-empty event name');
    }
    if (typeof listener !== 'function') {
      throw new TypeError('on() requires a listener function');
    }
    let set = this.#listeners.get(eventName);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(eventName, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(eventName);
    };
  }

  /**
   * Send a prompt and return the durable enqueue receipt.
   *
   * The returned `messageId` identifies the queued user message only; use
   * {@link waitIdle} for the reply.
   *
   * @param {string} text User text; must be non-empty after trimming.
   * @param {{ signal?: AbortSignal }} [options] Abandonment signal for enqueue.
   * @returns {Promise<{ messageId: string }>} Enqueue receipt.
   */
  async send(text, options = {}) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError('send() requires a non-empty text string');
    }
    this.#ensureOpen('send');
    this.#awaitingTurn = true;
    try {
      return await this.#client.prompt(
        this.#sessionId,
        [{ type: 'text', text }],
        options.signal,
      );
    } catch (error) {
      this.#awaitingTurn = false;
      // Surface the typed cancel limitation rather than a bare AbortError.
      if (options.signal?.aborted === true) {
        throw new SessionAbortedError(
          'the prompt enqueue request was abandoned by its AbortSignal. ' +
            'Note: the runtime may already have accepted the prompt — the protocol has no cancel method.',
        );
      }
      throw error;
    }
  }

  /**
   * Wait until this session is idle and its terminal turn event was consumed.
   *
   * Resolution requires the server's `session/wait` confirmation *and* either a
   * `turn/end` for this session or an `idle` status. A turn that ended in an
   * `error` reason, and an `agent/error` reported by the runtime, both reject.
   *
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   *   Abandonment signal and an optional local timeout (the protocol itself
   *   offers no timeout).
   * @returns {Promise<{ completed: boolean, reason: object | undefined, text: string }>}
   *   A summary of the finished turn. `completed` is `false` when the turn
   *   ended with a non-`completed` reason (`aborted` / `interrupted` / `error`).
   */
  async waitIdle(options = {}) {
    this.#ensureOpen('waitIdle');
    const { signal, timeoutMs } = options;

    if (signal?.aborted === true) {
      throw new SessionAbortedError(
        'waitIdle() was abandoned by its AbortSignal; the turn continues on the runtime ' +
          '(the protocol has no cancel method, so only killing the process stops it).',
      );
    }

    const settled = new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.#idleWaiters.push(waiter);
      if (signal !== undefined) {
        const onAbort = () => {
          const index = this.#idleWaiters.indexOf(waiter);
          if (index >= 0) this.#idleWaiters.splice(index, 1);
          reject(
            new SessionAbortedError(
              'waitIdle() was abandoned by its AbortSignal; the turn continues on the runtime.',
            ),
          );
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
    });
    // This promise is only awaited when the turn needs the terminal event; when
    // the server already confirmed quiescence it is left alone. Marking it
    // handled keeps a later close()/abort() rejection from surfacing as an
    // unhandled rejection, while an `await`/`race` still observes the error.
    settled.catch(() => {});

    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    /** @type {NodeJS.Timeout | undefined} */
    let terminalTimer;
    try {
      const serverSide = this.#client.wait(this.#sessionId, signal);
      if (timeoutMs !== undefined) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
          throw new TypeError('waitIdle() timeoutMs must be a positive safe integer');
        }
        const timeout = new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `waitIdle() timed out after ${timeoutMs} ms; the runtime is still working. ` +
                  'The protocol has no cancel method — call abort() to kill the process.',
              ),
            );
          }, timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        });
        await Promise.race([serverSide, timeout]);
      } else {
        await serverSide;
      }

      // The server confirmed quiescence; also require the terminal event so a
      // caller never observes an idle session before consuming its last turn.
      if (!this.#hasTerminalEvidence()) {
        await Promise.race(
          timeoutMs === undefined
            ? [settled]
            : [
                settled,
                new Promise((_resolve, reject) => {
                  terminalTimer = setTimeout(() => {
                    reject(
                      new Error(
                        `waitIdle() timed out after ${timeoutMs} ms waiting for the terminal session event.`,
                      ),
                    );
                  }, timeoutMs);
                  if (typeof terminalTimer.unref === 'function') terminalTimer.unref();
                }),
              ],
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (terminalTimer !== undefined) clearTimeout(terminalTimer);
      this.#idleWaiters = this.#idleWaiters.filter((waiter) => {
        if (waiter.cleanup !== undefined) waiter.cleanup();
        return false;
      });
    }

    return this.#turnSummary();
  }

  #turnSummary() {
    const turnEnd = this.#lastTurnEnd;
    if (turnEnd === undefined) {
      // `session.status: idle` is a documented terminal signal but carries no
      // reason. Accept it as completion; a session that never reached idle is
      // still an error, so callers cannot mistake a hung turn for success.
      if (this.#status === 'idle') {
        return { completed: true, reason: undefined, text: this.#lastAssistantText };
      }
      throw new Error('the runtime became idle without a terminal turn event');
    }
    if (isFailedTurnEnd(turnEnd)) {
      throw new Error(
        `the turn failed: ${String(turnEnd.reason?.error?.message ?? turnEnd.reason?.kind ?? 'error')}`,
      );
    }
    return {
      completed: isCompletedTurnEnd(turnEnd),
      reason: turnEnd?.reason,
      text: this.#lastAssistantText,
    };
  }

  /**
   * Abandon the current turn by terminating the runtime process.
   *
   * **This is not a graceful cancel.** The SDK protocol ships no cancel and no
   * session-close method, so the only way to stop a running turn is to kill the
   * process. Consequences, all of them real:
   * - every session owned by this runtime dies, not just this one;
   * - the killed turn's terminal event never arrives (`turn/end` appears as
   *   `interrupted` only if the runtime persists it before dying);
   * - the client is unusable afterwards; open a new driver to continue.
   *
   * Prefer recording the limitation over pretending cancellation succeeded.
   *
   * @param {string} [reason] Why the turn is being abandoned.
   * @returns {Promise<never>} Always rejects with {@link SessionAbortedError}.
   */
  async abort(reason = 'user requested cancellation') {
    this.#closed = true;
    this.#unsubscribeNotifications();
    this.#unsubscribeErrors();
    this.#status = 'idle';
    this.#rejectIdleWaiters(
      new SessionAbortedError(`session aborted: ${reason}; the runtime process was terminated`),
    );
    await this.#client.close();
    throw new SessionAbortedError(
      `cannot cancel gracefully: the DSH SDK protocol has no cancel method, so "${reason}" was ` +
        'implemented by terminating the runtime process. Any other session owned by that ' +
        'process is also gone, and the interrupted turn has no completion event. ' +
        'Open a new SessionDriver to continue.',
    );
  }

  /**
   * Close the session: ask the runtime to shut down, then terminate the child.
   * Idempotent. Failure to shut down gracefully is not an error — the process
   * is killed regardless.
   *
   * @returns {Promise<void>} Resolves once the runtime is gone.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeNotifications();
    this.#unsubscribeErrors();
    this.#status = 'idle';
    // A caller still awaiting a turn cannot be given a terminal event once the
    // runtime is gone, so its wait fails loudly; an idle driver has no waiter
    // to fail, which is the common `/quit` path.
    this.#rejectIdleWaiters(new SessionAbortedError('the session driver was closed before the turn finished'));
    try {
      await this.#client.shutdown();
    } catch {
      // A runtime that cannot answer `shutdown` is still killed below.
    }
    await this.#client.close();
  }

  // ---------------------------------------------------------------- internals

  /**
   * @param {string} caller Method name for the error message.
   * @returns {void}
   */
  #ensureOpen(caller) {
    if (this.#closed) {
      throw new Error(`${caller}() cannot run: this SessionDriver is closed`);
    }
    if (this.#failure !== null) {
      throw new Error(`${caller}() cannot run: the runtime failed (${this.#failure.message})`);
    }
  }

  /**
   * Whether the client has consumed a terminal fact for the current turn.
   *
   * @returns {boolean} True when a `turn/end` or an `idle` status was seen.
   */
  #hasTerminalEvidence() {
    if (this.#awaitingTurn) return false;
    return this.#lastTurnEnd !== undefined || this.#status === 'idle';
  }

  /**
   * Route one notification into the normalized stream.
   *
   * @param {string} method Notification method.
   * @param {Record<string, unknown>} params Notification params.
   * @returns {void}
   */
  #ingest(method, params) {
    if (this.#closed) return;

    const events = normalizeNotification(method, params, {
      filterSessionId: this.#sessionId,
    });
    for (const event of events) this.#dispatch(event);

    this.#maybeResolveIdle();
  }

  /**
   * Apply one normalized event to the transcript and listeners.
   *
   * @param {object} event A normalized event.
   * @returns {void}
   */
  #dispatch(event) {
    if (event.sessionId !== undefined && event.sessionId !== this.#sessionId) return;

    if (event.kind === 'turn-start') {
      this.#awaitingTurn = false;
      this.#status = 'running';
    }

    if (event.turn !== undefined && event.turn !== this.#currentTurn) {
      this.#currentTurn = event.turn;
      // A new turn starts a fresh assistant accumulator.
      this.#lastAssistantText = '';
      this.#lastAssistantTextChars = 0;
    }
    if (event.step !== undefined) this.#currentStep = event.step;

    this.#remember(event);
    this.#applyToTranscript(event, event);

    // Order matters: an 'event' subscriber sees the event before kind-specific
    // subscribers, mirroring the documented fan-out order.
    this.#emit('event', event);
    this.#emit(event.kind, event);
  }

  /**
   * Push into the bounded event list.
   *
   * @param {object} event A normalized event.
   * @returns {void}
   */
  #remember(event) {
    this.#events.push(event);
    if (this.#events.length > this.#maxEvents) {
      this.#events.splice(0, this.#events.length - this.#maxEvents);
    }
  }

  /**
   * Update `transcript` from one normalized event.
   *
   * Tool results are folded into an assistant entry rather than appended as a
   * standalone role, because a terminal transcript reads as one assistant turn
   * with its tool activity, not a second speaker.
   *
   * @param {object} event The normalized event.
   * @param {object} _raw Reserved for future raw-payload access.
   * @returns {void}
   */
  #applyToTranscript(event, _raw) {
    switch (event.kind) {
      case 'user': {
        this.#appendTranscriptEntry({
          role: 'user',
          id: event.messageId,
          text: event.text ?? '',
          reasoning: '',
          toolCalls: [],
          toolResults: [],
          turn: event.turn,
          step: event.step,
          seq: event.seq,
        });
        break;
      }

      case 'assistant-text':
      case 'assistant-reasoning': {
        const entry = this.#currentAssistantEntry(event);
        if (event.kind === 'assistant-text') {
          const text = event.text ?? '';
          this.#appendEntryText(entry, 'text', text);
          this.#lastAssistantText += text;
          this.#lastAssistantTextChars += text.length;
          if (this.#lastAssistantTextChars > this.#maxTranscriptChars) {
            const overflow = this.#lastAssistantTextChars - this.#maxTranscriptChars;
            this.#lastAssistantText = this.#lastAssistantText.slice(overflow);
            this.#lastAssistantTextChars = this.#maxTranscriptChars;
          }
        } else {
          this.#appendEntryText(entry, 'reasoning', event.text ?? '');
        }
        break;
      }

      case 'tool-call': {
        // A standalone `tool/call` event owns its own entry; a tool-call block
        // inside an assistant message attaches to that message's entry.
        const entry = this.#currentAssistantEntry(event);
        entry.toolCalls.push({
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
        });
        break;
      }

      case 'tool-result': {
        const entry = this.#currentAssistantEntry(event);
        entry.toolResults.push({
          callId: event.callId,
          name: event.name,
          text: event.text ?? '',
          isError: event.isError === true,
        });
        break;
      }

      case 'system': {
        this.#appendTranscriptEntry({
          role: 'system',
          id: event.messageId,
          text: event.text ?? '',
          reasoning: '',
          toolCalls: [],
          toolResults: [],
          turn: event.turn,
          step: event.step,
          seq: event.seq,
        });
        break;
      }

      case 'turn-end': {
        // Close the open assistant entry so the next turn starts a new one.
        this.#openAssistant = null;
        break;
      }

      default:
        // turn/step boundaries, titles and unknown events add no transcript row.
        break;
    }
  }

  /**
   * The assistant entry new content should append to, created on demand.
   *
   * @param {object} event Event supplying turn/step/seq metadata.
   * @returns {TranscriptEntry} The open entry.
   */
  #currentAssistantEntry(event) {
    if (this.#openAssistant !== null) return this.#openAssistant;
    /** @type {TranscriptEntry} */
    const entry = {
      role: 'assistant',
      text: '',
      reasoning: '',
      toolCalls: [],
      toolResults: [],
      turn: event.turn,
      step: event.step,
      seq: event.seq,
    };
    this.#appendTranscriptEntry(entry);
    this.#openAssistant = entry;
    return entry;
  }

  /**
   * Append a display entry and evict old entries until the entry/text budget fits.
   * The open assistant entry is never evicted while it is being assembled; in
   * that case its older text is clipped from the front to preserve recent view.
   * Full assistant text is still emitted to subscribers and one-shot output uses
   * its own complete stream collector.
   *
   * @param {TranscriptEntry} entry Entry to append.
   * @returns {void}
   */
  #appendTranscriptEntry(entry) {
    this.#transcript.push(entry);
    this.#transcriptChars += entry.text.length + entry.reasoning.length;
    this.#boundTranscript();
  }

  /** @param {TranscriptEntry} entry @param {'text'|'reasoning'} field @param {string} chunk */
  #appendEntryText(entry, field, chunk) {
    entry[field] += chunk;
    this.#transcriptChars += chunk.length;
    this.#boundTranscript();
  }

  #boundTranscript() {
    while (this.#transcript.length > this.#maxTranscriptEntries ||
      this.#transcriptChars > this.#maxTranscriptChars) {
      const oldest = this.#transcript[0];
      if (this.#transcript.length > this.#maxTranscriptEntries) {
        const evicted = this.#transcript.shift();
        if (evicted === this.#openAssistant) this.#openAssistant = null;
        this.#transcriptChars -= evicted.text.length + evicted.reasoning.length;
        continue;
      }
      if (oldest === this.#openAssistant && this.#transcript.length === 1) {
        // A single huge current message is bounded while retaining its tail.
        const excess = this.#transcriptChars - this.#maxTranscriptChars;
        const textDrop = Math.min(excess, oldest.text.length);
        if (textDrop > 0) {
          oldest.text = oldest.text.slice(textDrop);
          this.#transcriptChars -= textDrop;
        }
        const reasoningDrop = Math.min(this.#transcriptChars - this.#maxTranscriptChars, oldest.reasoning.length);
        if (reasoningDrop > 0) {
          oldest.reasoning = oldest.reasoning.slice(reasoningDrop);
          this.#transcriptChars -= reasoningDrop;
        }
      } else {
        this.#transcript.shift();
        this.#transcriptChars -= oldest.text.length + oldest.reasoning.length;
      }
    }
    if (this.#transcript.length === 0) this.#openAssistant = null;
  }

  /**
   * Update status and settle idle waiters once this session looks finished.
   *
   * @returns {void}
   */
  #maybeResolveIdle() {
    const last = this.#events[this.#events.length - 1];
    if (last === undefined) return;
    if (this.#awaitingTurn) return;

    if (last.kind === 'turn-end') {
      this.#resolveIdleWaiters();
      return;
    }

    if (last.kind === 'status') {
      if (!this.#sawInitialStatus && last.status === 'running') {
        // The first `running` for a fresh session is the prompt echo; ignore it
        // as a terminal signal source but record it.
        this.#sawInitialStatus = true;
      }
      this.#status = last.status === 'running' || last.status === 'idle' ? last.status : 'unknown';
      if (last.status === 'idle') this.#resolveIdleWaiters();
      return;
    }

    if (this.#status === 'idle' && this.#hasTerminalEvidence()) {
      this.#resolveIdleWaiters();
    }
  }

  /** @returns {void} */
  #resolveIdleWaiters() {
    if (this.#idleWaiters.length === 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const waiter of waiters) {
      if (waiter.cleanup !== undefined) waiter.cleanup();
      waiter.resolve();
    }
  }

  /**
   * @param {Error} error Reason to hand every waiter.
   * @returns {void}
   */
  #rejectIdleWaiters(error) {
    if (this.#idleWaiters.length === 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const waiter of waiters) {
      if (waiter.cleanup !== undefined) waiter.cleanup();
      waiter.reject(error);
    }
  }

  /**
   * Fan one event out to a named channel.
   *
   * @param {string} name Channel name.
   * @param {object} event The event payload.
   * @returns {void}
   */
  #emit(name, event) {
    const set = this.#listeners.get(name);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (error) {
        // A broken subscriber must not stop the session from running.
        process.emitWarning(
          `dsh-cli: listener for "${name}" threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
