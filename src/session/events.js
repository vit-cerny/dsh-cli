/**
 * Normalization of DSH `SessionEvent`s into the flat event shape the UI layer
 * consumes (task T3 depends on this contract — treat it as stable).
 *
 * Three rules govern this module:
 *
 * 1. **Pass-through, never a whitelist.** The runtime's event vocabulary is
 *    large (`KNOWN_SESSION_EVENT_TYPES` has 60+ members) and grows with
 *    installed plugins. An unrecognized `type` becomes `{ kind: 'unknown',
 *    type }` and keeps its payload — dropping it would silently hide future
 *    runtime capability from the UI.
 * 2. **One input event may yield many normalized events.** `assistant/message`
 *    carries a content array; each block becomes its own event so a renderer
 *    can stream text, reasoning and tool calls through one channel.
 * 3. **Payload shapes are verified, not guessed.** Every field read below was
 *    confirmed against real persisted session logs and live protocol traffic.
 *
 * Wire shape (verified):
 *   `{ type, seq, time, data }`
 *   - `turn/start`, `step/start`, `step/end` → `data.turn`, `data.step`
 *   - `turn/end` → `data.turn`, `data.reason.kind` (`completed` | `error` |
 *     `aborted` | `interrupted`); an `error` reason may carry `data.reason.error`
 *   - `user/message` → `data.content[]`, `data.id`, `data.role`, `data.source`
 *   - `assistant/message` → `data.message.content[]` (+ `data.usage`, `data.stream`)
 *   - `tool/call` → `data.callId`, `data.name`, `data.arguments` (JSON string);
 *     the assistant content block form is `{ type: 'tool-call', id, name, arguments }`
 *   - `tool/result` → `data.message.toolCallId`, `data.message.content[]`
 *   - `system/message` → `data.message.content[]`
 *   - `session/title` → `data.title`, `data.messageSeqs`, `data.source`
 *
 * @module dsh-cli/session/events
 */

/**
 * Every `kind` this normalizer can emit.
 *
 * @typedef {'turn-start' | 'turn-end' | 'step-start' | 'step-end'
 *   | 'assistant-text' | 'assistant-reasoning' | 'tool-call' | 'tool-result'
 *   | 'user' | 'system' | 'status' | 'title' | 'unknown'} EventKind
 */

/** @type {ReadonlySet<string>} */
export const EVENT_KINDS = new Set([
  'turn-start',
  'turn-end',
  'step-start',
  'step-end',
  'assistant-text',
  'assistant-reasoning',
  'tool-call',
  'tool-result',
  'user',
  'system',
  'status',
  'title',
  'unknown',
]);

/**
 * Convenience predicates for consumers that must distinguish a turn ending
 * normally from one that failed or was abandoned.
 *
 * @param {object | null | undefined} event A normalized event.
 * @returns {boolean} True when this is a `turn-end` with `reason.kind === 'completed'`.
 */
export function isCompletedTurnEnd(event) {
  return event?.kind === 'turn-end' && event.reason?.kind === 'completed';
}

/**
 * Whether a turn ended in a way that should surface as a failure.
 * `aborted` and `interrupted` are also terminal, but not errors.
 *
 * @param {object | null | undefined} event A normalized event.
 * @returns {boolean} True for a `turn-end` whose reason kind is `error`.
 */
export function isFailedTurnEnd(event) {
  return event?.kind === 'turn-end' && event.reason?.kind === 'error';
}

/**
 * @param {unknown} value Candidate object.
 * @returns {value is Record<string, any>} True for a non-array object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read the first present number among candidates, for both `number` and
 * numeric-string wires.
 *
 * @param {...unknown} candidates Values to test in order.
 * @returns {number | undefined} The first finite number, else `undefined`.
 */
function firstNumber(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string' && candidate !== '') {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Extract readable text from a single content block.
 *
 * @param {Record<string, any>} block A content block.
 * @returns {string} Text, or `''` when the block carries none.
 */
function blockText(block) {
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .filter((part) => isRecord(part) && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  return '';
}

/**
 * Concatenate the readable text of every `text` block in a content array.
 *
 * Kept separate from {@link normalizeContentBlocks} so that a `user` or
 * `system` message can surface its text without borrowing the assistant-facing
 * `assistant-text` kind.
 *
 * @param {unknown} content The `content` array, if any.
 * @returns {string} Joined text of all text blocks; `''` when there are none.
 */
function contentText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'text') continue;
    const text = blockText(block);
    if (text !== '') parts.push(text);
  }
  return parts.join('');
}

