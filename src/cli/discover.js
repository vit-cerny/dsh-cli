/**
 * Locate the DSH runtime on whatever machine this runs on.
 *
 * `DEFAULT_RUNTIME_BIN` in `src/rpc/client.js` is a single hardcoded path, which
 * is correct only on the machine it was written on. This module finds the same
 * file from the install root, and reports the candidates it tried so a failure
 * names the actual paths instead of asking the user to guess.
 *
 * Resolution order, highest first:
 *   1. `DSH_CLI_RUNTIME_BIN` (explicit override always wins)
 *   2. the DSH app directory reported by an installed Desktop package
 *   3. the standard per-user and machine-wide install roots
 *
 * The probe is filesystem-only: no process spawn, no registry read, no network.
 *
 * @module src/cli/discover
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** Runtime entry point relative to a DSH app directory. */
export const RUNTIME_RELATIVE = path.join(
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib',
  'bin.js',
);

/**
 * Directories a DSH Desktop install is known to live in.
 *
 * These are conventions, not discoveries: each is probed and only an existing
 * one is returned, so a machine without Desktop simply yields no candidate.
 *
 * @param {Record<string, string | undefined>} [env] Environment to read.
 * @param {string} [platform] `process.platform` override (tests).
 * @returns {string[]} Candidate app directories, most likely first.
 */
export function desktopAppCandidates(env = process.env, platform = process.platform) {
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  if (platform === 'win32') {
    return [
      'C:\\Program Files\\DSH Desktop',
      'C:\\Program Files (x86)\\DSH Desktop',
      path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'DSH Desktop'),
      path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'DSH Desktop'),
    ];
  }
  if (platform === 'darwin') {
    return ['/Applications/DSH Desktop.app/Contents/Resources'];
  }
  return ['/opt/DSH Desktop/resources', path.join(home, '.local', 'share', 'dsh-desktop')];
}

/**
 * Resolve a candidate install root to its app directory.
 *
 * A packaged Electron app keeps JavaScript under `resources/app`; a development
 * checkout has `package.json` at the root itself.
 *
 * @param {string} root Candidate install root.
 * @returns {string | null} The app directory, or null when this root has none.
 */
export function appDirFromInstallRoot(root) {
  for (const candidate of [path.join(root, 'resources', 'app'), root]) {
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

/**
 * Find the runtime entry point under an app directory.
 *
 * @param {string} appDir DSH app directory.
 * @returns {string | null} Absolute runtime path, or null when absent.
 */
export function runtimeBinIn(appDir) {
  const bin = path.join(appDir, RUNTIME_RELATIVE);
  return existsSync(bin) ? bin : null;
}

/**
 * Resolve the runtime entry point.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   candidates?: string[],
 *   isFile?: (file: string) => boolean,
 * }} [options] Injection points (tests use them; production uses defaults).
 * @returns {{ bin: string | null, source: string, tried: string[] }} Resolution.
 *   `source` is `env`, `desktop`, or `none`.
 */
export function resolveRuntimeBin(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? ((file) => existsSync(file));
  /** @type {string[]} */
  const tried = [];

  const override = env.DSH_CLI_RUNTIME_BIN;
  if (override !== undefined && override !== '') {
    tried.push(override);
    if (isFile(override)) return { bin: override, source: 'env', tried };
  }

  const candidates = options.candidates ?? desktopAppCandidates(env, platform);
  for (const root of candidates) {
    for (const appDir of [path.join(root, 'resources', 'app'), root]) {
      const bin = path.join(appDir, RUNTIME_RELATIVE);
      tried.push(bin);
      if (isFile(bin)) return { bin, source: 'desktop', tried };
    }
  }

  return { bin: null, source: 'none', tried };
}

/**
 * Version of the installed Desktop package, read from its manifest.
 *
 * @param {string} appDir DSH app directory.
 * @returns {string | null} Version string, or null when unreadable.
 */
export function installedVersion(appDir) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * Human-readable message for a failed runtime lookup.
 *
 * @param {string[]} tried Paths that were probed.
 * @returns {string} Multi-line hint naming the fix.
 */
export function runtimeHint(tried) {
  const sample = tried.slice(0, 3).map((entry) => `  ${entry}`).join('\n');
  return [
    'DSH Desktop was not found. Install it, or set DSH_CLI_RUNTIME_BIN to its',
    `"resources\\app\\${RUNTIME_RELATIVE}" path.`,
    sample === '' ? '' : `Probed:\n${sample}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Whether a path is a directory (used by the installers, not the runtime).
 *
 * @param {string} target Candidate path.
 * @returns {boolean} True when it exists and is a directory.
 */
export function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * List immediate subdirectory names, sorted.
 *
 * @param {string} dir Directory to read.
 * @returns {string[]} Names, or an empty list when unreadable.
 */
export function subdirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}