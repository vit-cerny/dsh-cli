/**
 * Slash-command registry for the dsh-cli TUI (task T3).
 *
 * The registry is intentionally boring: a `Map` of name → spec, plus an
 * `aliases` map. That is the whole extension seam later tasks need — T5 (config)
 * can register `/model` list sources, T8 can register `/interop`, without
 * touching this file or `app.js`.
 *
 * Contract for a command spec:
 * ```js
 * {
 *   name: 'model',            // canonical, without the leading slash
 *   summary: 'Show or set the model', // one line, shown by /help and completion
 *   usage: '/model [name]',   // optional
 *   aliases: ['m'],           // optional
 *   run(ctx, argsText) { ... } // required; `ctx` is documented on dispatch()
 * }
 * ```
 *
 * Robustness rule from the brief: an unknown or malformed command must never
 * throw — it renders a hint and returns normally.
 *
 * @module src/ui/commands
 */

import process from 'node:process';

/**
 * Parse a raw prompt line into command name + argument text.
 *
 * @param {string} input Raw prompt content.
 * @returns {{ isCommand: boolean, name: string, args: string, raw: string }}
 */
export function parseCommand(input) {
  const raw = String(input ?? '').trim();
  if (!raw.startsWith('/')) return { isCommand: false, name: '', args: '', raw };
  const body = raw.slice(1);
  const space = body.search(/\s/);
  if (space === -1) return { isCommand: true, name: body.toLowerCase(), args: '', raw };
  return {
    isCommand: true,
    name: body.slice(0, space).toLowerCase(),
    args: body.slice(space + 1).trim(),
    raw,
  };
}

/**
 * The command registry.
 */
