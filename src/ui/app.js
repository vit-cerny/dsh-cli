/**
 * Application shell for the dsh-cli TUI (task T3).
 *
 * Wires four pieces together and owns nothing else:
 *   `Renderer` (transcript) + `InputController`/`Editor` (prompt) +
 *   `CommandRegistry` (slash commands) + an injected **session driver**.
 *
 * The driver is a constructor argument and is never imported, so this file
 * cannot break when T2 lands late, and every test can pass a fake one. Only
 * the documented contract is used:
 *
 *   await driver.send(text) -> messageId
 *   await driver.waitIdle()
 *   driver.abort()
 *   driver.on('event', cb) / driver.on(kind, cb)
 *   driver.transcript
 *
 * @module src/ui/app
 */

import process from 'node:process';
import readline from 'node:readline';
import { clearLineSequence, CLEAR_SCREEN } from './ansi.js';
import { createCommandRegistry } from './commands.js';
import { Editor } from './editor.js';
import { InputController } from './input.js';
import { actionForKey, KEYS } from './keymap.js';
import { Renderer } from './renderer.js';
import { formatBytes } from '../session/resources.js';
import { formatCost } from '../session/usage.js';
import { createTheme } from './theme.js';
import { Toolbar } from './toolbar.js';

/**
 * Normalize the two subscription shapes the driver contract allows into one
 * callback. Returns a disposer so the app can detach on exit.
 *
 * @param {object} driver Session driver (real or fake).
 * @param {(event: object) => void} onEvent Event sink.
 * @returns {() => void} Unsubscribe.
 */
export function subscribeDriver(driver, onEvent) {
  if (!driver || typeof driver.on !== 'function') return () => {};
  const disposers = [];
  if (typeof driver.off === 'function') {
    const handler = (event) => onEvent(event);
    driver.on('event', handler);
    disposers.push(() => driver.off('event', handler));
  } else if (typeof driver.removeListener === 'function') {
    const handler = (event) => onEvent(event);
    driver.on('event', handler);
    disposers.push(() => driver.removeListener('event', handler));
  } else {
    const unsubscribe = driver.on('event', onEvent);
    if (typeof unsubscribe === 'function') disposers.push(unsubscribe);
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore: teardown must not throw */
      }
    }
  };
}

/**
 * The TUI application.
 */