/**
 * Split a content array into normalized events.
 *
 * The `role` decides the fallback kind, so an unrecognized block inside an
 * assistant message is still attributable to the assistant rather than dropped.
 *
 * @param {unknown} content The `content` array.
 * @param {object} base Fields shared by every emitted event.
 * @returns {object[]} One event per recognized block; unknown blocks are
 *   emitted as `kind: 'unknown'` with their block type preserved.
 */
function normalizeContentBlocks(content, base) {
  if (!Array.isArray(content)) return [];
  /** @type {object[]} */
  const out = [];

  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = typeof block.type === 'string' ? block.type : '';

    switch (type) {
      case 'text': {
        const text = blockText(block);
        // An empty text block carries no information a renderer can use.
        if (text === '') continue;
        out.push({ ...base, kind: 'assistant-text', text });
        break;
      }
      case 'reasoning': {
        const text = blockText(block);
        if (text === '') continue;
        out.push({ ...base, kind: 'assistant-reasoning', text });
        break;
      }
      case 'tool-call': {
        // The assistant block uses `id`; the standalone `tool/call` event uses
        // `callId`. Both are accepted so either source renders identically.
        const callId = block.id ?? block.callId ?? block.toolCallId;
        out.push({
          ...base,
          kind: 'tool-call',
          callId: typeof callId === 'string' ? callId : undefined,
          name: typeof block.name === 'string' ? block.name : undefined,
          arguments: block.arguments,
          blockType: type,
        });
        break;
      }
      case 'tool-result': {
        const callId = block.toolCallId ?? block.id;
        out.push({
          ...base,
          kind: 'tool-result',
          callId: typeof callId === 'string' ? callId : undefined,
          name: typeof block.name === 'string' ? block.name : undefined,
          text: blockText(block),
          isError: block.isError === true || block.is_error === true,
          blockType: type,
        });
        break;
      }
      default: {
        // Unknown block: keep it whole. `tool-addition` / `tool-removal` and
        // any future block type flow through here rather than vanishing.
        out.push({
          ...base,
          kind: 'unknown',
          type: type === '' ? 'unknown-block' : type,
          source: 'content-block',
          block,
        });
      }
    }
  }

  return out;
}

/**
 * Normalize one raw `SessionEvent`.
 *
 * Always returns an array (possibly empty for events that intentionally add no
 * UI fact, such as `step/start` for a step that carries no new information —
 * see the individual cases) so callers can treat every input uniformly.
 *
 * @param {unknown} raw A raw `SessionEvent` (`{ type, seq, time, data }`).
 * @param {{ sessionId?: string }} [context] Extra fields stamped on every event.
 * @returns {object[]} Zero or more normalized events, in document order.
 */
