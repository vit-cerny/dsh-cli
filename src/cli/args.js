/**
 * Zero-dependency argument parser for `dsh-cli`.
 *
 * Deliberately hand-written instead of pulling in a parser: the whole point of
 * this client is zero runtime dependencies (see docs/reports/ADR-001-stack.md).
 *
 * Grammar:
 *
 *   dsh-cli [global options] [command] [command arguments]
 *
 *   global options   --help/-h, --version/-V, --profile <name>,
 *                    --provider <id>, --model <id>, --cwd <path>
 *   commands         (none)          interactive terminal UI
 *                    run <prompt>    one-shot, non-interactive
 *                    resume <id>     reopen a persisted session
 *                    models          list models of the active profile
 *                    providers       list configured providers
 *                    sessions        list persisted sessions
 *                    skills          list skills the runtime will mount
 *                    mcp             list configured MCP servers
 *
 * A value flag (`--profile x`, `--model=x`) is accepted before **and** after
 * the command name, so both `dsh-cli --model m run "x"` and
 * `dsh-cli run "x" --model m` work. After a command name, a flag is only taken
 * as a global flag when the command declares that option; otherwise every
 * remaining token — including anything starting with `-` — belongs to the
 * command. That is what lets `dsh-cli run "-- explain this"` pass a prompt that
 * starts with a dash.
 *
 * @module src/cli/args
 */

/** Value-carrying global options: flag → option name. */
const VALUE_FLAGS = Object.freeze({
  '--profile': 'profile',
  '--provider': 'provider',
  '--model': 'model',
  '--cwd': 'cwd',
});

/** Boolean global options: flag → option name. */
const BOOLEAN_FLAGS = Object.freeze({
  '--help': 'help',
  '-h': 'help',
  '--version': 'version',
  '-V': 'version',
  '--json': 'json',
  '--apply': 'apply',
  '--force': 'force',
  '--dry-run': 'dryRun',
});

/** Exit code for a usage error (unknown flag, missing argument, bad command). */
export const EXIT_USAGE = 2;

/**
 * Command table. `positional` names the argument(s) the command consumes;
 * `arity` is `1` (exactly one token or a joined remainder) or `0` (none).
 *
 * @typedef {object} CommandSpec
 * @property {string} name
 * @property {string} summary One line for `--help`.
 * @property {string} [usage] Argument synopsis, e.g. `<prompt>`.
 * @property {'interactive' | 'run' | 'info'} kind How `src/cli/` dispatches it.
 * @property {boolean} [positional] Whether the command takes one argument.
 * @property {boolean} [optional] The argument is optional, not required.
 * @property {string[]} [options] Extra value options valid for this command.
 */

/** @type {readonly CommandSpec[]} */
export const COMMANDS = Object.freeze([
  Object.freeze({
    name: 'run',
    summary: 'Send one prompt, print the reply, exit (non-interactive)',
    usage: '<prompt>',
    kind: 'run',
    positional: true,
    options: ['--timeout'],
  }),
  Object.freeze({
    name: 'resume',
    summary: 'Reopen a persisted session in the terminal UI',
    usage: '<sessionId>',
    kind: 'interactive',
    positional: true,
  }),
  Object.freeze({
    name: 'models',
    summary: 'List models available on the active profile',
    kind: 'info',
  }),
  Object.freeze({
    name: 'providers',
    summary: 'List providers configured on the active profile',
    kind: 'info',
  }),
  Object.freeze({
    name: 'sessions',
    summary: 'List persisted sessions (newest first)',
    kind: 'info',
  }),
  Object.freeze({
    name: 'skills',
    summary: 'List skills the runtime mounts into the system prompt',
    kind: 'info',
  }),
  Object.freeze({
    name: 'mcp',
    summary: 'List configured MCP servers',
    kind: 'info',
  }),
  Object.freeze({
    name: 'plugins',
    summary: 'List Desktop plugins and whether the CLI profile mounts them',
    usage: '[sync]',
    kind: 'info',
    positional: true,
    optional: true,
  }),
  Object.freeze({
    name: 'migrate',
    summary: 'Plan (or --apply) an import of skills, MCPs and sessions from another harness',
    usage: '[source]',
    kind: 'info',
    positional: true,
    optional: true,
  }),
  Object.freeze({
    name: 'usage',
    summary: 'Show token and cost totals for a session, or for the whole store',
    usage: '[sessionId]',
    kind: 'info',
    positional: true,
    optional: true,
  }),
  Object.freeze({
    name: 'doctor',
    summary: 'Check runtime, profile, credentials and plugins in one pass',
    kind: 'info',
  }),
  Object.freeze({
    name: 't3',
    summary: 'Use DSH as a T3 Code provider over ACP (status, register, unregister)',
    usage: '[status|register|unregister]',
    kind: 'info',
    positional: true,
    optional: true,
  }),
]);

