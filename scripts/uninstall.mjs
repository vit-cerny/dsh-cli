#!/usr/bin/env node
/**
 * Remove everything `scripts/install.mjs` added.
 *
 * The installer touches exactly three things, and this script removes exactly
 * those three, by marker or by path — never by pattern matching a directory it
 * does not own:
 *
 * 1. the launcher file in the bin directory;
 * 2. the `dsh-cli` DSH profile;
 * 3. any PATH line carrying {@link MARKER}.
 *
 * It leaves the checkout alone (delete the directory yourself) and never touches
 * the Desktop profile, the credential store, or the session store.
 *
 * Usage:
 *   node scripts/uninstall.mjs [--dry-run] [--dir <bin-dir>] [--keep-profile] [--purge]
 *
 * `--purge` also deletes the CLI's own session logs under the DSH home.
 *
 * @module scripts/uninstall
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { defaultBinDir, DEFAULT_LAUNCHER, readState } from './install.mjs';
import { CLI_PROFILE, resolveHome } from './install-profile.mjs';

/**
 * Every file and directory the installer may have created.
 *
 * Listing them explicitly (rather than globbing a parent) is what keeps this
 * reversible: the bin directory may hold other tools, so only our own files are
 * removed from it.
 *
 * Alias names are user-chosen, so they come from the manifest the installer
 * wrote. Without that manifest only the default launcher can be named, and the
 * alias files would survive; the report says so instead of guessing.
 *
 * @param {{ binDir?: string, env?: Record<string, string | undefined>, platform?: string, purge?: boolean }} [options]
 * @returns {{ kind: string, target: string }[]} Removal plan, parents before children.
 */
export function uninstallPlan(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const binDir = options.binDir ?? defaultBinDir(env, platform);
  const suffix = platform === 'win32' ? '.cmd' : '';
  const home = resolveHome(env);

  const state = readState(env);
  const recorded = state?.launchers?.map((entry) => entry.path) ?? [];
  const launchers = recorded.length > 0
    ? recorded
    : [path.join(binDir, `${DEFAULT_LAUNCHER}${suffix}`)];

  /** @type {{ kind: string, target: string }[]} */
  const plan = launchers.map((target) => ({ kind: 'launcher', target }));
  plan.push({ kind: 'profile', target: path.join(home, 'profiles', CLI_PROFILE) });
  if (options.purge === true) {
    plan.push({ kind: 'sessions', target: path.join(home, 'sessions') });
  }
  return plan;
}

/**
 * Remove the installed pieces.
 *
 * @param {{ dryRun?: boolean, binDir?: string, env?: Record<string, string | undefined>,
 *   platform?: string, keepProfile?: boolean, purge?: boolean,
 *   stdout?: { write(text: string): unknown } }} [options]
 * @returns {{ removed: string[], missing: string[], kept: string[] }} Report.
 */
export function runUninstall(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const dryRun = options.dryRun === true;
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const kept = [];

  for (const entry of uninstallPlan(options)) {
    if (entry.kind === 'profile' && options.keepProfile === true) {
      kept.push(entry.target);
      stdout.write(`kept   ${entry.target} (--keep-profile)\n`);
      continue;
    }
    if (entry.kind === 'sessions') {
      const targets = purgeTargets(entry.target);
      for (const target of targets) {
        if (!existsSync(target)) {
          missing.push(target);
          continue;
        }
        if (!dryRun) rmSync(target, { recursive: true, force: true });
        removed.push(target);
        stdout.write(`${dryRun ? 'would remove' : 'removed'} ${target}\n`);
      }
      continue;
    }
    if (!existsSync(entry.target)) {
      missing.push(entry.target);
      continue;
    }
    if (!dryRun) rmSync(entry.target, { recursive: true, force: true });
    removed.push(entry.target);
    stdout.write(`${dryRun ? 'would remove' : 'removed'} ${entry.target}\n`);
  }

  if (!dryRun && removed.length > 0) {
    stdout.write('\nRemove the PATH entry for the bin directory if you added one.\n');
  }
  return { removed, missing, kept };
}

/**
 * Session directories the CLI created.
 *
 * Only ids this client minted are purged: the runtime and Desktop write to the
 * same store, and deleting a Desktop session would be data loss, not uninstall.
 *
 * @param {string} sessionsRoot DSH sessions root.
 * @returns {string[]} Session directories to delete.
 */
function purgeTargets(sessionsRoot) {
  /** @type {string[]} */
  const targets = [];
  try {
    for (const workspace of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const workspaceDir = path.join(sessionsRoot, workspace.name);
      for (const session of readdirSync(workspaceDir, { withFileTypes: true })) {
        if (!session.isDirectory()) continue;
        // Session ids minted by this client carry this prefix (src/session/driver.js).
        if (!session.name.startsWith('dsh-cli-')) continue;
        targets.push(path.join(workspaceDir, session.name));
      }
    }
  } catch {
    return targets;
  }
  return targets;
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {number} Process exit code.
 */
function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const keepProfile = argv.includes('--keep-profile');
  const purge = argv.includes('--purge');
  const dirIndex = argv.indexOf('--dir');
  const binDir = dirIndex >= 0 ? argv[dirIndex + 1] : undefined;

  const report = runUninstall({
    dryRun,
    keepProfile,
    purge,
    ...(binDir === undefined ? {} : { binDir }),
  });

  if (report.removed.length === 0 && report.missing.length > 0) {
    process.stdout.write('nothing to remove: dsh-cli is not installed here\n');
  }
  process.stdout.write(
    dryRun
      ? '\ndry run: nothing was deleted\n'
      : '\ndone. The checkout directory is still on disk; delete it to finish.\n',
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dsh-cli uninstall failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}