/**
 * `dsh-cli t3`: use DSH as a provider inside T3 Code.
 *
 * T3 Code has no "run any CLI" provider, but its `acpRegistry` driver supports
 * `source: "local"`: it spawns a command and speaks Agent Client Protocol over
 * stdio. DSH ships an ACP server (`--profile acp`), and the installer already
 * generates `dsh-cli-acp` with the Desktop capability rows, so the two fit
 * without patching either application.
 *
 * This module owns the three actions a user needs: see whether T3 has the
 * provider, add it, and remove it again. It edits exactly one key
 * (`providerInstances.acpRegistry`) in T3's settings and nothing else.
 *
 * @module src/cli/t3
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { resolveRuntimeBin } from './discover.js';

/** Provider instance id T3 shows in its picker. */
export const INSTANCE_ID = 'acpRegistry';

/** Pipeline the entry launches: an ACP server with Desktop capability rows. */
export const ACP_PROFILE = 'dsh-cli-acp';

/**
 * Locate the T3 Code data directory.
 *
 * @param {Record<string, string | undefined>} [env] Environment to read.
 * @returns {string} Absolute path.
 */
export function resolveT3Home(env = process.env) {
  return env.T3CODE_HOME !== undefined && env.T3CODE_HOME !== ''
    ? env.T3CODE_HOME
    : path.join(os.homedir(), '.t3');
}

/**
 * Build the provider instance T3 should store.
 *
 * @param {{ nodePath?: string, runtimeBin?: string, profile?: string }} [options] Overrides.
 * @returns {object} One `providerInstances` entry.
 */
export function buildProviderInstance(options = {}) {
  return {
    driver: 'acpRegistry',
    displayName: 'DSH CLI',
    enabled: true,
    config: {
      source: 'local',
      commandPath: options.nodePath ?? process.execPath,
      commandArgs: [
        options.runtimeBin ?? resolveRuntimeBin().bin ?? '',
        '--profile',
        options.profile ?? ACP_PROFILE,
      ],
    },
  };
}

/**
 * Merge the provider into an existing settings object.
 *
 * @param {Record<string, any>} settings Current settings.
 * @param {object} instance Provider instance to add.
 * @param {{ force?: boolean }} [options] `force` replaces an existing entry.
 * @returns {{ settings: Record<string, any>, changed: boolean, existed: boolean }} Result.
 */
export function mergeProviderSettings(settings, instance, options = {}) {
  const current = settings !== null && typeof settings === 'object' ? settings : {};
  const instances =
    current.providerInstances !== null && typeof current.providerInstances === 'object'
      ? { ...current.providerInstances }
      : {};
  const existed = Object.hasOwn(instances, INSTANCE_ID);
  if (existed && options.force !== true) {
    return { settings: current, changed: false, existed };
  }
  instances[INSTANCE_ID] = instance;
  return { settings: { ...current, providerInstances: instances }, changed: true, existed };
}

/**
 * Remove the provider, leaving every other key untouched.
 *
 * @param {Record<string, any>} settings Current settings.
 * @returns {{ settings: Record<string, any>, changed: boolean }} Result.
 */
export function removeProviderSettings(settings) {
  const current = settings !== null && typeof settings === 'object' ? settings : {};
  if (current.providerInstances === null || typeof current.providerInstances !== 'object') {
    return { settings: current, changed: false };
  }
  if (!Object.hasOwn(current.providerInstances, INSTANCE_ID)) {
    return { settings: current, changed: false };
  }
  const instances = { ...current.providerInstances };
  delete instances[INSTANCE_ID];
  return { settings: { ...current, providerInstances: instances }, changed: true };
}

/**
 * Read T3 settings without interpreting them.
 *
 * @param {string} home T3 Code data directory.
 * @returns {{ file: string, settings: Record<string, any> | null, error?: string }} Result.
 */
