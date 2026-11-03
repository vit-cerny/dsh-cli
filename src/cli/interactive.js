/**
 * Interactive command: the terminal UI plus the shutdown/signal discipline the
 * TUI cannot own by itself.
 *
 * Two things must hold on every exit path — Ctrl+C, Ctrl+D, `/quit`, a dead
 * runtime, or an uncaught error:
 *
 * 1. **the terminal is usable afterwards**: raw mode off, cursor visible;
 * 2. **exactly one runtime process exists per session, and it does not outlive
 *    the client**: the driver is shut down on the way out.
 *
 * `runApp` already tears down the prompt on its own paths; the signal handler
 * here covers a Ctrl+C that arrives while no prompt is drawn (e.g. during
 * startup) and any exit the app never sees.
 *
 * @module src/cli/interactive
 */

import process from 'node:process';

import { createCommandRegistry } from '../ui/commands.js';
import { formatDuration } from '../ui/text.js';
import { subscribeDriver } from '../ui/app.js';
import { SessionDriver, createSessionId } from '../session/driver.js';
import { ResourceSampler } from '../session/resources.js';
import { UsageMeter, formatCost, formatUsage } from '../session/usage.js';
import { CliError, describeError, resolveContext } from './context.js';
import { readProfileInventory } from './info.js';
import { runMigrateCommand } from './migrate.js';
import { runPluginsCommand } from './plugins.js';
import { pricingOverrideFor } from './pricing-config.js';
import { findSessionFile, readSessionHistory, readSessionSummaries } from './store.js';
import { runUsageCommand } from './usage-command.js';

/** Show the cursor, so an aborted raw-mode session does not hide it. */
const SHOW_CURSOR = '\u001b[?25h';

/**
 * Restore the terminal to a state a shell can keep using.
 *
 * @param {NodeJS.ReadStream} [stdin] Input stream holding the raw mode flag.
 * @param {NodeJS.WriteStream} [stdout] Output stream for the cursor sequence.
 * @returns {void}
 */
export function restoreTerminal(stdin = process.stdin, stdout = process.stdout) {
  try {
    if (typeof stdin?.setRawMode === 'function' && stdin.isRaw === true) stdin.setRawMode(false);
  } catch {
    /* the stream may already be destroyed */
  }
  try {
    stdout?.write?.(SHOW_CURSOR);
  } catch {
    /* best effort: never mask the real error */
  }
}

/**
 * `/sessions` as an in-session slash command.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @returns {object} Command spec for {@link createCommandRegistry}'s `extra` hook.
 */
export function sessionsCommand(context) {
  return {
    name: 'sessions',
    summary: 'List persisted sessions (newest first)',
    usage: '/sessions',
    run(ctx) {
      const rows = readSessionSummaries(context.dshHome, { limit: 10 });
      if (rows.length === 0) {
        ctx.renderer?.block('no persisted sessions found', { style: 'muted' });
        return { action: 'continue' };
      }
      // Reuse the toolbar's picker so the interactive list and the top row agree
      // on ordering, marking and width instead of growing a second renderer.
      const pickerRows = rows.map((row) => ({
        id: row.id,
        title: row.title,
        age: row.updatedAt === undefined ? '?' : formatDuration(Date.now() - row.updatedAt),
        cwd: row.cwd ?? '',
        active: row.id === ctx.app?.renderer?.meta?.sessionId,
      }));
      const lines =
        typeof ctx.app?.toolbar?.pick === 'function'
          ? ctx.app.toolbar.pick({ rows: pickerRows })
          : pickerRows.map((row) => `  ${row.id}  ${row.age}  ${row.title}`);
      for (const line of lines) ctx.renderer?.block(line);
      ctx.renderer?.block('  reopen one with: dsh-cli resume <sessionId>', { style: 'muted' });
      return { action: 'continue' };
    },
  };
}

/**
 * Slash commands that reuse the one-shot command surface.
 *
 * Each is a thin wrapper: the CLI subcommand owns the logic, so the interactive
 * and non-interactive answers cannot drift apart.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @param {{ meter?: () => object | null }} [hooks] Live-state accessors.
 * @returns {object[]} Command specs for `createCommandRegistry`'s `extra` hook.
 */
