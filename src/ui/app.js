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
import { clearLineSequence, CLEAR_SCREEN, cursor } from './ansi.js';
import { createCommandRegistry } from './commands.js';
import { Editor } from './editor.js';
import { FullScreenView, TranscriptSink } from './fullscreen.js';
import { InputController } from './input.js';
import { actionForKey, KEYS } from './keymap.js';
import { Renderer } from './renderer.js';
import { formatBytes } from '../session/resources.js';
import { formatCost } from '../session/usage.js';
import { createTheme } from './theme.js';
import { PickerHost, renderModelPicker, renderPicker } from './model-picker.js';
import { TOOLBAR_TABS, Toolbar, renderTabBar } from './toolbar.js';

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
    /** Driver hooks; kept so palette actions can reach them after construction. */
    this.meta = meta;

    /**
     * Searchable model and session pickers. One host so `Tab`, `Enter`, `Esc`
     * and typing mean the same thing whichever list is open.
     */
    this.pickers = new PickerHost({
      listModels: () => {
        try {
          return meta.listAllModels?.() ?? meta.listModels?.() ?? [];
        } catch {
          return [];
        }
      },
      currentModel: () => `${this.renderer.meta.provider ?? ''}/${this.renderer.meta.model ?? ''}`,
      onModel: (id) => {
        if (typeof meta.setModel === 'function') void meta.setModel(id);
        else this.renderer.block(`switch with: /model ${id}`, { style: 'muted' });
        this.repaintPicker();
      },
      listSessions: meta.listSessions ?? (() => []),
      onSession: (id) => {
        if (typeof meta.onResumeSession === 'function') void meta.onResumeSession(id);
        else this.renderer.block(`resume with: dsh-cli resume ${id}`, { style: 'muted' });
      },
      onPalette: (choice) => this.applyPalette(choice),
    });

    this.commands = createCommandRegistry({
      model: () => this.renderer.meta.model || '(unknown)',
      cwd: () => this.renderer.meta.cwd || process.cwd(),
      setModel: meta.setModel,
      listModels: meta.listModels,
      openModelPicker: () => this.openPicker('model'),
      openSessionPicker: () => this.openPicker('session'),
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
    // Startup banner, then the pinned block. The banner scrolls away with the
    // conversation; the tab bar and status line stay at the bottom because the
    // prompt block owns them.
    this.renderer.banner({
      version: this.version,
      model: this.renderer.meta.model,
      cwd: this.renderer.meta.cwd,
      sessionId: this.renderer.meta.sessionId,
    });
    if (!this.interactive) this.paintToolbar();
    this.resources?.start?.();

    this.unsubscribe = subscribeDriver(this.driver, (event) => this.onEvent(event));

    if (this.interactive) {
      // Fixed frame: toolbar pinned at the top, transcript scrolling between,
      // prompt and status pinned at the bottom. The renderer writes into the
      // frame's transcript sink instead of straight to the terminal.
      const sink = new TranscriptSink({ columns: this.renderer.columns });
      this.view = new FullScreenView({
        stdout: this.stdout,
        sink,
        theme: this.theme,
        columns: () => this.renderer.columns,
        rows: () => Number(this.stdout.rows) || 24,
      });
      this.renderer.stdout = sink;
      this.view.start();
      this.input = new InputController({
        editor: this.editor,
        stdin: this.stdin,
        stdout: this.stdout,
        onAction: (key, payload) => this.onKey(key, payload),
        hints: () => ({ columns: this.renderer.columns }),
        // The frame paints; the controller only decodes keys.
        detached: true,
      });
      this.input.start();
      this.refreshHint();
      this.repaint();
      this.unwatchResize = this.renderer.watchResize(() => {
        this.toolbar.width = this.renderer.columns;
        this.repaint();
      });
    } else {
      await this.runLineLoop();
    }

    return this.done;
  }

  /**
   * Move the tab bar highlight and redraw that one row.
   *
   * The tab bar is the first row of the terminal, so it is repainted with an
   * absolute move instead of a full redraw: a full redraw would push the
   * conversation down the screen on every Tab press.
   *
   * @param {number} delta Tabs to move, wrapping at both ends.
   * @returns {void}
   */
  moveTab(delta) {
    const count = TOOLBAR_TABS.length;
    const next = (((this.toolbarTab ?? 0) + delta) % count + count) % count;
    this.toolbarTab = next;
    // Tab puts the keyboard on the bar, which is what lets the next Enter open
    // that tab instead of submitting the (empty) prompt.
    this.toolbarFocused = true;    if (!this.interactive) return;
    // The bar is redrawn as part of the prompt block rather than by seeking to
    // row 1: in a scrollback UI the block owns the rows above the caret, and
    // jumping to the top rewinds it from the wrong line.
    this.repaint();
  }

  /**
   * Run the command a tab stands for.
   *
   * @param {number} index Tab index.
   * @returns {void}
   */
  openTab(index) {
    // The sessions and model tabs open their pickers; the rest run their
    // command, so a tab and the slash command can never disagree.
    if (index === 0) {
      this.openPicker('session');
      return;
    }
    if (index === 4) {
      this.openPicker('model');
      return;
    }
    const command = ['/sessions', '/cwd', '/plugins', '/skills', '/model'][index];
    if (command === undefined) return;
    void this.submit(command);
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
   * Status-bar segments, most important first.
   *
   * Styled here rather than in the toolbar so a narrow terminal drops segments
   * from the end instead of clipping the row.
   *
   * @returns {string[]} Pre-styled segments.
   */
  statusSegments() {
    const model = this.toolbarModel();
    const tokens = model.tokens === null ? null : `${model.tokens} tok`;
    return [
      `${model.status === 'busy' ? '●' : model.status === 'error' ? '✗' : '○'} ${model.status}`,
      model.model === '' ? '' : model.model,
      tokens ?? '',
      model.cost ?? '',
      model.rss ?? '',
    ].filter((segment) => segment !== '');
  }

  /**
   * Paint one frame: toolbar at the top, transcript scrolling in the middle,
   * prompt and status bar pinned at the bottom.
   *
   * @returns {void}
   */
  repaint() {
    if (this.view === null || this.view === undefined) return;
    const width = this.renderer.columns;
    this.view.paint({
      editor: this.editor.snapshot(),
      hint: this.hintRows(),
      status: this.statusSegments(),      header: [
        renderTabBar({ width, active: this.toolbarTab ?? 0, theme: this.theme }),
        this.theme.style.muted('─'.repeat(Math.max(1, width))),
      ],
      busy: this.renderer.busy,
    });
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
      this.input.erase(); // detached: no-op
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
    if (event.kind === 'turn-end') this.renderer.ensureNewline();
    // Every event lands in the transcript sink, so the frame has to be repainted
    // for the new rows to reach the screen. Only repainting on a busy-state
    // change left streamed assistant text invisible until the next keystroke.
    this.repaint();
  }

  // ------------------------------------------------------------------- keys

  /**
   * Handle one decoded key.
   *
   * @param {string} key Key name from `keymap.KEYS`.
   * @param {string} [payload] Text payload for `text`/`paste`.
   */
  onKey(key, payload) {
    // A picker owns the keyboard while it is open, or a keystroke would edit the
    // prompt hidden behind the list.
    if (this.handlePickerKey?.(key, payload)) return;
    const suggestionOpen = this.suggestions.length > 0;
    const action = actionForKey(key, {
      busy: this.renderer.busy,
      suggestionOpen,
      emptyPrompt: this.editor.isEmpty,
      toolbarFocused: this.toolbarFocused === true,
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
      case 'submit':
        // Enter is the only way to send a prompt. Repaint on both edges: the
        // first clears the box the user just sent from, the second shows what
        // the turn produced.
        void this.submit()
          .catch((error) => {
            this.renderer.systemMessage(`submit failed: ${error?.message ?? error}`, { tone: 'error' });
          })
          .finally(() => {
            // No `refreshHint()` here: the prompt was just submitted, so
            // re-deriving a completion menu would repaint the block over the
            // output the command or turn produced.
            this.input?.render();
          });
        return;
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
      case 'open-palette':
        this.openPalette();
        break;
      case 'toolbar-next':
        // The first Tab only focuses the bar, keeping the current tab; later
        // presses move along it. Advancing on the focusing press meant
        // "Tab, Enter" opened the next tab instead of the one shown active.
        if (this.toolbarFocused === true) this.moveTab(1);
        else {
          this.toolbarFocused = true;
          this.repaint();
        }
        break;
      case 'toolbar-prev':
        if (this.toolbarFocused === true) this.moveTab(-1);
        else {
          this.toolbarFocused = true;
          this.repaint();
        }
        break;
      case 'toolbar-open':
        this.openTab(this.toolbarTab ?? 0);
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
    this.repaint();
  }

  /** Accept the highlighted slash-command suggestion. */
  acceptSuggestion() {
    const picked = this.suggestions[this.suggestionIndex] ?? this.suggestions[0];
    if (!picked) return;
    this.editor.setText(`/${picked.name} `);
    this.suggestions = [];
    this.suggestionIndex = -1;
  }

  /**
   * Open the everything-picker: commands, models and sessions in one list.
   *
   * @returns {void}
   */
  openPalette() {
    /** @type {{ id: string, label: string, detail?: string }[]} */
    const rows = [];
    for (const spec of this.commands.list()) {
      rows.push({ id: `cmd:${spec.name}`, label: spec.name, detail: spec.summary });
    }
    try {
      for (const route of meta.listAllModels?.() ?? meta.listModels?.() ?? []) {
        rows.push({ id: `model:${route}`, label: route, detail: 'switch model' });
      }
    } catch {
      /* a broken catalogue must not break the palette */
    }
    try {
      for (const session of meta.listSessions?.() ?? []) {
        rows.push({ id: `session:${session.id}`, label: session.label, detail: session.detail });
      }
    } catch {
      /* same for the session store */
    }
    this.pickers.openPalette(rows);
    this.editor.clear();
    this.suggestions = [];
    this.suggestionIndex = -1;
    this.repaintPicker();
  }

  /**
   * Act on a palette choice.
   *
   * @param {{ kind: string, value: string } | null} choice Chosen row.
   * @returns {void}
   */
  applyPalette(choice) {
    if (choice === null) {
      this.repaintPicker();
      return;
    }
    if (choice.kind === 'cmd') {
      // `submit` erases the block, dispatches, and writes the command's output.
      // The block is redrawn afterwards so the prompt returns below that output
      // instead of being painted over it.
      void this.submit(`/${choice.value}`)
        .catch((error) => {
          this.renderer.systemMessage(`command failed: ${error?.message ?? error}`, { tone: 'error' });
        })
        .finally(() => this.input?.render());
      return;
    }
    if (choice.kind === 'model') {
      // An unknown route must not crash the UI: report it and keep the session.
      if (typeof this.meta?.setModel !== 'function' || choice.value === '') return;
      void Promise.resolve(this.meta.setModel(choice.value)).catch((error) => {
        this.renderer.systemMessage(`model switch failed: ${error?.message ?? error}`, { tone: 'error' });
        this.repaintPicker();
      });
      return;
    }
    if (choice.kind === 'session' && typeof this.meta?.onResumeSession === 'function') {
      void this.meta.onResumeSession(choice.value);
    }
  }

  /**
   * Open a searchable picker under the prompt.
   *
   * @param {'model'|'session'} kind Which list.
   * @returns {void}
   */
  openPicker(kind) {
    // Runs from a dispatch, which may itself be mid-close after a palette
    // choice. Defer the repaint to the next tick so the picker state changes
    // settle before the block is redrawn, instead of recursing into a render
    // that never returns.
    if (kind === 'model') this.pickers.openModel();
    else this.pickers.openSession();
    this.editor.clear();
    this.suggestions = [];
    this.suggestionIndex = -1;
    setImmediate(() => this.repaintPicker());
  }

  /**
   * Route a key to the open picker.
   *
   * @param {string} key Decoded key name.
   * @param {string} [payload] Text payload.
   * @returns {boolean} True when a picker consumed the key.
   */
  handlePickerKey(key, payload) {
    if (!this.pickers?.open) return false;
    const consumed = this.pickers.handleKey(
      key,
      payload,
      KEYS.enter,
      KEYS.tab,
      KEYS.backspace,
      KEYS.escape,
      KEYS.ctrlC,
      KEYS.text,
    );
    if (consumed) {
      // Enter closes the picker, so the hint rows must be cleared even though
      // there is no list left to draw: leaving them set left the closed menu
      // painted under the prompt.
      if (!this.pickers.open) {
        this.input?.setHint('');
        this.input?.render();
      } else {
        this.repaintPicker();
      }
    }
    return consumed;
  }

  /** Show the open picker's rows, or clear the hint line. */
  repaintPicker() {
    if (!this.input) return;
    const pickers = this.pickers;
    const rows = pickers?.model
      ? renderModelPicker(pickers.model, { width: this.renderer.columns, theme: this.theme })
      : pickers?.palette
        ? renderPicker(pickers.palette, { width: this.renderer.columns, theme: this.theme })
        : pickers?.session
          ? renderPicker(pickers.session, { width: this.renderer.columns, theme: this.theme })
          : [];
    this.input.setHint(rows.join('\n'));
    // With no picker open the block was already erased and the output written:
    // rendering here would repaint the prompt over that output.
    if (rows.length === 0 && !pickers?.open) return;
    this.repaint();
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
    // A picker owns the hint rows. Letting completion text overwrite them made
    // the picker flash and disappear the moment any key refreshed the hint.
    if (this.pickers?.open) {
      this.repaintPicker();
      return;
    }
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
    return this.hintRows().join('\n');
  }

  /**
   * Hint rows under the prompt: the open picker, or the command menu.
   *
   * @returns {string[]} Rows, empty when nothing is open.
   */
  hintRows() {
    const { style } = this.theme;
    if (this.pickers?.open) {
      const pickers = this.pickers;
      return pickers.model
        ? renderModelPicker(pickers.model, { width: this.renderer.columns, theme: this.theme })
        : pickers.palette
          ? renderPicker(pickers.palette, { width: this.renderer.columns, theme: this.theme })
          : renderPicker(pickers.session, { width: this.renderer.columns, theme: this.theme });
    }
    if (this.suggestions.length === 0) return [];
    return this.suggestions.map((entry, index) => {
      const label = `/${entry.name}`;
      const text = `${label.padEnd(9)} ${style.muted(entry.summary)}`;
      return index === this.suggestionIndex ? style.selected(text) : `  ${text}`;
    });
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
    // Erase the block *before* anything is printed. Rendering it empty leaves
    // the header and prompt occupying rows, so the echoed message and the reply
    // were written underneath a live prompt and never appeared in order.
    if (this.input) {
      this.input.erase(); // detached: no-op
      this.input.setHint('');
    }
    if (!value.trim()) {
      this.repaint();
      return;
    }

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
      this.repaint();
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
      this.repaint();
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
