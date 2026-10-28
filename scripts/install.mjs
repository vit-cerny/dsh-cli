#!/usr/bin/env node
/**
 * Install `dsh-cli` onto PATH for the current user.
 *
 * The CLI is a plain ESM entry point, so "installing" means two things:
 *
 * 1. a launcher on PATH that runs `src/main.js` with the current Node;
 * 2. a `dsh-cli` DSH profile the runtime can boot (see install-profile.mjs).
 *
 * This script is deliberately boring and reversible: it writes into
 * `~/.local/bin` (or `%USERPROFILE%\.dsh-cli\bin` on Windows) and prints the
 * exact line it appended to PATH. `uninstall.mjs` removes the same entries by
 * marker, so nothing else in PATH is ever touched.
 *
 * Usage:
 *   node scripts/install.mjs [--dry-run] [--dir <bin-dir>] [--no-profile] [--force]
 *                            [--alias <name>]... [--aliases <a,b>]
 *
 * `--alias` writes an extra launcher with that name into the same directory, so
 * `dsh` or `deepseek` can open the terminal UI directly. The chosen names are
 * recorded in `~/.dsh-cli/installed.json`, which is what makes them removable
 * again by `uninstall.mjs`.
 *
 * @module scripts/install
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { installProfile } from './install-profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(ROOT, 'src', 'main.js');

/** Every PATH line this installer writes carries this marker, so uninstall can find it. */
export const MARKER = '# dsh-cli launcher';

/** Launcher name installed when no `--alias` is given. */
export const DEFAULT_LAUNCHER = 'dsh-cli';

/**
 * Validate one command name before it becomes a file on PATH.
 *
 * Aliases land in a directory that is already on PATH, so a name containing a
 * separator or a Windows-reserved device name would escape the install
 * directory or collide with the shell. Reject those instead of writing them.
 *
 * Whether the name is *already taken* is a separate question, answered against
 * the live PATH by {@link findShadowingCommand}. A hardcoded deny-list cannot
 * answer it: `dsh` is not on PATH on a machine that only has the Desktop app
 * installed, and refusing it would block the most useful alias of all.
 *
 * @param {string} name Candidate launcher name.
 * @returns {string} The same name, when it is safe.
 */
export function assertLauncherName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error(`invalid launcher name: ${JSON.stringify(name)} (use letters, digits, ".", "_" or "-")`);
  }
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) {
    throw new Error(`invalid launcher name: ${name} is a reserved Windows device name`);
  }
  return name;
}

/**
 * Split a comma-separated alias list, dropping blanks and duplicates.
 *
 * @param {string[]} values Raw `--alias` / `--aliases` values.
 * @returns {string[]} Unique launcher names, in the order given.
 */
export function parseAliases(values) {
  /** @type {string[]} */
  const names = [];
  for (const value of values) {
    for (const part of String(value).split(',')) {
      const name = part.trim();
      if (name === '' || names.includes(name)) continue;
      names.push(assertLauncherName(name));
    }
  }
  return names;
}

/**
 * State directory that records what this installer wrote.
 *
 * Kept outside the launcher directory so an alias install never leaves a
 * manifest file where the user expects a command.
 *
 * @param {Record<string, string | undefined>} [env] Environment to read.
 * @returns {string} Absolute directory.
 */
export function stateDir(env = process.env) {
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  return path.join(home, '.dsh-cli');
}

/**
 * Manifest path for the launchers currently installed.
 *
 * Aliases are user-chosen names, so uninstall cannot guess them; the manifest
 * is what makes removal exact.
 *
 * @param {Record<string, string | undefined>} [env] Environment to read.
 * @returns {string} Absolute file path.
 */
export function stateFile(env = process.env) {
  return path.join(stateDir(env), 'installed.json');
}

/**
 * Read the install manifest, tolerating absence and corruption.
 *
 * @param {Record<string, string | undefined>} [env] Environment to read.
 * @returns {{ version: number, binDir: string, launchers: { name: string, path: string }[] } | undefined}
 */
export function readState(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(env), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.launchers)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Default launcher directory.
 *
 * `~/.local/bin` is the convention on macOS and Linux and is already on PATH on
 * many machines. Windows has no such convention, so a per-user directory is
 * used and added to PATH explicitly.
 *
 * @param {Record<string, string | undefined>} [env] Environment to read.
 * @param {string} [platform] `process.platform` override.
 * @returns {string} Absolute launcher directory.
 */