export class CommandRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this.commands = new Map();
    /** @type {Map<string, string>} alias → canonical name */
    this.aliases = new Map();
    this.onQuit = null;
  }

  /**
   * Register a command. Re-registering the same name replaces it, which is how
   * a later task overrides a built-in without forking the file.
   *
   * @param {object} spec Command spec (see module docs).
   * @returns {this} Fluent.
   */
  register(spec) {
    if (!spec || typeof spec !== 'object') throw new TypeError('command spec must be an object');
    const name = String(spec.name ?? '').replace(/^\//, '').toLowerCase();
    if (!name) throw new TypeError('command name is required');
    if (typeof spec.run !== 'function') throw new TypeError(`command /${name} needs a run() function`);
    const entry = {
      name,
      summary: String(spec.summary ?? ''),
      usage: String(spec.usage ?? `/${name}`),
      aliases: Array.isArray(spec.aliases) ? spec.aliases.map((a) => String(a).toLowerCase()) : [],
      run: spec.run,
    };
    this.commands.set(name, entry);
    for (const alias of entry.aliases) this.aliases.set(alias, name);
    return this;
  }

  /**
   * Look up a command by name or alias.
   *
   * @param {string} name Name without the slash.
   * @returns {object|null} Command entry.
   */
  get(name) {
    const key = String(name ?? '').replace(/^\//, '').toLowerCase();
    if (!key) return null;
    return this.commands.get(key) ?? this.commands.get(this.aliases.get(key) ?? '') ?? null;
  }

  /** Command entries in registration order. */
  list() {
    return [...this.commands.values()];
  }

  /**
   * Prefix/best-effort match for the completion menu.
   *
   * @param {string} prefix Partial name typed after `/`.
   * @returns {object[]} Matching entries.
   */
  suggest(prefix = '') {
    const needle = String(prefix ?? '').replace(/^\//, '').toLowerCase();
    const all = this.list();
    if (!needle) return all;
    return all.filter(
      (entry) => entry.name.startsWith(needle) || entry.aliases.some((a) => a.startsWith(needle)),
    );
  }

  /**
   * Execute a raw slash command.
   *
   * `ctx` is forwarded verbatim to the handler; `app.js` supplies:
   * `{ renderer, app, driver, registry, model, cwd }`.
   *
   * @param {string} input Raw line starting with `/`.
   * @param {object} [ctx] Handler context.
   * @returns {{ handled: boolean, name: string, action?: string, error?: string }}
   */
  dispatch(input, ctx = {}) {
    const parsed = parseCommand(input);
    if (!parsed.isCommand) return Promise.resolve({ handled: false, name: '' });
    const command = this.get(parsed.name);
    if (!command) {
      const renderer = ctx.renderer;
      if (renderer) {
        renderer.systemMessage(`unknown command: /${parsed.name}`, { tone: 'warn' });
        const names = this.suggest('')
          .map((entry) => `/${entry.name}`)
          .join('  ');
        renderer.block(`available: ${names}`, { style: 'muted' });
      }
      return Promise.resolve({ handled: true, name: parsed.name, error: 'unknown-command' });
    }
    // Handlers may be async (e.g. /model swaps the runtime); awaiting keeps the
    // caller from racing ahead before the command finished.
    return Promise.resolve()
      .then(() => command.run(ctx, parsed.args))
      .then((result) => ({
        handled: true,
        name: command.name,
        action: typeof result === 'string' ? result : result?.action,
      }))
      .catch((error) => {
        // A broken command must degrade to a notice, never crash the session.
        ctx.renderer?.systemMessage(`/${command.name} failed: ${error?.message ?? error}`, {
          tone: 'error',
        });
        return { handled: true, name: command.name, error: String(error?.message ?? error) };
      });
  }

  /**
   * Render the command list (used by `/help` and by a bare `/`).
   *
   * @param {object} renderer Renderer instance.
   * @param {{ title?: string }} [options]
   * @returns {void}
   */
  renderHelp(renderer, { title = 'commands' } = {}) {
    if (!renderer) return;
    const rows = this.list().map((entry) => ({
      usage: entry.usage,
      summary: entry.summary,
    }));
    const width = rows.reduce((max, row) => Math.max(max, row.usage.length), 0);
    renderer.block(title, { style: 'info' });
    for (const row of rows) {
      renderer.block(`  ${row.usage.padEnd(width)}  ${row.summary}`);
    }
  }
}

/**
 * Build the registry pre-loaded with the built-in commands.
 *
 * @param {{ model?: () => string, cwd?: () => string, setModel?: (name: string) => void,
 *   clear?: () => void, quit?: () => void, extra?: object[] }} [hooks] `extra` lets
 *   `src/cli/` register commands (e.g. `/sessions`) without forking this file.
 * @returns {CommandRegistry} Registry.
 */
export function createCommandRegistry(hooks = {}) {
  const registry = new CommandRegistry();
  registry.register({
    name: 'help',
    summary: 'List commands and key bindings',
    usage: '/help',
    aliases: ['h', '?'],
    run(ctx) {
      registry.renderHelp(ctx.renderer, { title: 'commands' });
      ctx.renderer?.block('');
      ctx.renderer?.block(KEY_BINDINGS, { style: 'muted' });
      return { action: 'continue' };
    },
  });

  // Loop over an empty array never calls the handler, so the built-ins above stay
  // authoritative unless a caller deliberately overrides one.
  for (const spec of Array.isArray(hooks.extra) ? hooks.extra : []) registry.register(spec);

  registry.register({
    name: 'model',
    summary: 'Show the active model (or set one when the driver allows it)',
    usage: '/model [name]',
    aliases: ['m'],
    run(ctx, args) {
      const current = hooks.model?.() ?? ctx.model ?? '(unknown)';
      if (!args) {
        // Bare `/model` opens the searchable picker: printing hundreds of ids
        // is not a useful answer, and the picker filters as you type.
        if (typeof hooks.openModelPicker === 'function') {
          hooks.openModelPicker();
          return { action: 'continue' };
        }
        ctx.renderer?.block(`model: ${current}`);
        // Listing what is available is the difference between "you are here"
        // and "you can go there"; without it the user needs a second terminal.
        const list = typeof hooks.listModels === 'function' ? hooks.listModels() : null;
        if (Array.isArray(list) && list.length > 0) {
          ctx.renderer?.block('available:', { style: 'muted' });
          for (const entry of list) ctx.renderer?.block(`  ${entry}`);
        }        ctx.renderer?.block('set:   /model <name> or /model <provider>/<name>', {
          style: 'muted',
        });
        return { action: 'continue' };
      }
      if (typeof hooks.setModel !== 'function') {
        ctx.renderer?.systemMessage(
          `model switching is not wired to this driver yet; active model is ${current}`,
          { tone: 'warn' },
        );
        return { action: 'continue' };
      }
      // The handler swaps the runtime process, so it is async.
      return Promise.resolve(hooks.setModel(args)).then(
        () => {
          ctx.renderer?.block(`model: ${args}`);
          return { action: 'continue' };
        },
        (error) => {
          ctx.renderer?.systemMessage(`cannot switch model: ${error?.message ?? error}`, {
            tone: 'error',
          });
          return { action: 'continue' };
        },
      );
    },
  });

  registry.register({
    name: 'cwd',
    summary: 'Show the session working directory',
    usage: '/cwd',
    run(ctx) {
      const cwd = hooks.cwd?.() ?? ctx.cwd ?? process.cwd?.() ?? '(unknown)';
      ctx.renderer?.block(`cwd: ${cwd}`);
      return { action: 'continue' };
    },
  });

  registry.register({
    name: 'clear',
    summary: 'Clear the transcript view (does not reset the session)',
    usage: '/clear',
    aliases: ['cls'],
    run(ctx) {
      if (typeof hooks.clear === 'function') hooks.clear();
      else ctx.renderer?.clearScreen?.();
      ctx.renderer?.block('transcript cleared — the session itself is untouched', {
        style: 'muted',
      });
      return { action: 'continue' };
    },
  });

  registry.register({
    name: 'quit',
    summary: 'Exit the client (the agent process is shut down)',
    usage: '/quit',
    aliases: ['q', 'exit'],
    run(ctx) {
      if (typeof hooks.quit === 'function') hooks.quit();
      return { action: 'quit' };
    },
  });

  return registry;
}

/** Key table shown by `/help`; also mirrored in the T3 report. */
export const KEY_BINDINGS = [
  'Enter        send the prompt',
  'Ctrl+J       insert a newline (Shift+Enter where the terminal supports it)',
  '↑ / ↓        history at the first/last line, otherwise move the caret',
  '← / →        move the caret      Home/End  line start/end',
  'Ctrl+U/K/W   delete to line start / line end / previous word',
  'Tab          accept the highlighted slash-command suggestion',
  'Ctrl+O       expand or collapse the last tool output (default 8 lines)',
  'Ctrl+L       clear the screen',
  'Ctrl+C       abort the running turn, or quit when idle',
  'Ctrl+D       quit',
].join('\n');
