#!/usr/bin/env node
/**
 * `dsh-cli` — DeepSeek Harness terminal client.
 *
 * This file is a thin dispatcher: it parses arguments, resolves the runtime
 * and route once, and hands control to one module under `src/cli/`. All the
 * behaviour lives there (and in `src/rpc/`, `src/session/`, `src/ui/`).
 *
 * Design constraints, unchanged from the scaffold: pure ESM, **zero runtime
 * dependencies** (no `node_modules`), no build step. See
 * docs/reports/ADR-001-stack.md for why.
 *
 * Exit codes:
 *   0    success
 *   1    the turn or the runtime failed
 *   2    usage error (unknown command or option, missing argument)
 *   130  interrupted (Ctrl+C)
 *
 * @module dsh-cli/main
 */

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import { COMMANDS, EXIT_USAGE, UsageError, parseArgs } from './cli/args.js';
import { CliError, describeError, resolveContext } from './cli/context.js';
import { runInfoCommand, runSessionsCommand } from './cli/info.js';
import { runInteractive } from './cli/interactive.js';
import { runPluginsCommand } from './cli/plugins.js';
import { runMigrateCommand } from './cli/migrate.js';
import { runUsageCommand } from './cli/usage-command.js';
import { runDoctorCommand } from './cli/doctor.js';
import { parseTimeout, runOnce } from './cli/run.js';
import { writeLine } from './cli/index.js';

/**
 * Read and parse the package manifest that owns this entry point.
 *
 * @returns {{ name?: string, version?: string }} Parsed package.json fields.
 */
export function readManifest() {
  const manifestUrl = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(manifestUrl, 'utf8'));
}

/**
 * The `--help` text.
 *
 * @param {string} version Version shown in the header.
 * @returns {string} Help text, newline-terminated.
 */
export function renderHelp(version) {
  const usageWidth = COMMANDS.reduce(
    (max, command) => Math.max(max, `dsh-cli ${command.name} ${command.usage ?? ''}`.trim().length),
    0,
  );
  const lines = [
    `dsh-cli ${version} — DeepSeek Harness terminal client`,
    '',
    'Usage:',
    '  dsh-cli [options]                 start the interactive terminal UI',
    '  dsh-cli <command> [options]       run one command',
    '',
    'Commands:',
  ];
  for (const command of COMMANDS) {
    const synopsis = `dsh-cli ${command.name} ${command.usage ?? ''}`.trim();
    lines.push(`  ${synopsis.padEnd(usageWidth)}  ${command.summary}`);
  }
  lines.push(
    '',
    'Options:',
    '  -h, --help             show this help and exit',
    '  -V, --version          print the version and exit',
    '  --profile <name>       DSH profile (default: dsh-cli when installed, else sdk; desktop for inventory commands)',
    '  --provider <id>        provider route (default: from the profile patch)',
    '  --model <id>           model id (default: from the profile patch)',
    '  --cwd <path>           working directory for the session (default: $PWD)',
    '  --timeout <duration>   `run` only: per-turn limit, e.g. 90s, 5m (default: 10m)',
    '  --json                 output machine-readable inventory for models/providers/skills/mcp',
    '  --apply                `plugins sync` / `migrate`: write changes (default is a dry run)',
    '  --force                `migrate`: overwrite an existing destination',
    '',
    'Environment:',
    '  DSH_CLI_RUNTIME_BIN    runtime entry point (default: auto-detected Desktop install)',
    '  DSH_CLI_PROFILE        default profile when --profile is absent',
    '  DSH_CLI_PROVIDER       default provider when --provider is absent',
    '  DSH_CLI_MODEL          default model when --model is absent',
    '  DSH_CLI_REASONING=1    show chain-of-thought (hidden by default)',
    '  DSH_CLI_SHOW_SYSTEM=1  echo the runtime system prompt (hidden by default)',
    '  DSH_HOME               DSH home directory (default: ~/.dsh)',
    '',
    'Exit codes: 0 ok · 1 failure · 2 usage · 130 interrupted',
    '',
  );
  return `${lines.join('\n')}`;
}

/**
 * Dispatch one parsed command line.
 *
 * @param {string[]} argv Arguments without the executable and script path.
 * @param {{
 *   stdout?: NodeJS.WriteStream,
 *   stderr?: NodeJS.WriteStream,
 *   stdin?: NodeJS.ReadStream,
 *   env?: Record<string, string | undefined>,
 *   cwd?: string,
 *   version?: string,
 *   runOnceFn?: typeof runOnce,
 *   runInteractiveFn?: typeof runInteractive,
 * }} [options] Wiring overrides (used by tests).
 * @returns {Promise<number>} Process exit code.
 */