export function reportingCommands(context, hooks = {}) {
  return [
    {
      name: 'usage',
      summary: 'Show tokens and cost for this session, or the whole store',
      usage: '/usage [sessionId]',
      run(ctx, args) {
        const live = hooks.meter?.() ?? null;
        const id = String(args ?? '').trim();
        if (id === '' && live !== null && live.calls > 0) {
          ctx.renderer?.block('this session', { style: 'info' });
          ctx.renderer?.block(`  ${formatUsage(live)}`);
          ctx.renderer?.block(`  cost: ${formatCost(live.costUsd, live.priced)}`);
          ctx.renderer?.block('  /usage <sessionId> for a persisted session', { style: 'muted' });
          return { action: 'continue' };
        }
        const sink = { write: (line) => ctx.renderer?.block(String(line).replace(/\n$/, '')) };
        runUsageCommand(context, { stdout: sink, ...(id === '' ? {} : { sessionId: id }) });
        return { action: 'continue' };
      },
    },
    {
      name: 'plugins',
      summary: 'Show Desktop plugins and whether this profile mounts them',
      usage: '/plugins',
      run(ctx) {
        const sink = { write: (line) => ctx.renderer?.block(String(line).replace(/\n$/, '')) };
        runPluginsCommand(context, { stdout: sink });
        return { action: 'continue' };
      },
    },
    {
      name: 'migrate',
      summary: 'Plan an import from another harness (writes only with the CLI)',
      usage: '/migrate [source]',
      run(ctx, args) {
        const sink = { write: (line) => ctx.renderer?.block(String(line).replace(/\n$/, '')) };
        runMigrateCommand(context, {
          stdout: sink,
          ...(String(args ?? '').trim() === '' ? {} : { source: String(args).trim() }),
        });
        ctx.renderer?.block('apply with: dsh-cli migrate <source> --apply', { style: 'muted' });
        return { action: 'continue' };
      },
    },
  ];
}

/**
 * Run the interactive terminal UI.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @param {{
 *   version?: string,
 *   resumeId?: string,
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WriteStream,
 *   stderr?: NodeJS.WriteStream,
 *   driverFactory?: (options: object) => Promise<SessionDriver>,
 *   AppClass?: new (options: object) => { run: () => Promise<{ exitCode: number }> },
 * }} [options] Wiring overrides (all exist for tests).
 * @returns {Promise<number>} Process exit code.
 */
