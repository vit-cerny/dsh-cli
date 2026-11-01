#!/usr/bin/env node
/**
 * Register this CLI as a T3 Code ACP provider.
 *
 * T3 Code has no "run an arbitrary CLI" provider, but it does ship an
 * `acpRegistry` provider with a `source: "local"` mode that spawns any
 * executable speaking Agent Client Protocol. DSH ships ACP v1, so the two fit
 * together: T3 creates sessions, DSH runs the agent.
 *
 * This edits `$T3CODE_HOME/userdata/settings.json` (default `~/.t3`), adding one
 * `providerInstances` entry. It never touches project data, sessions or
 * credentials, and it refuses to overwrite an entry that already exists unless
 * `--force` is passed.
 *
 * Usage:
 *   node scripts/register-t3-provider.mjs [--dry-run] [--force] [--home <dir>]
 *
 * @module scripts/register-t3-provider
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveRuntimeBin } from '../src/cli/discover.js';

/** Provider instance id T3 shows in its picker. */
export const INSTANCE_ID = 'acpRegistry';

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
  const nodePath = options.nodePath ?? process.execPath;
  const runtimeBin =
    options.runtimeBin ?? resolveRuntimeBin().bin ?? '';
  const profile = options.profile ?? 'dsh-cli-acp';
  return {
    driver: 'acpRegistry',
    displayName: 'DSH CLI',
    enabled: true,
    config: {
      source: 'local',
      commandPath: nodePath,
      commandArgs: [runtimeBin, '--profile', profile],
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
 * Parse this script's flags.
 *
 * @param {string[]} argv Arguments after the script path.
 * @param {Record<string, string | undefined>} [env] Environment for the default home.
 * @returns {{ home: string, dryRun: boolean, force: boolean, help: boolean }} Options.
 */
export function parseOptions(argv, env = process.env) {
  const options = { home: resolveT3Home(env), dryRun: false, force: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--home') {
      const value = argv[index + 1];
      if (value === undefined || value === '') throw new Error('--home needs a path');
      options.home = path.resolve(value);
      index += 1;
    } else if (token === '--dry-run') {
      options.dryRun = true;
    } else if (token === '--force') {
      options.force = true;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${token}`);
    }
  }
  return options;
}

const HELP = `Register dsh-cli as a T3 Code ACP provider.

Usage: node scripts/register-t3-provider.mjs [--dry-run] [--force] [--home <dir>]

Adds one providerInstances entry ("${INSTANCE_ID}") to
<T3CODE_HOME>/userdata/settings.json, pointing at the dsh-cli-acp profile.

  --force    replace an existing entry instead of leaving it alone
  --home     T3 Code data directory (default: $T3CODE_HOME or ~/.t3)
`;

/**
 * Run the registration.
 *
 * @param {string[]} [argv] Arguments after the script path.
 * @param {{
 *   stdout?: { write(chunk: string): unknown },
 *   stderr?: { write(chunk: string): unknown },
 *   env?: Record<string, string | undefined>,
 * }} [io] Wiring overrides (tests).
 * @returns {number} Exit code.
 */
export function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let options;
  try {
    options = parseOptions(argv, io.env ?? process.env);
  } catch (error) {
    stderr.write(`register-t3-provider: ${error.message}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(HELP);
    return 0;
  }

  const settingsFile = path.join(options.home, 'userdata', 'settings.json');
  /** @type {Record<string, any>} */
  let settings = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    } catch (error) {
      stderr.write(`register-t3-provider: ${settingsFile} is not valid JSON: ${error.message}\n`);
      return 1;
    }
  }

  const instance = buildProviderInstance();
  if (instance.config.commandArgs[0] === '') {
    stderr.write(
      'register-t3-provider: could not locate the DSH runtime. Set DSH_CLI_RUNTIME_BIN.\n',
    );
    return 1;
  }

  const result = mergeProviderSettings(settings, instance, { force: options.force });
  stdout.write(`settings: ${settingsFile}\n`);
  stdout.write(`instance: ${INSTANCE_ID} → ${instance.config.commandPath}\n`);
  stdout.write(`args:     ${instance.config.commandArgs.join(' ')}\n`);
  if (!result.changed) {
    stdout.write('already registered; pass --force to replace it\n');
    return 0;
  }
  if (options.dryRun) {
    stdout.write('dry run: no files written\n');
    return 0;
  }

  mkdirSync(path.dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(result.settings, null, 2)}\n`, 'utf8');
  stdout.write('registered. Restart the T3 Code server, then pick "DSH CLI" as the provider.\n');
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exitCode = main();
}
