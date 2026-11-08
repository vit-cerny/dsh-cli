/**
 * Streaming transcript renderer for the dsh-cli TUI (task T3).
 *
 * Design goals, in priority order:
 *
 * 1. **Low overhead.** Assistant prose is *appended* character by character as
 *    it arrives; the renderer never repaints the transcript. Only one "live"
 *    row is redrawn (the streaming marker / spinner), and only when colour is
 *    on and the stream is a TTY.
 * 2. **Zero dependency.** No ink/blessed; every escape code comes from
 *    `./ansi.js` and every box is drawn with `./text.js` helpers.
 * 3. **Testable without a TTY.** The renderer writes through whatever stream
 *    it is given, so a fake sink captures an exact snapshot. With colour off
 *    the output is byte-for-byte plain text.
 *
 * The renderer consumes the *normalized* event contract owned by T2
 * (`src/session/events.js` → `{ kind, seq, turn, step, ... }`) and makes no
 * assumptions about transport: `tool-call` carries `tool` + `input`,
 * `tool-result` carries `tool` + `output` + `isError`.
 *
 * @module src/ui/renderer
 */

import process from 'node:process';
import { CLEAR_LINE, clearLineSequence } from './ansi.js';
import { createTheme, toolStatusVisual } from './theme.js';
import {
  displayWidth,
  formatDuration,
  padToWidth,
  truncateToWidth,
  wrapText,
} from './text.js';

/** Default number of tool-result lines kept visible (the T3 spec value). */
export const FOLD_LINES = 8;

/**
 * Shorten a one-line summary of a tool input, the way `● Bash(npm test)` reads.
 *
 * @param {unknown} input Tool input object (or string).
 * @returns {string} Compact one-line summary.
 */
export function summarizeToolInput(input) {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim();
  if (typeof input !== 'object') return String(input);
  const record = /** @type {Record<string, unknown>} */ (input);
  const priority = [
    'command',
    'cmd',
    'file_path',
    'path',
    'pattern',
    'query',
    'url',
    'description',
    'prompt',
    'name',
    'task',
  ];
  for (const field of priority) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) {
      return value.replace(/\s+/g, ' ').trim();
    }
  }
  const keys = Object.keys(record);
  if (keys.length === 0) return '';
  try {
    return JSON.stringify(record);
  } catch {
    return keys.join(', ');
  }
}

/** Collapse a tool result into displayable lines without holding duplicates. */
function outputLines(output) {
  if (output === null || output === undefined) return [];
  let text;
  if (typeof output === 'string') {
    text = output;
  } else if (Array.isArray(output)) {
    text = output.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n');
  } else if (typeof output === 'object') {
    const record = /** @type {Record<string, unknown>} */ (output);
    text =
      typeof record.text === 'string'
        ? record.text
        : typeof record.output === 'string'
          ? record.output
          : JSON.stringify(record, null, 2);
  } else {
    text = String(output);
  }
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  return normalized.length === 0 ? [] : normalized.split('\n');
}

let toolCounter = 0;

/**
 * The transcript renderer.
 */