export function normalizeEvent(raw, context = {}) {
  if (!isRecord(raw)) {
    return [
      {
        kind: 'unknown',
        type: 'malformed',
        seq: undefined,
        turn: undefined,
        step: undefined,
        time: undefined,
        sessionId: context.sessionId,
        raw,
      },
    ];
  }

  const type = typeof raw.type === 'string' ? raw.type : 'unknown';
  const seq = firstNumber(raw.seq);
  const time = firstNumber(raw.time);
  const data = isRecord(raw.data) ? raw.data : {};

  // Shared envelope fields; `raw` is retained for pass-through so a renderer
  // can reach anything this normalizer does not surface as a first-class field.
  const base = {
    seq,
    turn: firstNumber(data.turn),
    step: firstNumber(data.step),
    time,
    sessionId: context.sessionId,
    rawType: type,
    raw,
  };

  switch (type) {
    case 'turn/start':
      return [{ ...base, kind: 'turn-start' }];

    case 'turn/end':
      return [
        {
          ...base,
          kind: 'turn-end',
          reason: isRecord(data.reason) ? data.reason : undefined,
          usage: data.usage,
        },
      ];

    case 'step/start':
      return [{ ...base, kind: 'step-start' }];

    case 'step/end':
      return [{ ...base, kind: 'step-end', usage: data.usage }];

    case 'assistant/message': {
      const message = isRecord(data.message) ? data.message : {};
      const source = isRecord(message.source) ? message.source : {};
      return normalizeContentBlocks(message.content, base).map((event) => ({
        ...event,
        messageId: typeof message.id === 'string' ? message.id : undefined,
        model: typeof source.model === 'string' ? source.model : undefined,
        provider: typeof source.provider === 'string' ? source.provider : undefined,
        usage: data.usage,
      }));
    }

    case 'tool/call':
      return [
        {
          ...base,
          kind: 'tool-call',
          callId: typeof data.callId === 'string' ? data.callId : undefined,
          name: typeof data.name === 'string' ? data.name : undefined,
          arguments: data.arguments,
        },
      ];

    case 'tool/result': {
      const message = isRecord(data.message) ? data.message : {};
      const callId = message.toolCallId ?? data.callId;
      return [
        {
          ...base,
          kind: 'tool-result',
          callId: typeof callId === 'string' ? callId : undefined,
          name: typeof data.name === 'string' ? data.name : undefined,
          text: contentText(message.content),
          content: message.content,
          isError: data.isError === true || message.isError === true,
          usage: data.usage,
        },
      ];
    }

    case 'user/message':
      return [
        {
          ...base,
          kind: 'user',
          messageId: typeof data.id === 'string' ? data.id : undefined,
          content: Array.isArray(data.content) ? data.content : [],
          text: contentText(data.content),
          source: data.source,
        },
      ];

    case 'system/message': {
      const message = isRecord(data.message) ? data.message : {};
      return [
        {
          ...base,
          kind: 'system',
          messageId: typeof message.id === 'string' ? message.id : undefined,
          content: Array.isArray(message.content) ? message.content : [],
          text: contentText(message.content),
        },
      ];
    }

    case 'session/title':
      return [
        {
          ...base,
          kind: 'title',
          title: typeof data.title === 'string' ? data.title : '',
          messageSeqs: Array.isArray(data.messageSeqs) ? data.messageSeqs : [],
          source: data.source,
        },
      ];

    default:
      // Everything else — including events this build predates — is passed
      // through with its original type so the UI can decide what to render.
      return [{ ...base, kind: 'unknown', type }];
  }
}

/**
 * Normalize a `session.status` notification (a different wire family from
 * `session.event`: it is a notification payload, not a SessionEvent).
 *
 * @param {unknown} params The notification params (`{ sessionId, status }`).
 * @returns {object} A `kind: 'status'` event.
 */
export function normalizeStatus(params) {
  const record = isRecord(params) ? params : {};
  const status = typeof record.status === 'string' ? record.status : 'unknown';
  return {
    kind: status === 'running' || status === 'idle' ? 'status' : 'unknown',
    status,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
    seq: undefined,
    turn: undefined,
    step: undefined,
    rawType: 'session.status',
    raw: record,
  };
}

/**
 * Normalize any server→client notification into zero or more events.
 *
 * `session.event` fans out through {@link normalizeEvent}; `session.status`
 * becomes a `status` event; subagent lifecycle notifications are surfaced as
 * `unknown` with their method as `type` (the UI may present them, but they are
 * not part of the transcript contract).
 *
 * @param {string} method Notification method name.
 * @param {unknown} params Notification params.
 * @param {{ sessionId?: string, filterSessionId?: string }} [context] Extra
 *   fields, plus an optional session filter that drops foreign sessions.
 * @returns {object[]} Zero or more normalized events.
 */
export function normalizeNotification(method, params, context = {}) {
  const record = isRecord(params) ? params : {};

  if (method === 'session.event') {
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
    if (context.filterSessionId !== undefined && sessionId !== context.filterSessionId) return [];
    return normalizeEvent(record.event, {
      sessionId,
      ...(context.sessionId === undefined ? {} : { contextSessionId: context.sessionId }),
    });
  }

  if (method === 'session.status') {
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
    if (context.filterSessionId !== undefined && sessionId !== context.filterSessionId) return [];
    return [normalizeStatus(record)];
  }

  // subagent.started / subagent.finished / anything a future runtime adds.
  return [{ kind: 'unknown', type: method, seq: undefined, turn: undefined, step: undefined, params: record }];
}