/**
 * Raised for any command line this parser cannot honour. `src/cli/` prints the
 * message and exits {@link EXIT_USAGE}.
 */
export class UsageError extends Error {
  /**
   * @param {string} message What is wrong, phrased for the end user.
   */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = EXIT_USAGE;
  }
}

/**
 * @param {string} name Command name.
 * @returns {CommandSpec | undefined} The spec, when the command exists.
 */
export function findCommand(name) {
  return COMMANDS.find((command) => command.name === name);
}

/**
 * Parse `process.argv.slice(2)`.
 *
 * @param {string[]} argv Arguments without the executable and script path.
 * @returns {{
 *   command: CommandSpec | null,
 *   help: boolean,
 *   version: boolean,
 *   options: { profile?: string, provider?: string, model?: string, cwd?: string,
 *     timeout?: string },
 *   positionals: string[],
 *   passthrough: string[],
 * }} The parsed command line. `command === null` means interactive mode.
 * @throws {UsageError} For an unknown flag, a missing value, or too many arguments.
 */
export function parseArgs(argv) {
  const tokens = Array.isArray(argv) ? argv.map(String) : [];
  /** @type {ReturnType<typeof parseArgs>} */
  const result = {
    command: null,
    help: false,
    version: false,
    options: {},
    positionals: [],
    passthrough: [],
  };

  let index = 0;
  let passthroughOnly = false;
  const commandOptions = new Set();

  while (index < tokens.length) {
    const token = tokens[index];

    if (passthroughOnly) {
      result.passthrough.push(token);
      index += 1;
      continue;
    }
    if (token === '--') {
      // Everything after `--` belongs to the command (or is a stray argument).
      const rest = tokens.slice(index + 1);
      if (result.command?.positional === true) {
        // Positionals are assembled from `passthrough` below; keep collecting
        // but do not also copy this first batch or it would be duplicated.
        passthroughOnly = true;
        index += 1;
        continue;
      }
      result.passthrough.push(...rest);
      index = tokens.length;
      continue;
    }

    // Split `--flag=value` once; both halves are then handled uniformly.
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = eq > 0 ? token.slice(0, eq) : token;
    const inlineValue = eq > 0 ? token.slice(eq + 1) : undefined;

    if (Object.hasOwn(BOOLEAN_FLAGS, flag) && inlineValue === undefined) {
      const option = BOOLEAN_FLAGS[flag];
      if (option === 'help' || option === 'version') result[option] = true;
      else result.options[option] = true;
      index += 1;
      continue;
    }

    const globalOption = VALUE_FLAGS[flag];
    const commandOption = commandOptions.has(flag) ? flag : undefined;
    if (globalOption !== undefined || commandOption !== undefined) {
      let value = inlineValue;
      if (value === undefined) {
        value = tokens[index + 1];
        if (
          value === undefined ||
          Object.hasOwn(VALUE_FLAGS, value) ||
          Object.hasOwn(BOOLEAN_FLAGS, value) ||
          commandOptions.has(value)
        ) {
          throw new UsageError(`missing value for ${flag}`);
        }
        index += 1;
      }
      if (value === '') throw new UsageError(`empty value for ${flag}`);
      if (globalOption !== undefined) result.options[globalOption] = value;
      else result.options[commandOption.slice(2)] = value;
      index += 1;
      continue;
    }

    if (result.command !== null) {
      if (!result.command.positional) throw new UsageError(`unexpected argument: ${token}`);
      // A positional command keeps scanning so a recognized option written
      // after the prompt (`run "x" --timeout 90s`) is still an option. Any
      // other dash token is prompt text, so `run explain --foo` still works.
      result.positionals.push(token);
      index += 1;
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      throw new UsageError(`unknown option: ${token}`);
    }

    const command = findCommand(token);
    if (command === undefined) {
      throw new UsageError(`unknown command: ${token}`);
    }
    result.command = command;
    for (const option of command.options ?? []) commandOptions.add(option);
    index += 1;
  }

  if (result.command?.positional === true) {
    // Tokens before `--` are collected one at a time; everything after `--` is
    // passthrough. Joining both keeps `run -- --flag` exact and still supports
    // an unquoted multi-word prompt.
    const joined = [...result.positionals, ...result.passthrough].join(' ');
    if (joined.trim() === '') {
      if (result.command.optional === true) {
        result.positionals = [];
        result.passthrough = [];
        return result;
      }
      throw new UsageError(`missing argument: dsh-cli ${result.command.name} ${result.command.usage ?? ''}`);
    }
    result.positionals = [joined];
    result.passthrough = [];
  }

  return result;
}