export class Renderer {
  /**
   * @param {object} [options]
   * @param {NodeJS.WriteStream|{ write(chunk: string): boolean }} [options.stdout] Output sink.
   * @param {boolean} [options.color] Force colour on/off (else auto-detect).
   * @param {number} [options.columns] Force width (else `stdout.columns`).
   * @param {number} [options.foldLines] Visible result lines before folding.
   * @param {number} [options.indent] Prefix width for wrapped lines.
   * @param {Record<string, string|undefined>} [options.env] Env for colour detection.
   * @param {boolean} [options.showReasoning] Stream chain-of-thought (default off:
   *   reasoning models emit a lot of it and it buries the answer).
   */
  constructor({
    stdout = process.stdout,
    color,
    columns,
    foldLines = FOLD_LINES,
    indent = 2,
    env = process.env,
    showReasoning,
  } = {}) {
    this.stdout = stdout;
    this.theme = createTheme({ color, stream: stdout, env });
    this.foldLines = Math.max(1, Math.trunc(foldLines) || FOLD_LINES);
    this.indent = Math.max(0, Math.trunc(indent));
    this.fixedColumns = Number.isFinite(columns) ? columns : null;
    // Thinking is shown by default: watching the agent reason is how you tell
    // a slow turn from a stuck one. `DSH_CLI_REASONING=0` hides it again for
    // anyone who wants a quiet transcript.
    this.showReasoning =
      typeof showReasoning === 'boolean'
        ? showReasoning
        : !(env.DSH_CLI_REASONING === '0' || env.DSH_CLI_REASONING === 'false');
    /** Echo the runtime's system prompt (off by default; it is not chat). */
    this.showSystem = env.DSH_CLI_SHOW_SYSTEM === '1' || env.DSH_CLI_SHOW_SYSTEM === 'true';

    this.meta = {
      model: '',
      sessionId: '',
      cwd: '',
      tokens: null,
      provider: '',
    };
    this.state = {
      busy: false,
      /** True while assistant text is mid-stream (adds a trailing marker). */
      streaming: false,
      aborted: false,
      turn: 0,
      turnStartedAt: 0,
      lastTurnMs: 0,
      error: '',
    };
    /** Tool cards in emission order; also rendered incrementally. */
    this.tools = [];
    /** Fold state per tool card id. `expanded` overrides the default. */
    this.folds = { expanded: false };
    /** Tracks whether the last byte written ended with a newline. */
    this.atLineStart = true;
    /** Set once anything has been written (used to decide on separators). */
    this.wroteAnything = false;
    this.onWidthChange = null;
    this._resizeHandler = null;
  }

  /** Effective render width in columns. */
  get columns() {
    if (this.fixedColumns) return Math.max(20, this.fixedColumns);
    const streamColumns = Number(this.stdout?.columns);
    if (Number.isFinite(streamColumns) && streamColumns > 0) {
      return Math.max(20, Math.min(400, Math.trunc(streamColumns)));
    }
    return 80;
  }

  /** Whether escape codes are being emitted. */
  get colorEnabled() {
    return this.theme.color;
  }

  /** Whether the sink is a terminal (live rows are safe). */
  get interactive() {
    return Boolean(this.stdout?.isTTY);
  }

  /**
   * Track a stream `resize` event and notify the owner so it can repaint the
   * prompt/status chrome. The transcript itself needs no repaint: it was
   * already wrapped to the old width.
   *
   * @param {number|((columns: number) => void)} handler Callback or columns.
   * @returns {() => void} Unsubscribe.
   */
  watchResize(handler) {
    const cb = typeof handler === 'function' ? handler : () => {};
    this.onWidthChange = cb;
    if (typeof this.stdout?.on !== 'function') return () => {};
    this._resizeHandler = () => cb(this.columns);
    this.stdout.on('resize', this._resizeHandler);
    return () => {
      if (typeof this.stdout?.removeListener === 'function' && this._resizeHandler) {
        this.stdout.removeListener('resize', this._resizeHandler);
      }
      this._resizeHandler = null;
    };
  }

  // ---------------------------------------------------------------- plumbing

  /**
   * Write raw text straight to the sink.
   *
   * @param {string} chunk Text.
   * @returns {void}
   */
  write(chunk) {
    if (!chunk) return;
    this.stdout.write(chunk);
    this.wroteAnything = true;
    this.atLineStart = chunk.endsWith('\n');
  }

  /** Ensure the cursor sits at the start of a fresh line. */
  ensureNewline() {
    if (!this.atLineStart) this.write('\n');
    // Any block-level writer terminates an in-progress streamed line.
    this.inAssistantLine = false;
  }

  /** Erase the current (uncommitted) row; used by the live status line. */
  clearRow() {
    if (!this.interactive) return;
    this.write(`${clearLineSequence()}`);
  }

  // ------------------------------------------------------------------- meta