export async function dispatch(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const version = options.version ?? readManifest().version ?? '0.0.0';

  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.options.timeout !== undefined) {
      // Validate early: a malformed duration is a usage error, not a late crash.
      parsed.options.timeoutMs = String(parseTimeout(parsed.options.timeout));
    }
  } catch (error) {
    const code = /** @type {any} */ (error)?.exitCode ?? EXIT_USAGE;
    const message = error instanceof UsageError ? `dsh-cli: ${error.message}` : `dsh-cli: ${String(error)}`;
    writeLine(stderr, message);
    writeLine(stderr, "run 'dsh-cli --help' for usage");
    return code;
  }

  if (parsed.version === true) {
    writeLine(stdout, version);
    return 0;
  }
  if (parsed.help === true) {
    stdout.write(renderHelp(version));
    return 0;
  }

  const contextEnv = options.env ?? process.env;

  /** @type {import('./cli/context.js').CliContext} */
  let context;
  try {
    context = resolveContext({
      options: { ...parsed.options },
      env: contextEnv,
      cwd: options.cwd,
      kind: parsed.command?.kind === 'info' ? 'inventory' : 'session',
    });
  } catch (error) {
    const report = describeError(error);
    writeLine(stderr, `dsh-cli: ${report.message}`);
    if (report.hint !== undefined) writeLine(stderr, report.hint);
    return report.exitCode;
  }

  const command = parsed.command;
  try {
    if (command === null) {
      const runInteractiveFn = options.runInteractiveFn ?? runInteractive;
      return await runInteractiveFn(context, {
        version,
        stdin: options.stdin,
        stdout,
        stderr,
      });
    }

    switch (command.kind) {
      case 'run': {
        const runOnceFn = options.runOnceFn ?? runOnce;
        const prompt = parsed.positionals[0] ?? '';
        const timeoutValue = parsed.options.timeout;
        const timeoutMs = timeoutValue === undefined ? undefined : parseTimeout(timeoutValue);
        return await runOnceFn(context, prompt, {
          stdout,
          stderr,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      }
      case 'interactive': {
        const runInteractiveFn = options.runInteractiveFn ?? runInteractive;
        return await runInteractiveFn(context, {
          version,
          resumeId: parsed.positionals[0],
          stdin: options.stdin,
          stdout,
          stderr,
        });
      }
      case 'info': {
        if (command.name === 'sessions') {
          return runSessionsCommand(context, { stdout });
        }
        if (command.name === 'plugins') {
          return runPluginsCommand(context, {
            stdout,
            json: parsed.options.json === true,
            sync: parsed.positionals[0] === 'sync',
            apply: parsed.options.apply === true,
          });
        }
        if (command.name === 'migrate') {
          return runMigrateCommand(context, {
            stdout,
            stderr,
            source: parsed.positionals[0],
            apply: parsed.options.apply === true,
            force: parsed.options.force === true,
            json: parsed.options.json === true,
          });
        }
        if (command.name === 'usage') {
          return runUsageCommand(context, {
            stdout,
            sessionId: parsed.positionals[0],
            json: parsed.options.json === true,
          });
        }
        if (command.name === 'doctor') {
          return runDoctorCommand(context, { stdout });
        }
        return runInfoCommand(context, /** @type {'providers'|'models'|'skills'|'mcp'} */ (command.name), {
          stdout,
          json: parsed.options.json === true,
        });
      }
      default:
        throw new CliError(`command "${command.name}" is not implemented`, { exitCode: EXIT_USAGE });
    }
  } catch (error) {
    if (error instanceof CliError && error.exitCode === EXIT_USAGE) {
      writeLine(stderr, `dsh-cli: ${error.message}`);
      return EXIT_USAGE;
    }
    const report = describeError(error, context);
    writeLine(stderr, `dsh-cli: ${report.message}`);
    if (report.hint !== undefined) writeLine(stderr, report.hint);
    return report.exitCode;
  }
}

/**
 * Process entry point.
 *
 * @param {string[]} [argv] Arguments without the executable and script path.
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv = process.argv.slice(2)) {
  return dispatch(argv);
}

/**
 * Whether this module is the process entry point.
 *
 * `npm link` installs a junction, so `process.argv[1]` may be a link path while
 * `import.meta.url` resolves to the real file. Comparing real paths keeps the
 * CLI working through a linked or symlinked bin shim.
 *
 * @returns {boolean} True when executed directly, false when imported.
 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (invokedDirectly()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`dsh-cli: unexpected failure: ${error?.stack ?? String(error)}\n`);
      process.exitCode = 1;
    });
}