export function defaultBinDir(env = process.env, platform = process.platform) {
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  return platform === 'win32'
    ? path.join(home, '.dsh-cli', 'bin')
    : path.join(home, '.local', 'bin');
}

/**
 * The launcher body. A shell wrapper, not a copy: the checkout stays the single
 * source of truth, and `git pull` updates the installed command in place.
 *
 * @param {'win32' | 'posix'} platform Target platform family.
 * @returns {string} Script contents.
 */
export function launcherScript(platform, { entry = ENTRY, nodePath = process.execPath } = {}) {
  if (platform === 'win32') {
    return [
      '@echo off',
      'rem Generated by scripts/install.mjs; remove with scripts/uninstall.mjs',
      `"${nodePath}" "${entry}" %*`,
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    '# Generated by scripts/install.mjs; remove with scripts/uninstall.mjs',
    `exec "${nodePath}" "${entry}" "$@"`,
    '',
  ].join('\n');
}

/**
 * Read the user PATH without touching the machine-wide one.
 *
 * @param {string} [platform] `process.platform` override.
 * @returns {string[]} Non-empty PATH entries.
 */
export function readUserPath(platform = process.platform) {
  const raw = platform === 'win32' ? process.env.Path ?? process.env.PATH ?? '' : process.env.PATH ?? '';
  return raw.split(path.delimiter).filter((entry) => entry !== '');
}

/**
 * Whether a directory is already on PATH.
 *
 * @param {string} dir Absolute directory.
 * @param {string[]} entries PATH entries.
 * @param {string} [platform] `process.platform` override.
 * @returns {boolean} True when present (case-insensitive on Windows).
 */
export function isOnPath(dir, entries, platform = process.platform) {
  const normalize = (value) =>
    platform === 'win32' ? value.replace(/[\\/]+$/, '').toLowerCase() : value.replace(/\/+$/, '');
  const target = normalize(dir);
  return entries.some((entry) => normalize(entry) === target);
}

/**
 * Whether a PATH entry is one DSH Desktop injected for its own child sessions.
 *
 * Desktop prepends a directory of generated `dsh` shims to PATH inside the
 * shells it spawns. Those shims are not installed tools: they only exist while
 * a DSH session is running, and a launcher written to a real directory cannot
 * shadow them anyway. Counting them as a collision would refuse `dsh` in
 * exactly the place the user is most likely to run the installer.
 *
 * @param {string} entry Absolute PATH entry.
 * @returns {boolean} True when the entry belongs to Desktop's generated shims.
 */
export function isDesktopInjected(entry) {
  return /[\\/]DSH Desktop[\\/]host-commands[\\/]/i.test(entry);
}

/**
 * Find a command with this name that our launcher would not actually replace.
 *
 * The answer is read from PATH instead of a hardcoded list, because "is this
 * name taken" is a property of the machine, not of the installer. Anything
 * found in an earlier PATH entry wins over the directory we install into, so
 * installing there would silently do nothing.
 *
 * @param {string} name Launcher name without extension.
 * @param {string} binDir Directory the launcher is written to.
 * @param {string[]} entries PATH entries in resolution order.
 * @param {string} platform `process.platform` override.
 * @param {Record<string, string | undefined>} [env] Environment to read.
 * @returns {string | undefined} The shadowing path, when one exists.
 */
export function findShadowingCommand(name, binDir, entries, platform = process.platform, env = process.env) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  const own = normalize(binDir);
  const extensions =
    platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((value) => value !== '') : [''];
  for (const entry of entries) {
    const directory = normalize(entry);
    if (directory === own) return undefined;
    if (isDesktopInjected(entry)) continue;
    for (const extension of extensions) {
      const candidate = path.join(entry, `${name}${extension.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Run the installer.
 *
 * @param {{
 *   dryRun?: boolean,
 *   binDir?: string,
 *   installProfile?: boolean,
 *   force?: boolean,
 *   platform?: string,
 *   env?: Record<string, string | undefined>,
 *   aliases?: string[],
 *   stdout?: { write(text: string): void },
 * }} [options]
 * @returns {Promise<{ ok: boolean, binDir: string, launcher: string, launchers: string[], profile: string, onPath: boolean, notes: string[] }>}
 */
export async function runInstall(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const binDir = options.binDir ?? defaultBinDir(env, platform);
  const dryRun = options.dryRun === true;
  const withProfile = options.installProfile !== false;
  const suffix = platform === 'win32' ? '.cmd' : '';
  const names = [DEFAULT_LAUNCHER, ...(options.aliases ?? [])].map(assertLauncherName);
  /** @type {string[]} */
  const notes = [];

  const onPath = isOnPath(binDir, readUserPath(platform), platform);
  const entries = readUserPath(platform);

  // Refuse a name that a real tool earlier on PATH already owns: installing into
  // a directory ahead of it would shadow that tool for every later command, and
  // uninstalling would then appear to "delete" a command we never installed.
  // `--force` opts in for a deliberate override.
  if (options.force !== true) {
    for (const name of names) {
      const shadowing = findShadowingCommand(name, binDir, entries, platform, env);
      if (shadowing !== undefined) {
        throw new Error(
          `refusing to install "${name}": ${shadowing} already provides that command. Pick a distinct alias, or pass --force to override it.`,
        );
      }
    }
  }

  /** @type {string[]} */
  const launchers = names.map((name) => path.join(binDir, `${name}${suffix}`));

  if (!dryRun) {
    mkdirSync(binDir, { recursive: true });
    for (const launcher of launchers) {
      writeFileSync(launcher, launcherScript(platform === 'win32' ? 'win32' : 'posix'), 'utf8');
      if (platform !== 'win32') chmodSync(launcher, 0o755);
    }
    mkdirSync(stateDir(env), { recursive: true });
    writeFileSync(
      stateFile(env),
      `${JSON.stringify(
        { version: 1, binDir, launchers: names.map((name, index) => ({ name, path: launchers[index] })) },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  for (const launcher of launchers) stdout.write(`${dryRun ? 'would write' : 'wrote'} ${launcher}\n`);

  if (!onPath) {
    notes.push(`add ${binDir} to PATH (dsh-cli doctor prints the exact command)`);
  }

  let profile = 'skipped';
  if (withProfile) {
    if (dryRun) {
      profile = 'would install';
      stdout.write(`would install the dsh-cli profile under ${path.join(env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles', 'dsh-cli')}\n`);
    } else {
      const result = await installProfile({ env, force: options.force === true });
      profile = result.written ? 'installed' : 'unchanged';
      stdout.write(`profile: ${profile}\n`);
    }
  }

  return { ok: true, binDir, launcher: launchers[0], launchers, profile, onPath, notes };
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {Promise<number>} Process exit code.
 */
async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const noProfile = argv.includes('--no-profile');
  const force = argv.includes('--force');
  const dirIndex = argv.indexOf('--dir');
  const binDir = dirIndex >= 0 ? argv[dirIndex + 1] : undefined;
  const aliases = parseAliases(aliasValues(argv));

  const result = await runInstall({
    dryRun,
    installProfile: !noProfile,
    force,
    aliases,
    ...(binDir === undefined ? {} : { binDir }),
  });

  for (const note of result.notes) process.stdout.write(`note: ${note}\n`);
  if (!result.onPath) {
    process.stdout.write(
      process.platform === 'win32'
        ? `\nOn Windows, open a new terminal after adding the directory to PATH.\n`
        : `\nexport PATH="${result.binDir}:$PATH"\n`,
    );
  }
  const [primary] = path.basename(result.launchers[0]).split('.');
  process.stdout.write(`\nTry it: ${primary} --help\n`);
  return 0;
}

/**
 * Collect `--alias <name>` and `--aliases <a,b>` values from argv.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {string[]} Raw alias values.
 */
function aliasValues(argv) {
  /** @type {string[]} */
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--alias' || argument === '--aliases') {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('-')) {
        values.push(value);
        index += 1;
      }
      continue;
    }
    if (argument.startsWith('--alias=') || argument.startsWith('--aliases=')) {
      values.push(argument.slice(argument.indexOf('=') + 1));
    }
  }
  return values;
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
      process.stderr.write(`dsh-cli install failed: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    },
  );
}