export async function runInteractive(context, options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const factory = options.driverFactory ?? SessionDriver.open;
  const AppClass = options.AppClass ?? (await import('../ui/app.js')).App;

  /** @type {SessionDriver | null} */
  let driver = null;
  let quitting = false;
  let interrupted = 0;
  let app = null;
  // Declared outside the try block: `finally` stops it even when the runtime
  // fails to start, and a block-scoped binding would be unreachable there.
  /** @type {ResourceSampler | null} */
  let sampler = null;

  const onExit = () => restoreTerminal(stdin, stdout);
  process.on('exit', onExit);

  const onSigint = () => {
    interrupted += 1;
    if (interrupted > 1 || app === null || app.closed === true) {
      // Second Ctrl+C (or a Ctrl+C outside the app): hard stop. The exit hook
      // restores the terminal.
      quitting = true;
      process.exitCode = 130;
      process.exit(130);
    }
    // The prompt turns Ctrl+C into a real SIGINT, so this is the only handler
    // that sees it. A busy turn must be aborted on the first press; the protocol
    // has no cancel, so abort() terminates the runtime and quits the UI.
    if (app.renderer?.busy === true) app.abort();
    else app.interrupt();
  };
  process.on('SIGINT', onSigint);

  try {
    const sessionId =
      options.resumeId === undefined
        ? createSessionId()
        : resolveResumeId(context, options.resumeId);

    // Pricing is resolved from the installed catalog on first use, so creating
    // the meter costs nothing when no usage ever arrives. A user-declared rate
    // for a gateway route is consulted only when the catalog has no entry.
    const usageMeter = new UsageMeter({
      provider: context.provider,
      model: context.model,
      override: pricingOverrideFor({
        dshHome: context.dshHome,
        provider: context.provider,
        model: context.model,
      }),
    });
    sampler = new ResourceSampler();

    try {
      driver = await factory(driverOptions(context, sessionId));
      if (options.resumeId !== undefined) {
        // Reopen the persisted session; the server is the source of truth about
        // whether it exists, so a failure here is reported rather than hidden.
        await driver.client.resume(sessionId);
      }
    } catch (error) {
      const report = describeError(error, context);
      const prefix =
        options.resumeId === undefined
          ? 'cannot start the DSH runtime'
          : `cannot resume session "${sessionId}"`;
      throw new CliError(`${prefix}: ${report.message}`, { hint: report.hint, cause: error });
    }

    // The runtime pid only exists once the child spawned, so it is attached after
    // the handshake rather than passed to the constructor.
    const runtimePid = driver.client?.pid;
    if (Number.isFinite(runtimePid) && runtimePid > 0) sampler.runtimePid = runtimePid;

    app = new AppClass({
      driver,
      stdin,
      stdout,
      version: options.version ?? '0.0.0',
      meta: {
        model: context.model,
        provider: context.provider,
        cwd: context.cwd,
        sessionId: driver.sessionId,
        usageMeter,
        resources: sampler,
        listModels: () => availableModels(context),
        // The picker searches the whole catalogue; `/model` prints a short list
        // because a wall of 400 rows is not a useful answer.
        listAllModels: () => availableModels(context, 1000),
        listSessions: () =>
          readSessionSummaries(context.dshHome, { limit: 200 }).map((row) => ({
            id: row.id,
            label: row.title,
            detail: row.cwd ?? '',
            active: row.id === driver.sessionId,
          })),
        onResumeSession: async (id) => {
          // Reopening replaces the runtime: the live process holds this
          // session's write lock, so the current one has to go first.
          const previous = driver;
          await previous.close();
          const fresh = await factory(driverOptions(context, id));
          await fresh.client.resume(id);
          app.unsubscribe();
          app.driver = fresh;
          driver = fresh;
          app.unsubscribe = subscribeDriver(fresh, (event) => app.onEvent(event));
          app.renderer.setMeta({ sessionId: fresh.sessionId });
          app.renderer.block(`resumed ${id}`, { style: 'muted' });
        },
        setModel: async (name) => {
          const next = parseModelSwitch(context, name);
          // The SDK protocol has no re-route method, and the live runtime holds
          // the session's write lock, so switching means: close this runtime,
          // open a new one on the new route, start a new conversation. The old
          // session stays on disk — `dsh-cli resume <id>` reopens it.
          const previous = driver;
          await previous.close();
          const fresh = await factory({
            ...driverOptions(context, createSessionId()),
            provider: next.provider,
            model: next.model,
            reasoningEffort: undefined,
            maxTokens: undefined,
          });
          app.unsubscribe();
          app.driver = fresh;
          driver = fresh;
          context = {
            ...context,
            provider: next.provider,
            model: next.model,
            reasoningEffort: undefined,
            maxTokens: undefined,
          };
          app.unsubscribe = subscribeDriver(fresh, (event) => app.onEvent(event));
          app.renderer.setMeta({ model: next.model, sessionId: fresh.sessionId });
          // The header shows the route, and a runtime swap takes seconds: paint
          // the new model into the block so the switch is visible immediately.
          app.input?.render?.();
        },
      },
      extraCommands: [
        sessionsCommand(context),
        ...reportingCommands(context, { meter: () => usageMeter.totals }),
      ],
    });

    if (options.resumeId !== undefined) {
      // The SDK loads history into the agent but does not replay it as live
      // events. Read the same persisted log to restore the visible transcript.
      const file = findSessionFile(readSessionSummaries(context.dshHome, { limit: 500 }), sessionId);
      const history = file === null ? [] : readSessionHistory(file);
      if (history.length > 0) {
        app.renderer.block(`resumed history (${history.length} messages)`, { style: 'muted' });
        for (const message of history) {
          if (message.role === 'user') app.renderer.userMessage(message.text);
          else app.renderer.assistantText(message.text);
        }
        app.renderer.ensureNewline();
      }
    }

    const result = await app.run();
    // The final figures are the ones worth keeping: print them once on exit so
    // they survive the screen being cleared and a piped log still records them.
    if (usageMeter.totals.calls > 0) {
      const totals = usageMeter.totals;
      stdout.write(
        `usage: ${formatUsage(totals)} · ${formatCost(totals.costUsd, totals.priced)}\n`,
      );
    }
    return quitting ? 130 : (result?.exitCode ?? 0);
  } catch (error) {
    if (quitting) return 130;
    const report = describeError(error, context);
    stderr.write(`dsh-cli: ${report.message}\n`);
    if (report.hint !== undefined) stderr.write(`${report.hint}\n`);
    return report.exitCode;
  } finally {
    restoreTerminal(stdin, stdout);
    sampler?.stop();
    process.off('SIGINT', onSigint);
    process.off('exit', onExit);
    if (driver !== null) {
      try {
        // Ask the runtime to dispose its agents, then make sure the process is
        // gone: one runtime per session, never a leaked child.
        await driver.close();
      } catch {
        /* close() already killed the child */
      }
    }
  }
}