  /**
   * Set status-line metadata. Pass `null`/`undefined` values to clear fields.
   *
   * @param {{ model?: string, sessionId?: string, cwd?: string, tokens?: number|null, provider?: string }} patch
   * @returns {void}
   */
  setMeta(patch = {}) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      this.meta[key] = value === null && key !== 'tokens' ? '' : value;
    }
  }

  /** Prose/assistant decimation: keep only the tail of very long sessions. */
  get busy() {
    return this.state.busy;
  }

  // --------------------------------------------------------------- banners

  /**
   * Print the startup banner.
   *
   * @param {{ version?: string, model?: string, cwd?: string, sessionId?: string }} [info]
   */
  banner(info = {}) {
    const { style, glyph } = this.theme;
    if (info.version) this.setMeta({ model: info.model, cwd: info.cwd, sessionId: info.sessionId });
    this.ensureNewline();
    // Two compact lines, the Claude Code / opencode shape: what this is and
    // which model on the first, where it runs on the second. The key hints live
    // behind /help so the conversation starts immediately instead of under a
    // wall of chrome.
    const model = info.model === undefined || info.model === '' ? '' : `${style.muted(glyph.bullet)} ${style.info(String(info.model))}`;
    this.write(`${style.bold('dsh-cli')} ${style.muted(`v${info.version ?? '0.0.0'}`)}${model === '' ? '' : ` ${model}`}\n`);
    if (info.cwd !== undefined && info.cwd !== '') {
      this.write(`${style.muted(truncateToWidth(String(info.cwd), this.columns))}\n`);
    }
    this.write('\n');
  }

  // ---------------------------------------------------------------- events

  /**
   * Render one normalized session event.
   *
   * @param {{ kind: string, [key: string]: any }} event Normalized event from T2.
   * @returns {void}
   */
  handle(event) {
    if (!event || typeof event !== 'object') return;
    switch (event.kind) {
      case 'turn-start':
        return this.turnStart(event);
      case 'turn-end':
        return this.turnEnd(event);
      case 'assistant-text':
        return this.assistantText(event.text);
      case 'assistant-reasoning':
        return this.assistantReasoning(event.text);
      case 'tool-call':
        return this.toolCall(event);
      case 'tool-result':
        return this.toolResult(event);
      case 'user':
        return this.userMessage(event.text);
      case 'system': {
        // The runtime echoes its whole system prompt as a `system/message`
        // on the first turn. That is not conversation, and printing it would
        // bury the answer, so long payloads are dropped unless the user asked
        // to see them (`DSH_CLI_SHOW_SYSTEM=1`). Short notices still render.
        const value = String(event.text ?? event.message ?? '').trim();
        if (value === '') return undefined;
        if (value.length > 400) {
          if (!this.showSystem) return undefined;
          return this.systemMessage(`system prompt (${value.length} chars)`);
        }
        return this.systemMessage(value);
      }
      case 'status':
        return this.status(event.status);
      case 'title':
        return this.setMeta({});
      case 'step-start':
      case 'step-end':
      case 'unknown':
      default:
        return undefined;
    }
  }

  /**
   * A new turn started: flush, print the turn rule, start the timer.
   *
   * @param {{ turn?: number }} [event]
   */
  turnStart(event = {}) {
    this.ensureNewline();
    this.state.busy = true;
    this.state.aborted = false;
    this.state.error = '';
    this.state.turn = Number(event.turn) || this.state.turn + 1;
    this.state.turnStartedAt = Date.now();
    this.state.streaming = false;
    this.tools = [];
    this.folds.expanded = false;
  }

  /**
   * Turn finished (completed, aborted, or failed).
   *
   * @param {{ reason?: { kind?: string }, turn?: number }} [event]
   */
  turnEnd(event = {}) {
    this.ensureNewline();
    this.state.busy = false;
    this.state.streaming = false;
    if (this.state.turnStartedAt) {
      this.state.lastTurnMs = Date.now() - this.state.turnStartedAt;
    }
    const reason = event.reason && typeof event.reason === 'object' ? event.reason.kind : event.reason;
    if (reason && reason !== 'completed') {
      this.systemMessage(`turn ended: ${reason}`, { tone: reason === 'aborted' ? 'warn' : 'error' });
    }
  }

  /**
   * Streaming assistant prose. Appends in place: no repaint, no bubble frame.
   *
   * @param {string} text Delta or full chunk of assistant text.
   */
  assistantText(text) {
    const value = String(text ?? '');
    if (!value) return;
    this.state.busy = true;
    this.state.streaming = true;
    // Only the *first* delta of a message may open a new line; later deltas
    // must append to the row already in progress (that is the whole point of
    // streaming instead of repainting).
    if (!this.inAssistantLine) {
      this.ensureNewline();
      this.inAssistantLine = true;
    }
    this.write(value);
    if (value.endsWith('\n')) this.inAssistantLine = false;
  }

  /**
   * Reasoning / chain-of-thought. Rendered dim and only when the viewer opted
   * in, so it never competes with the answer.
   *
   * @param {string} text Reasoning delta.
   */
  assistantReasoning(text) {
    this.rendered = this.rendered || { reasoning: 0 };
    const value = String(text ?? '');
    if (!value) return;
    if (!this.showReasoning) {
      // Dim chain-of-thought is noise by default; count it so `/help` can say
      // how much was hidden without buffering the text itself.
      this.rendered.reasoning += value.length;
      return;
    }
    this.ensureNewline();
    this.write(this.theme.style.reasoning(value));
    this.state.streaming = true;
  }

  /**
   * A human turn, echoed for transcript completeness.
   *
   * @param {string} text Message text.
   */
  userMessage(text) {
    const value = String(text ?? '').trim();
    if (!value) return;
    this.ensureNewline();
    const { style, glyph } = this.theme;
    const [first, ...rest] = value.split('\n');
    this.write(`${style.user(`${glyph.arrow} `)}${truncateToWidth(first, this.columns - 2)}\n`);
    for (const line of rest) this.write(`${style.muted(`  ${truncateToWidth(line, this.columns - 2)}`)}\n`);
  }

  /**
   * System notice (errors, hints, aborts).
   *
   * @param {string} text Message.
   * @param {{ tone?: 'info'|'warn'|'error' }} [options]
   */
  systemMessage(text, { tone = 'info' } = {}) {
    const value = String(text ?? '').trim();
    if (!value) return;
    this.ensureNewline();
    const { style, glyph } = this.theme;
    const marker =
      tone === 'error' ? glyph.cross : tone === 'warn' ? glyph.warn : glyph.bullet;
    const painter = tone === 'error' ? style.failure : tone === 'warn' ? style.running : style.muted;
    for (const [index, line] of wrapText(value, this.columns - 2).entries()) {
      this.write(`${painter(index === 0 ? `${marker} ` : '  ')}${painter(line)}\n`);
    }
  }

  /**
   * Whole-agent status transitions (`running` / `idle`).
   *
   * @param {string} status Status label from the driver.
   */
  status(status) {
    const value = String(status ?? '');
    if (!value) return;
    if (value === 'running') {
      this.state.busy = true;
      return;
    }
    if (value === 'idle') {
      this.state.busy = false;
      this.state.streaming = false;
      this.ensureNewline();
    }
  }

  // ------------------------------------------------------------------- tools

  /**
   * Register + render a tool call card.
   *
   * Accepts both the normalized field names (`tool`/`input`/`callId`) that
   * `src/session/events.js` emits and the pre-normalization aliases
   * (`name`/`args`/`id`), so either contract renders a card.
   *
   * @param {{ tool?: string, name?: string, input?: unknown, args?: unknown,
   *   id?: string, toolCallId?: string, callId?: string }} event
   * @returns {{ id: string, tool: string, status: string }}
   */
  toolCall(event = {}) {
    this.ensureNewline();
    const tool = String(event.tool ?? event.name ?? 'tool');
    const id = String(event.id ?? event.callId ?? event.toolCallId ?? `tool-${++toolCounter}`);
    // The runtime reports one call twice: as a block in the assistant message
    // and again as a standalone `tool/call`. Keep one card per call id.
    const existing = this.tools.find((item) => item.id === id);
    if (existing) return existing;
    const card = {
      id,
      tool,
      input: event.input ?? event.arguments,
      summary: summarizeToolInput(event.input ?? event.args ?? event.arguments),
      status: 'running',
      output: null,
      isError: false,
      startedAt: Date.now(),
      durationMs: null,
    };
    this.tools.push(card);
    this.state.busy = true;
    this.write(`${this.renderToolHead(card)}\n`);
    return card;
  }

  /**
   * Bind a result to its card and render the (possibly folded) output.
   *
   * @param {{ tool?: string, name?: string, output?: unknown, isError?: boolean,
   *   id?: string, callId?: string, toolCallId?: string }} event
   * @returns {object|null} The updated card, or null when nothing matched.
   */
  toolResult(event = {}) {
    this.ensureNewline();
    const id = event.id ?? event.callId ?? event.toolCallId;
    const tool = event.tool ?? event.name;
    let card = null;
    if (id !== undefined) card = this.tools.find((item) => item.id === String(id)) ?? null;
    if (!card && tool !== undefined) {
      // Match the newest still-running card with the same tool name.
      for (let i = this.tools.length - 1; i >= 0; i -= 1) {
        if (this.tools[i].tool === String(tool) && this.tools[i].status === 'running') {
          card = this.tools[i];
          break;
        }
      }
    }
    if (!card) {
      // Unpaired result (e.g. resumed session): render a standalone card.
      card = {
        id: String(id ?? `tool-${++toolCounter}`),
        tool: String(tool ?? 'tool'),
        summary: '',
        status: event.isError ? 'error' : 'success',
        output: event.output ?? event.text ?? event.content,
        isError: Boolean(event.isError),
        startedAt: Date.now(),
        durationMs: null,
      };
      this.tools.push(card);
      this.write(`${this.renderToolHead(card)}\n`);
    } else {
      card.status = event.isError ? 'error' : 'success';
      card.output = event.output ?? event.text ?? event.content;
      card.isError = Boolean(event.isError);
      card.durationMs = Date.now() - card.startedAt;
      // Re-print the head so the status glyph changes colour in place.
      if (this.interactive && this.theme.color) {
        this.clearRow();
      }
      this.write(`${this.renderToolHead(card)}\n`);
    }
    this.renderToolBody(card);
    return card;
  }

  /**
   * The `● Bash(npm test)  ✓ 1.2s` head line.
   *
   * @param {object} card Tool card.
   * @returns {string} Styled, width-clipped head line.
   */
  renderToolHead(card) {
    const { style, glyph } = this.theme;
    const visual = toolStatusVisual(this.theme, card.status);
    const summary = card.summary ? `(${card.summary})` : '';
    const label = `${card.tool}${summary}`;
    const suffixParts = [];
    if (card.status === 'success') suffixParts.push(glyph.check);
    if (card.status === 'error') suffixParts.push(visual.label);
    if (card.durationMs !== null && card.durationMs !== undefined) {
      suffixParts.push(style.muted(formatDuration(card.durationMs)));
    }
    const suffix = suffixParts.length ? `  ${suffixParts.join(' ')}` : '';
    const budget = Math.max(8, this.columns - 2 - displayWidth(suffix) - 1);
    const head = `${visual.style(visual.glyph)} ${style.tool(truncateToWidth(label, budget))}`;
    return `${head}${suffix}`;
  }

  /**
   * Render a tool result body, folded to `foldLines` unless expanded.
   *
   * @param {object} card Tool card.
   * @returns {string[]} Lines written.
   */
  renderToolBody(card) {
    const lines = outputLines(card.output);
    if (lines.length === 0) return [];
    const { style, glyph } = this.theme;
    const expanded = Boolean(this.folds.expanded);
    const limit = expanded ? lines.length : Math.min(lines.length, this.foldLines);
    const indent = ' '.repeat(this.indent);
    const written = [];
    const painter = card.isError ? style.failure : style.muted;
    for (let i = 0; i < limit; i += 1) {
      const wrapped = wrapText(lines[i], Math.max(8, this.columns - this.indent));
      for (const piece of wrapped) {
        const line = `${indent}${painter(piece)}`;
        this.write(`${line}\n`);
        written.push(line);
      }
    }
    const hidden = lines.length - limit;
    if (hidden > 0) {
      const hint = `${indent}${style.muted(
        `${glyph.foldHint} ${hidden} more line${hidden === 1 ? '' : 's'} — Ctrl+O to expand`,
      )}`;
      this.write(`${hint}\n`);
      written.push(hint);
    } else if (expanded && lines.length > this.foldLines) {
      const hint = `${indent}${style.muted(`${glyph.foldHint} expanded — Ctrl+O to collapse`)}`;
      this.write(`${hint}\n`);
      written.push(hint);
    }
    return written;
  }

  /**
   * Toggle result folding (Ctrl+O).
   *
   * @returns {boolean} New expanded flag.
   */
  toggleFold() {
    this.folds.expanded = !this.folds.expanded;
    this.ensureNewline();
    const state = this.folds.expanded ? 'expanded' : 'collapsed';
    this.systemMessage(`tool output ${state}`, { tone: 'info' });
    return this.folds.expanded;
  }

  // ---------------------------------------------------------------- status

  /**
   * One-line status bar: model, session, cwd, tokens, turn timing, live state.
   *
   * @param {{ tokens?: number|null }} [patch]
   * @returns {string} Styled status line (un-clipped, caller decides).
   */
  statusLine(patch = {}) {
    if (patch.tokens !== undefined) this.meta.tokens = patch.tokens;
    const { style } = this.theme;
    const parts = [];
    if (this.meta.model) parts.push(style.statusValue(this.meta.model));
    if (this.meta.sessionId) {
      const short = String(this.meta.sessionId);
      parts.push(style.muted(`session ${short.length > 12 ? `${short.slice(0, 12)}…` : short}`));
    }
    if (this.meta.cwd) parts.push(style.muted(shortenPath(this.meta.cwd, 28)));
    if (Number.isFinite(Number(this.meta.tokens)) && this.meta.tokens !== null) {
      parts.push(style.muted(`${this.meta.tokens} tok`));
    }
    if (this.state.lastTurnMs) parts.push(style.muted(formatDuration(this.state.lastTurnMs)));
    const stateLabel = this.state.aborted
      ? style.failure('interrupted')
      : this.state.busy
        ? style.running('thinking…')
        : style.muted('idle');
    parts.push(stateLabel);
    return truncateToWidth(parts.join(style.muted(' · ')), this.columns);
  }

  /**
   * Print an explicit abort notice. The JSON-RPC protocol has no cancel
   * method, so the only honest wording is that the session process died.
   */
  noticeAborted() {
    this.state.aborted = true;
    this.state.busy = false;
    this.state.streaming = false;
    this.ensureNewline();
    this.systemMessage('已中断（会话进程已终止 / session process terminated）', { tone: 'warn' });
  }

  // ------------------------------------------------------------------ misc

  /**
   * Render a plain block of text (used by slash commands).
   *
   * @param {string} text Pre-formatted text; wrapped to width.
   * @param {{ style?: 'plain'|'muted'|'info' }} [options]
   */
  block(text, { style: tone = 'plain' } = {}) {
    const value = String(text ?? '');
    if (!value) return;
    this.ensureNewline();
    const painter =
      tone === 'muted'
        ? this.theme.style.muted
        : tone === 'info'
          ? this.theme.style.info
          : (line) => String(line);
    for (const logical of value.replace(/\r\n?/g, '\n').split('\n')) {
      for (const line of wrapText(logical, this.columns)) {
        this.write(`${painter(line)}\n`);
      }
    }
  }

  /** Blank spacer line, collapsing repeats. */
  spacer() {
    if (!this.atLineStart) this.write('\n');
    else if (!this._lastWasBlank) this.write('\n');
    this._lastWasBlank = true;
  }
}

/**
 * Middle-elide an absolute path so the status bar stays one line.
 *
 * @param {string} value Path.
 * @param {number} max Maximum columns.
 * @returns {string} Shortened path.
 */
export function shortenPath(value, max = 32) {
  const text = String(value ?? '');
  if (displayWidth(text) <= max) return text;
  const parts = text.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return truncateToWidth(text, max);
  const tail = parts.slice(-2).join('/');
  const candidate = `…/${tail}`;
  return displayWidth(candidate) <= max ? candidate : truncateToWidth(candidate, max);
}

export { CLEAR_LINE, padToWidth };