export class App {
  /**
   * @param {object} options Options.
   * @param {object} options.driver Session driver exposing the T2 contract.
   * @param {NodeJS.WriteStream} [options.stdout] Output stream.
   * @param {NodeJS.ReadStream} [options.stdin] Input stream.
   * @param {boolean} [options.color] Force colour on/off.
   * @param {number} [options.columns] Force render width.
   * @param {boolean} [options.interactive] Force raw-mode prompt on/off.
   * @param {string} [options.version] Version shown in the banner.
   * @param {{ model?: string, cwd?: string, sessionId?: string }} [options.meta] Initial metadata.
   * @param {object[]} [options.extraCommands] Extra slash commands registered on top
   *   of the built-ins (used by `src/cli/` for `/sessions`).
   */
  constructor({
    driver,
    stdout = process.stdout,
    stdin = process.stdin,
    color,
    columns,
    interactive,
    version = '0.0.1',
    meta = {},
    extraCommands = [],
  } = {}) {
    this.driver = driver ?? null;
    this.stdout = stdout;
    this.stdin = stdin;
    this.version = version;
    this.color = color;
    this.exitCode = 0;
    this.closed = false;
    /** @type {((name: string) => Promise<void>) | undefined} Swap the driver for a new route. */
    this.onSetModel = meta.setModel;

    this.renderer = new Renderer({ stdout, color, columns, env: process.env });
    if (Number.isFinite(columns)) this.renderer.fixedColumns = columns;
    this.renderer.setMeta({
      model: meta.model ?? '',
      cwd: meta.cwd ?? '',
      sessionId: meta.sessionId ?? '',
    });

    this.theme = createTheme({ color: this.renderer.colorEnabled, stream: stdout });
    this.editor = new Editor();
    this.interactive = typeof interactive === 'boolean' ? interactive : Boolean(stdin?.isTTY && stdout?.isTTY);
    // The toolbar is the top row. Created here rather than by the caller so every
    // construction path (tests, `run`, `resume`) gets the same chrome.
    this.toolbar = new Toolbar({
      width: this.renderer.columns,
      theme: this.theme,
      interactive: this.interactive,
    });
    /** @type {import('../session/usage.js').UsageMeter | null} */
    this.meter = meta.usageMeter ?? null;
    /** @type {import('../session/resources.js').ResourceSampler | null} */
    this.resources = meta.resources ?? null;
    /** Message ids whose usage was already counted; bounded because ids are few per turn. */
    this.countedUsage = new Set();
    this.suggestions = [];
    this.suggestionIndex = -1;
    this.lastAbortAt = 0;
    this.pendingTurn = null;
    /** @type {Promise<void> | null} Settles when the submitted turn finishes. */
    this.currentTurn = null;

    this.commands = createCommandRegistry({
      model: () => this.renderer.meta.model || '(unknown)',
      cwd: () => this.renderer.meta.cwd || process.cwd(),
      setModel: meta.setModel,
      listModels: meta.listModels,
      clear: () => {
        this.stdout.write(CLEAR_SCREEN);
        if (this.input) this.input.drawnRows = 0;
      },
      quit: () => this.requestQuit(),
      extra: extraCommands,
    });

    this.unsubscribe = () => {};
    this.input = null;
    this._resolve = null;
    this.done = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  /** Current prompt text. */
  get promptText() {
    return this.editor.text;
  }

  // ------------------------------------------------------------------ setup

  /**
   * Mount the UI: banner, driver subscription, prompt (or a line loop when the
   * stream is not a terminal), resize handling.
   *
   * @returns {Promise<{ exitCode: number }>} Resolves when the app quits.
   */
  async run() {
    this.renderer.banner({
      version: this.version,
      model: this.renderer.meta.model,
      cwd: this.renderer.meta.cwd,
      sessionId: this.renderer.meta.sessionId,
    });
    this.paintToolbar();
    this.resources?.start?.();

    this.unsubscribe = subscribeDriver(this.driver, (event) => this.onEvent(event));

    if (this.interactive) {
      this.input = new InputController({
        editor: this.editor,
        stdin: this.stdin,
        stdout: this.stdout,
        onAction: (key, payload) => this.onKey(key, payload),
        hints: () => ({ columns: this.renderer.columns }),
      });
      this.input.start();
      this.refreshHint();
      this.unwatchResize = this.renderer.watchResize(() => {
        this.toolbar.width = this.renderer.columns;
        if (this.input) {
          this.input.drawnRows = 0;
          this.input.render();
        }
        this.paintToolbar();
      });
    } else {
      await this.runLineLoop();
    }

    return this.done;
  }

  /**
   * Current toolbar values.
   *
   * Everything is derived from state the app already holds; nothing here reads
   * the clock or the filesystem, so a repaint is cheap enough to run per event.
   *
   * @returns {object} Toolbar model (see `src/ui/toolbar.js`).
   */
  toolbarModel() {
    const totals = this.meter?.totals ?? null;
    const snapshot = this.resources?.snapshot ?? null;
    const rss = snapshot?.totalRss ?? snapshot?.clientRss ?? null;
    return {
      sessionTitle: this.renderer.meta.sessionTitle ?? this.shortSessionId(),
      sessions: this.sessionCount,
      provider: this.renderer.meta.provider ?? '',
      model: this.renderer.meta.model ?? '',
      tokens: totals === null ? null : totals.inputTokens + totals.outputTokens,
      cost: totals === null ? null : formatCost(totals.costUsd, totals.priced),
      rss: rss === null ? null : formatBytes(rss),
      status: this.renderer.state.aborted
        ? 'error'
        : this.renderer.busy
          ? 'busy'
          : 'idle',
    };
  }

  /** Short label for the active session, used until a title arrives. */
  shortSessionId() {
    const id = String(this.renderer.meta.sessionId ?? '');
    return id === '' ? '' : id.length > 12 ? `${id.slice(0, 12)}…` : id;
  }

  /**
   * Repaint the toolbar row in place.
   *
   * Only a terminal gets a live row: writing it into a pipe would duplicate it
   * into every redirected log.
   *
   * @returns {void}
   */
  paintToolbar() {
    if (!this.interactive) return;
    const row = this.toolbar.render(this.toolbarModel());
    if (row === '') return;
    this.stdout.write(`${clearLineSequence()}\r${row}\n`);
  }

  /**
   * Non-interactive mode: read one prompt per line, print results as they
   * arrive. This is what makes the UI usable in a pipe and snapshottable in
   * tests without a TTY.
   *
   * @returns {Promise<void>}
   */
  async runLineLoop() {
    const rl = readline.createInterface({ input: this.stdin, crlfDelay: Infinity, terminal: false });
    this.lineInterface = rl;
    try {
      for await (const line of rl) {
        const text = String(line ?? '');
        if (this.closed) break;
        await this.submit(text);
        // A piped session has no prompt to return to: finish the turn (or a
        // slash command's work) before reading the next line, so output is
        // complete and ordered rather than racing process exit.
        if (this.currentTurn !== null) {
          await this.currentTurn;
          this.currentTurn = null;
        }
      }
    } finally {
      this.lineInterface = null;
    }
    if (!this.closed) await this.requestQuit();
  }

  // ----------------------------------------------------------------- events

  /**
   * Route a normalized driver event to the renderer, keeping app-level state
   * (busy flag, prompt repaint) in sync.
   *
   * @param {object} event Normalized event.
   */
  onEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.kind === 'user') {
      // `submit()` echoes the prompt locally, immediately. The runtime's
      // `user/message` event is not equivalent: it also carries injected
      // system reminders and resumed history, which are not the user speaking.
      return;
    }
    const wasBusy = this.renderer.busy;
    // A tool card / new turn starts a block of output: blank the prompt first
    // so driver text is not interleaved into the middle of the input box.
    if (this.input && (event.kind === 'turn-start' || event.kind === 'tool-call') && this.input.drawnRows) {
      this.input.erase();
    }
    // One assistant message fans out to one event per content block, and every
    // one of them carries the same usage record. Recording per event would
    // multiply the token count by the number of blocks, so record per message id.
    if (event.usage !== undefined && event.usage !== null) {
      const key = event.messageId ?? `${event.seq}`;
      if (this.meter !== null && !this.countedUsage.has(key)) {
        this.countedUsage.add(key);
        this.meter.record(event.usage);
      }
    }
    this.renderer.handle(event);
    if (event.kind === 'turn-end') {
      this.renderer.ensureNewline();
      this.renderer.block(this.renderer.statusLine(), { style: 'plain' });
      this.paintToolbar();
    }
    if (wasBusy !== this.renderer.busy && this.input) {
      this.input.drawnRows = 0;
      this.input.render();
      this.paintToolbar();
    }
  }

  // ------------------------------------------------------------------- keys

  /**
   * Handle one decoded key.
   *
   * @param {string} key Key name from `keymap.KEYS`.
   * @param {string} [payload] Text payload for `text`/`paste`.
   */
  onKey(key, payload) {
    const suggestionOpen = this.suggestions.length > 0;
    const action = actionForKey(key, {
      busy: this.renderer.busy,
      suggestionOpen,
      atFirstLine: this.editor.state.row === 0,
      atLastLine: this.editor.state.row === this.editor.state.lines.length - 1,
    });
    this.act(action, { key, payload });
  }

  /**
   * Apply an editor/UI action. Exposed so tests can drive the app without keys.
   *
   * @param {string} action Action name from `actionForKey`.
   * @param {{ payload?: string }} [data] Extra data.
   */
  act(action, { payload } = {}) {
    switch (action) {
      case 'insert':
      case 'paste':
        this.editor.insert(payload ?? '');
        break;
      case 'newline':
        this.editor.newline();
        break;
      case 'caret-left':
        this.editor.move('left');
        break;
      case 'caret-right':
        this.editor.move('right');
        break;
      case 'caret-up':
        this.editor.move('up');
        break;
      case 'caret-down':
        this.editor.move('down');
        break;
      case 'caret-home':
        this.editor.move('home');
        break;
      case 'caret-end':
        this.editor.move('end');
        break;
      case 'backspace':
        this.editor.backspace();
        break;
      case 'delete':
        this.editor.deleteForward();
        break;
      case 'kill-line-start':
        this.editor.killToLineStart();
        break;
      case 'kill-line-end':
        this.editor.killToLineEnd();
        break;
      case 'kill-word':
        this.editor.killWordBefore();
        break;
      case 'history-prev':
        this.editor.browseHistory(-1);
        break;
      case 'history-next':
        this.editor.browseHistory(1);
        break;
      case 'accept-suggestion':
        this.acceptSuggestion();
        break;
      case 'suggestion-prev':
        this.moveSuggestion(-1);
        break;
      case 'suggestion-next':
        this.moveSuggestion(1);
        break;
      case 'dismiss-suggestion':
        this.suggestions = [];
        this.suggestionIndex = -1;
        break;
      case 'toggle-fold':
        this.renderer.toggleFold();
        break;
      case 'clear-screen':
        this.stdout.write(CLEAR_SCREEN);
        if (this.input) this.input.drawnRows = 0;
        break;
      case 'abort':
        this.abort();
        break;
      case 'interrupt':
        this.interrupt();
        break;
      case 'quit':
        this.requestQuit();
        return;
      case 'noop':
      default:
        break;
    }
    this.refreshHint();
    if (this.input) this.input.render();
  }

  /** Accept the highlighted slash-command suggestion. */
  acceptSuggestion() {
    const picked = this.suggestions[this.suggestionIndex] ?? this.suggestions[0];
    if (!picked) return;
    this.editor.setText(`/${picked.name} `);
    this.suggestions = [];
    this.suggestionIndex = -1;
  }

  /** Move the suggestion highlight. */
  moveSuggestion(delta) {
    if (this.suggestions.length === 0) return;
    const count = this.suggestions.length;
    this.suggestionIndex = (((this.suggestionIndex + delta) % count) + count) % count;
  }

  /**
   * Recompute the suggestion menu + hint line from the current prompt.
   *
   * @returns {void}
   */
  refreshHint() {
    const text = this.editor.text;
    const singleLine = !text.includes('\n');
    const isCommand = singleLine && text.startsWith('/');
    const body = isCommand ? text.slice(1) : '';
    if (isCommand && !body.includes(' ')) {
      this.suggestions = this.commands.suggest(body);
      if (this.suggestionIndex >= this.suggestions.length) this.suggestionIndex = -1;
    } else {
      this.suggestions = [];
      this.suggestionIndex = -1;
    }
    if (this.input) {
      this.input.setHint(this.renderHint());
    }
  }

  /**
   * Build the hint line drawn under the prompt box.
   *
   * @returns {string} Hint text (may be empty).
   */
  renderHint() {
    const { style } = this.theme;
    if (this.suggestions.length === 0) return '';
    const rows = this.suggestions.map((entry, index) => {
      const label = `/${entry.name}`;
      const text = `${label.padEnd(9)} ${style.muted(entry.summary)}`;
      return index === this.suggestionIndex ? style.selected(text) : `  ${text}`;
    });
    return rows.join('\n');
  }

  // ---------------------------------------------------------------- actions

  /**
   * Submit the current prompt (or a supplied line).
   *
   * @param {string} [text] Text to submit; defaults to the prompt content.
   * @returns {Promise<void>}
   */
  async submit(text) {
    const raw = text === undefined ? this.editor.text : String(text ?? '');
    const value = raw.replace(/\s+$/, '');
    this.editor.clear();
    this.suggestions = [];
    this.suggestionIndex = -1;
    if (this.input) {
      this.input.setHint('');
      this.input.render();
    }
    if (!value.trim()) return;

    this.editor.commitHistory(value);

    if (value.trimStart().startsWith('/')) {
      const result = await this.commands.dispatch(value.trim(), {
        renderer: this.renderer,
        app: this,
        driver: this.driver,
        registry: this.commands,
        model: this.renderer.meta.model,
        cwd: this.renderer.meta.cwd,
      });
      if (result.action === 'quit') this.requestQuit();
      return;
    }

    if (!this.driver || typeof this.driver.send !== 'function') {
      this.renderer.systemMessage('no session driver attached — cannot send a prompt', { tone: 'error' });
      return;
    }

    this.renderer.userMessage(value);
    try {
      const messageId = await this.driver.send(value);
      this.pendingTurn = messageId ?? null;
      this.renderer.state.busy = true;
      // Do not block the prompt: the transcript arrives via events. Tracking
      // idle in the background keeps the status line honest without gating.
      // `currentTurn` lets the piped line loop await the reply before exiting.
      this.currentTurn = Promise.resolve(this.driver.waitIdle?.())
        .then(() => {
          this.renderer.state.busy = false;
        })
        .catch(() => {
          this.renderer.state.busy = false;
        });
      void this.currentTurn;
    } catch (error) {
      this.renderer.systemMessage(`send failed: ${error?.message ?? error}`, { tone: 'error' });
    }
  }

  /**
   * Abort the running turn. The JSON-RPC protocol has **no cancel method**, so
   * this kills the session process and says so, rather than pretending the turn
   * was gracefully cancelled.
   *
   * @returns {boolean} True when an abort was issued.
   */
  abort() {
    if (!this.renderer.busy) return false;
    try {
      // abort() always rejects by design (the protocol has no cancel), so the
      // rejection is expected here and must not become an unhandled rejection.
      const pending = this.driver?.abort?.();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (error) {
      this.renderer.systemMessage(`abort failed: ${error?.message ?? error}`, { tone: 'error' });
    }
    this.renderer.noticeAborted();
    this.lastAbortAt = Date.now();
    if (this.input) {
      this.input.drawnRows = 0;
      this.input.render();
    }
    void this.requestQuit();
    return true;
  }

  /**
   * Ctrl+C when idle: first press warns, a second press within 2s quits —
   * the familiar "don't lose my drafts" behaviour.
   *
   * @returns {void}
   */
  interrupt() {
    if (this.editor.isEmpty) {
      this.requestQuit();
      return;
    }
    if (Date.now() - this.lastAbortAt < 2000) {
      this.requestQuit();
      return;
    }
    this.lastAbortAt = Date.now();
    this.editor.clear();
    this.suggestions = [];
    this.suggestionIndex = -1;
    this.renderer.systemMessage('prompt cleared — press Ctrl+C again to quit', { tone: 'warn' });
    if (this.input) {
      this.input.drawnRows = 0;
      this.input.render();
    }
  }

  /**
   * Tear down and resolve the run promise.
   *
   * @param {number} [code] Exit code.
   * @returns {Promise<void>}
   */
  async requestQuit(code = 0) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    try {
      this.unsubscribe();
    } catch {
      /* teardown is best-effort */
    }
    this.input?.stop();
    this.unwatchResize?.();
    this.lineInterface?.close();
    // Close the runtime here so a standalone `runApp` cannot leak a child.
    // The owner may call close() again; SessionDriver.close is idempotent.
    try {
      await this.driver?.close?.();
    } catch {
      /* teardown is best-effort */
    }
    this.renderer.ensureNewline();
    this.renderer.block('bye', { style: 'muted' });
    this._resolve?.({ exitCode: this.exitCode });
  }
}

/**
 * Convenience entry point used by `src/main.js` (T8) and by the tests.
 *
 * @param {object} options Same options as {@link App}, `driver` required.
 * @returns {Promise<{ exitCode: number }>} Resolves when the UI exits.
 */
export async function runApp(options = {}) {
  const app = new App(options);
  return app.run();
}

/** Re-exported so callers do not have to reach into `./keymap.js`. */
export { KEYS, actionForKey, clearLineSequence };