/**
 * Map a `resume` argument to a full session id. A unique prefix is accepted,
 * because session ids are long and copying them is error-prone.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @param {string} requested Id or unique prefix.
 * @returns {string} The full id.
 * @throws {CliError} When nothing matches or the prefix is ambiguous.
 */
export function resolveResumeId(context, requested) {
  const id = String(requested ?? '').trim();
  if (id === '') throw new CliError('resume needs a session id', { exitCode: 2 });
  const rows = readSessionSummaries(context.dshHome, { limit: 500 });
  if (rows.some((row) => row.id === id)) return id;
  const matches = rows.filter((row) => row.id.startsWith(id));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new CliError(`session id prefix "${id}" is ambiguous (${matches.length} matches)`, {
      hint: matches
        .slice(0, 5)
        .map((row) => row.id)
        .join('\n'),
    });
  }
  // Not in the local index: hand it to the runtime, which owns the truth.
  return id;
}

/**
 * The option object every driver factory call shares.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @param {string} sessionId Session id.
 * @returns {object} `SessionDriver.open` options.
 */
export function driverOptions(context, sessionId) {
  return {
    cwd: context.cwd,
    provider: context.provider,
    model: context.model,
    sessionId,
    runtimeCommand: context.runtimeBin,
    runtimeArgs: context.runtimeArgs,
    ...(context.reasoningEffort === undefined ? {} : { reasoningEffort: context.reasoningEffort }),
    ...(context.maxTokens === undefined ? {} : { maxTokens: context.maxTokens }),
  };
}

/**
 * Model ids the active profile configures, for `/model` with no argument.
 *
 * Bounded on purpose: a profile can carry hundreds of models, and printing all
 * of them would bury the prompt.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @param {number} [limit] Maximum entries.
 * @returns {string[]} `provider/model` strings, current provider first.
 */
export function availableModels(context, limit = 24) {
  try {
    const inventory = readProfileInventory(context);
    /** @type {string[]} */
    const rows = [];
    for (const route of inventory.routes) {
      for (const entry of route.models) {
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (id === '') continue;
        const provider = route.provider ?? route.id;
        rows.push(`${provider}/${id}`);
      }
    }
    // The current provider's models are what most switches want.
    rows.sort((a, b) => {
      const aMine = a.startsWith(`${context.provider}/`) ? 0 : 1;
      const bMine = b.startsWith(`${context.provider}/`) ? 0 : 1;
      return aMine - bMine || a.localeCompare(b);
    });
    if (rows.length <= limit) return rows;
    return [...rows.slice(0, limit), `… ${rows.length - limit} more (dsh-cli models)`];
  } catch {
    return [];
  }
}

/**
 * Parse a `/model` argument into a route.
 *
 * Accepts `provider/model` for an explicit route or a bare model id, which
 * keeps the current provider. The runtime validates the route on initialize.
 *
 * @param {import('./context.js').CliContext} context Current route.
 * @param {string} value User input after `/model`.
 * @returns {{ provider: string, model: string }} Next route.
 * @throws {CliError} On an empty argument.
 */
function parseModelSwitch(context, value) {
  const text = String(value ?? '').trim();
  if (text === '') throw new CliError('usage: /model <model> or /model <provider>/<model>');
  const slash = text.indexOf('/');
  if (slash > 0) {
    return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
  }
  return { provider: context.provider, model: text };
}

export { createCommandRegistry };
