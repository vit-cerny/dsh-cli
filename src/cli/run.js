/**
 * `dsh-cli run "<prompt>"` — one-shot, non-interactive turn.
 *
 * Drives `DshRpcClient` directly (no TUI, no renderer) so the whole command
 * costs one runtime + a few kilobytes of client state. Output policy:
 *
 * - the assistant text of the finished turn goes to **stdout**;
 * - notices, tool one-liners and errors go to **stderr**, so `dsh-cli run … >
 *   out.txt` yields exactly the answer;
 * - exit code is `0` for a completed turn, `1` for a failed turn or a runtime
 *   failure, `2` for a usage error (handled by `src/main.js`), `130` when the
 *   process was interrupted.
 *
 * The SDK protocol has **no cancel method**, so Ctrl+C kills the runtime; the
 * reply gathered so far is still printed so an interrupted run is not a total
 * loss.
 *
 * @module src/cli/run
 */

import process from 'node:process';

import { SessionDriver } from '../session/driver.js';
import { describeError } from './context.js';

/** Default per-turn timeout: generous, but a hung runtime cannot block forever. */
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Parse a `--timeout` value (`30`, `30s`, `5m`, `1h`).
 *
 * @param {string} value Raw flag value.
 * @returns {number} Timeout in milliseconds.
 * @throws {import('./args.js').UsageError} When the value is not a duration.
 */
export function parseTimeout(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(String(value ?? '').trim());
  if (match === null) {
    throw Object.assign(new Error(`invalid --timeout value: ${value}`), { name: 'UsageError', exitCode: 2 });
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  const ms = Math.round(amount * factor);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw Object.assign(new Error(`invalid --timeout value: ${value}`), { name: 'UsageError', exitCode: 2 });
  }
  return ms;
}

/**
 * A short human label for a tool call, e.g. `Bash(npm test)`.
 *
 * @param {object} event `tool-call` event.
 * @param {number} [width] Maximum label width.
 * @returns {string} Label.
 */
export function toolLabel(event, width = 80) {
  const name = String(event?.name ?? event?.tool ?? 'tool');
  const args = event?.arguments;
  let detail = '';
  if (typeof args === 'string') detail = args;
  else if (args && typeof args === 'object') {
    for (const field of ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url']) {
      if (typeof args[field] === 'string' && args[field].trim() !== '') {
        detail = args[field];
        break;
      }
    }
    if (detail === '') detail = Object.keys(args).slice(0, 3).join(',');
  }
  const flat = String(detail).replace(/\s+/g, ' ').trim();
  const clipped = flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
  return clipped === '' ? name : `${name}(${clipped})`;
}

/**
 * Execute one prompt and resolve with the exit code.
 *
 * @param {import('./context.js').CliContext} context Resolved runtime/route.
 * @param {string} prompt User text.
 * @param {{
 *   stdout?: NodeJS.WriteStream,
 *   stderr?: NodeJS.WriteStream,
 *   timeoutMs?: number,
 *   quiet?: boolean,
 *   driverFactory?: (options: object) => Promise<SessionDriver>,
 * }} [options] Output streams and overrides.
 * @returns {Promise<number>} Process exit code.
 */
export async function runOnce(context, prompt, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const quiet = options.quiet === true;
  const factory = options.driverFactory ?? SessionDriver.open;

  // One-shot output is written as it streams, so client memory does not grow
  // with the response length. `streamed` records whether anything was written.
  let streamed = false;
  let lastTool = '';
  /** Call ids already announced; the runtime reports each call twice. */
  const announcedCalls = new Set();
  let interrupted = false;
  /** @type {SessionDriver | null} */
  let driver = null;

  const onSigint = () => {
    interrupted = true;
    // The protocol has no cancel: terminate the runtime so the turn cannot
    // outlive the CLI. abort() rejects by contract, so swallow that rejection.
    const pending = driver?.abort?.();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  };
  process.on('SIGINT', onSigint);

  try {
    driver = await factory({
      cwd: context.cwd,
      provider: context.provider,
      model: context.model,
      runtimeCommand: context.runtimeBin,
      runtimeArgs: context.runtimeArgs,
      ...(context.reasoningEffort === undefined ? {} : { reasoningEffort: context.reasoningEffort }),
      ...(context.maxTokens === undefined ? {} : { maxTokens: context.maxTokens }),
    });

    // Stream assistant text to stdout as it arrives; never retain the response.
    driver.on('assistant-text', (event) => {
      const chunk = event.text ?? '';
      if (chunk === '') return;
      stdout.write(chunk);
      streamed = true;
    });
    driver.on('tool-call', (event) => {
      // The same call arrives once as an assistant content block and once as a
      // standalone `tool/call`; announce it once.
      const key = event.callId ?? event.name ?? '';
      if (key !== '' && announcedCalls.has(key)) return;
      if (key !== '') announcedCalls.add(key);
      lastTool = toolLabel(event);
      if (!quiet) stderr.write(`· ${lastTool}\n`);
    });
    driver.on('turn-end', (event) => {
      const reason = event.reason?.kind;
      if (reason !== undefined && reason !== 'completed' && !quiet) {
        stderr.write(`· turn ended: ${reason}\n`);
      }
    });

    await driver.send(prompt);
    /**
     * @type {{ completed: boolean, reason: object | undefined, text: string }}
     */
    let summary;
    try {
      summary = await driver.waitIdle({ timeoutMs });
    } catch (error) {
      if (interrupted) {
        if (streamed) stdout.write('\n');
        stderr.write('interrupted: the runtime was killed (the SDK protocol has no cancel).\n');
        return 130;
      }
      throw error;
    }

    if (!streamed) {
      // No streamed text: fall back to the driver's retained tail.
      const text = summary.text.replace(/\s+$/, '');
      if (text !== '') stdout.write(text);
    }
    if (streamed || summary.text !== '') stdout.write('\n');
    if (summary.completed !== true) {
      const reason = summary.reason?.kind ?? 'unknown';
      stderr.write(`dsh-cli: the turn ended without completing (${reason}).\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (interrupted) return 130;
    const report = describeError(error, context);
    stderr.write(`dsh-cli: ${report.message}\n`);
    if (report.hint !== undefined) stderr.write(`${report.hint}\n`);
    return report.exitCode;
  } finally {
    process.off('SIGINT', onSigint);
    if (driver !== null) {
      try {
        await driver.close();
      } catch {
        /* the runtime is killed regardless */
      }
    }
  }
}
