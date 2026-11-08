#!/usr/bin/env node
/**
 * Set up everything `dsh-cli` needs in one command.
 *
 * `install.mjs` writes the launchers and the DSH profiles. Two more pieces are
 * configuration rather than installation, and asking the user to remember them
 * is how a setup guide grows into a checklist:
 *
 * - the T3 Code provider entry, which only makes sense when T3 is installed;
 * - the alias names, which are a one-time choice.
 *
 * So `setup.mjs` runs the installer and then registers the T3 provider when a
 * T3 settings file exists. Every piece is idempotent, so re-running it after a
 * Desktop model change is the supported way to refresh.
 *
 * Usage:
 *   node scripts/setup.mjs [--dry-run] [--alias <names>] [--dir <bin-dir>]
 *                          [--force] [--no-t3] [--no-profile]
 *
 * @module scripts/setup
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runInstall } from './install.mjs';
import { resolveT3Home, runT3Command } from '../src/cli/t3.js';

/**
 * Parse this script's flags.
 *
 * Unknown flags are an error rather than a silently ignored typo: a mistyped
 * `--alias` that is ignored installs a launcher the user did not ask for.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {{ dryRun: boolean, force: boolean, binDir?: string, aliases: string[],
 *   t3: boolean, installProfile: boolean, help: boolean }} Options.
 * @throws {Error} On an unknown flag or a missing value.
 */
export function parseSetupOptions(argv) {
  /** @type {{ dryRun: boolean, force: boolean, binDir?: string, aliases: string[], t3: boolean, installProfile: boolean, help: boolean }} */
  const options = { dryRun: false, force: false, aliases: [], t3: true, installProfile: true, help: false };
  /** @type {string[]} */
  const aliases = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') {
      options.dryRun = true;
    } else if (token === '--force') {
      options.force = true;
    } else if (token === '--no-t3') {
      options.t3 = false;
    } else if (token === '--no-profile') {
      options.installProfile = false;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    } else if (token === '--dir' || token === '--alias' || token === '--aliases') {
      const value = argv[index + 1];
      if (value === undefined || value === '') throw new Error(`${token} needs a value`);
      index += 1;
      if (token === '--dir') options.binDir = path.resolve(value);
      else aliases.push(value);
    } else if (token.startsWith('--alias=') || token.startsWith('--aliases=')) {
      aliases.push(token.slice(token.indexOf('=') + 1));
    } else if (token.startsWith('--dir=')) {
      options.binDir = path.resolve(token.slice('--dir='.length));
    } else {
      throw new Error(`unknown option: ${token}`);
    }
  }
  options.aliases = splitAliases(aliases);
  return options;
}

/**
 * Split comma-separated alias values, dropping blanks.
 *
 * @param {string[]} values Raw values.
 * @returns {string[]} Alias names in the order given.
 */
function splitAliases(values) {
  /** @type {string[]} */
  const names = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      const name = part.trim();
      if (name !== '' && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Whether T3 Code has a settings file to register into.
 *
 * Registering into a directory T3 never created would leave a stray file that
 * the application may then ignore, so setup only touches T3 when it is there.
 *
 * @param {Record<string, string | undefined>} env Environment to read.
 * @returns {boolean} True when the settings file exists.
 */
export function t3Present(env = process.env) {
  return existsSync(path.join(resolveT3Home(env), 'userdata', 'settings.json'));
}

/**
 * Resolve the DSH home the same way the runtime does.
 *
 * @param {Record<string, string | undefined>} env Environment to read.
 * @returns {string} Absolute DSH home.
 */
export function resolveDshHome(env = process.env) {
  return env.DSH_HOME !== undefined && env.DSH_HOME !== ''
    ? env.DSH_HOME
    : path.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), '.dsh');
}

const HELP = `Set up dsh-cli: launchers, DSH profile, T3 Code provider.

Usage: node scripts/setup.mjs [--dry-run] [--alias <names>] [--dir <bin-dir>]
                              [--force] [--no-t3] [--no-profile]

  --alias dsh,deepseek   also install those command names
  --dir <path>           write the launchers there instead of the default
  --no-t3                leave T3 Code's settings alone
  --force                overwrite an existing launcher or T3 entry
  --dry-run              print every path, write nothing

Run it again after changing models or providers in Desktop.
`;

/**
 * Run the whole setup.
 *
 * @param {{ dryRun?: boolean, force?: boolean, binDir?: string, aliases?: string[],
 *   t3?: boolean, installProfile?: boolean,
 *   env?: Record<string, string | undefined>,
 *   stdout?: { write(text: string): void },
 * }} [options] Wiring overrides.
 * @returns {Promise<{ install: object, t3: 'registered' | 'already' | 'absent' | 'skipped' | 'failed' }>}
 */
export async function runSetup(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const dryRun = options.dryRun === true;

  const install = await runInstall({
    dryRun,
    force: options.force === true,
    aliases: options.aliases ?? [],
    installProfile: options.installProfile !== false,
    env,
    stdout,
    ...(options.binDir === undefined ? {} : { binDir: options.binDir }),
  });

  let t3 = 'skipped';
  if (options.t3 !== false) {
    if (!t3Present(env)) {
      t3 = 'absent';
      if (!dryRun) stdout.write('t3 code: not installed, skipped\n');
    } else {
      const code = runT3Command(
        { env, dshHome: resolveDshHome(env) },
        { action: 'register', dryRun, force: options.force === true, stdout, stderr: stdout },
      );
      t3 = code === 0 ? 'registered' : 'failed';
    }
  }

  return { install, t3 };
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {Promise<number>} Process exit code.
 */
async function main(argv) {
  let options;
  try {
    options = parseSetupOptions(argv);
  } catch (error) {
    process.stderr.write(`dsh-cli setup: ${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const result = await runSetup(options);
  for (const note of result.install.notes) process.stdout.write(`note: ${note}\n`);
  process.stdout.write(
    options.dryRun
      ? '\ndry run: nothing written\n'
      : '\nnext: dsh-cli doctor      # runtime, profile, route, T3 in one pass\n' +
          '      dsh-cli             # start the terminal UI\n',
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`dsh-cli setup failed: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