export function readT3Settings(home) {
  const file = path.join(home, 'userdata', 'settings.json');
  if (!existsSync(file)) return { file, settings: {} };
  try {
    // A hand-edited settings file on Windows commonly starts with a UTF-8 BOM,
    // which JSON.parse rejects even though every JSON reader accepts it.
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return { file, settings: JSON.parse(text) };
  } catch (error) {
    return { file, settings: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run `dsh-cli t3`.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @param {{ stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream,
 *   action?: string, force?: boolean, dryRun?: boolean, json?: boolean,
 *   home?: string }} [options] Wiring overrides.
 * @returns {number} Exit code.
 */
export function runT3Command(context, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const action = options.action ?? 'status';
  const home = options.home ?? resolveT3Home(context.env ?? process.env);
  const write = (line) => stdout.write(`${line}\n`);

  if (!['status', 'register', 'unregister'].includes(action)) {
    stderr.write(`dsh-cli: unknown t3 action "${action}" (use status, register or unregister)\n`);
    return 2;
  }

  const read = readT3Settings(home);
  if (read.settings === null) {
    stderr.write(`dsh-cli: ${read.file} is not valid JSON: ${read.error}\n`);
    return 1;
  }

  const existing = read.settings.providerInstances?.[INSTANCE_ID];

  if (options.json === true) {
    write(JSON.stringify({ home, file: read.file, instance: existing ?? null }, null, 2));
    return 0;
  }

  if (action === 'status') {
    write(`t3 home:    ${home}`);
    write(`settings:   ${read.file}`);
    if (existing === undefined) {
      write('provider:   not registered');
      write('register:   dsh-cli t3 register');
      return 0;
    }
    const args = Array.isArray(existing.config?.commandArgs) ? existing.config.commandArgs : [];
    write(`provider:   ${existing.displayName ?? INSTANCE_ID} (${existing.enabled === false ? 'disabled' : 'enabled'})`);
    write(`command:    ${existing.config?.commandPath ?? '?'} ${args.join(' ')}`);
    write(`profile:    ${args[2] ?? '?'}`);
    if (args[2] !== undefined && !existsSync(path.join(context.dshHome, 'profiles', args[2], 'package.json'))) {
      write(`note:       profile "${args[2]}" is missing; run node scripts/install-profile.mjs`);
    }
    return 0;
  }

  if (action === 'unregister') {
    const removed = removeProviderSettings(read.settings);
    if (!removed.changed) {
      write('provider is not registered; nothing to remove');
      return 0;
    }
    if (options.dryRun === true) {
      write(`dry run: would remove ${INSTANCE_ID} from ${read.file}`);
      return 0;
    }
    writeSettings(read.file, removed.settings);
    write(`removed ${INSTANCE_ID} from ${read.file}`);
    write('restart T3 Code to drop "DSH CLI" from the provider picker');
    return 0;
  }

  const instance = buildProviderInstance();
  if (instance.config.commandArgs[0] === '') {
    stderr.write('dsh-cli: could not locate the DSH runtime. Set DSH_CLI_RUNTIME_BIN.\n');
    return 1;
  }
  const merged = mergeProviderSettings(read.settings, instance, { force: options.force === true });
  if (!merged.changed) {
    write(`already registered as ${INSTANCE_ID}; pass --force to replace it`);
    return 0;
  }
  if (options.dryRun === true) {
    write(`dry run: would write ${INSTANCE_ID} to ${read.file}`);
    write(`  ${instance.config.commandPath} ${instance.config.commandArgs.join(' ')}`);
    return 0;
  }
  writeSettings(read.file, merged.settings);
  write(`registered "DSH CLI" in ${read.file}`);
  write(`  ${instance.config.commandPath} ${instance.config.commandArgs.join(' ')}`);
  write('restart T3 Code, then pick "DSH CLI" as the provider');
  return 0;
}

/**
 * Write settings atomically enough for a config file T3 reads at startup.
 *
 * @param {string} file Target path.
 * @param {Record<string, any>} settings New contents.
 * @returns {void}
 */
function writeSettings(file, settings) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}