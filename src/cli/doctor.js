/**
 * `dsh-cli doctor`: one pass that answers "why is this not working".
 *
 * Every check is independent and non-fatal. A failure is reported as a line with
 * the command that fixes it, because the common failures here are all setup
 * problems (no Desktop install, a profile that was never generated, a route the
 * stored key cannot reach), not code defects.
 *
 * The checks read configuration only. Nothing is written, no prompt is sent, and
 * no credential value is ever printed — only whether a reference exists.
 *
 * @module src/cli/doctor
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { resolveRuntimeBin } from './discover.js';
import { diffPlugins, readInstalledPlugins } from './plugins.js';
import { COPIED_ROWS } from '../../scripts/install-profile.mjs';

/**
 * @typedef {object} Check
 * @property {string} name What was checked.
 * @property {'ok' | 'warn' | 'fail'} level Result.
 * @property {string} detail One line, already formatted.
 * @property {string} [fix] The command or edit that resolves it.
 */

/**
 * Run every check.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @param {{ skills?: (home: string) => string[] }} [options] Injection for tests.
 * @returns {Check[]} Results in report order.
 */
export function runChecks(context, options = {}) {
  /** @type {Check[]} */
  const checks = [];

  const runtime = resolveRuntimeBin();
  if (runtime.bin === null) {
    checks.push({
      name: 'runtime',
      level: 'fail',
      detail: 'DSH Desktop runtime not found',
      fix: 'install DSH Desktop, or set DSH_CLI_RUNTIME_BIN',
    });
  } else {
    checks.push({
      name: 'runtime',
      level: 'ok',
      detail: runtime.bin,
    });
  }

  checks.push({
    name: 'profile',
    level: context.profile === 'dsh-cli' ? 'ok' : 'warn',
    detail:
      context.profile === 'dsh-cli'
        ? `${context.profile} (installed)`
        : `${context.profile} (not the generated profile; capability rows may be missing)`,
    fix: context.profile === 'dsh-cli' ? undefined : 'node scripts/install.mjs',
  });

  checks.push({
    name: 'route',
    level: 'ok',
    detail: `${context.provider}/${context.model}`,
  });

  checks.push({
    name: 'working dir',
    level: 'ok',
    detail: context.cwd,
  });

  const plugins = readInstalledPlugins(context.dshHome);
  const shared = plugins.filter((row) => row.source === 'home');
  const diff = diffPlugins(
    [...plugins.filter((row) => row.source === 'desktop'), ...shared],
    [...plugins.filter((row) => row.source === 'dsh-cli'), ...shared],
  );
  // Only capability rows can ever be copied; Electron and UI rows are excluded
  // on purpose, so counting them as missing would warn about a non-problem and
  // train the user to ignore the check.
  const copyable = new Set(COPIED_ROWS);
  const missingCapability = diff.missing.filter((row) => copyable.has(row.id));
  checks.push({
    name: 'plugins',
    level: missingCapability.length === 0 ? 'ok' : 'warn',
    detail:
      missingCapability.length === 0
        ? `${diff.missing.length} desktop-only rows, none of them copyable capability rows`
        : `${missingCapability.length} capability row(s) not in the cli profile`,
    fix: missingCapability.length === 0 ? undefined : 'dsh-cli plugins sync --apply',
  });

  const skills = options.skills ? options.skills(context.dshHome) : listSkills(context.dshHome);
  checks.push({
    name: 'skills',
    level: skills.length > 0 ? 'ok' : 'warn',
    detail: `${skills.length} installed under ${path.join(context.dshHome, 'skills')}`,
    fix: skills.length > 0 ? undefined : 'dsh-cli migrate opencode --apply',
  });

  checks.push({
    name: 'sessions',
    level: 'ok',
    detail: path.join(context.dshHome, 'sessions'),
  });

  return checks;
}

/**
 * Skill directory names under the DSH home.
 *
 * @param {string} dshHome DSH home directory.
 * @returns {string[]} Names, empty when unreadable.
 */
function listSkills(dshHome) {
  try {
    return readdirSync(path.join(dshHome, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Render the report.
 *
 * @param {Check[]} checks Results.
 * @returns {string[]} Lines.
 */
export function formatChecks(checks) {
  const width = checks.reduce((max, check) => Math.max(max, check.name.length), 0);
  const marker = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  /** @type {string[]} */
  const lines = [];
  for (const check of checks) {
    lines.push(`  ${marker[check.level]}  ${check.name.padEnd(width)}  ${check.detail}`);
    if (check.fix !== undefined) lines.push(`        ${' '.repeat(width)}  fix: ${check.fix}`);
  }
  const failed = checks.filter((check) => check.level === 'fail').length;
  const warned = checks.filter((check) => check.level === 'warn').length;
  lines.push('');
  lines.push(
    failed > 0
      ? `${failed} check(s) failed; the CLI will not start a session until they pass`
      : warned > 0
        ? `${warned} warning(s); sessions work but will be missing something`
        : 'all checks passed',
  );
  return lines;
}

/**
 * Run `dsh-cli doctor`.
 *
 * @param {import('./context.js').CliContext} context Resolved context.
 * @param {{ stdout?: NodeJS.WriteStream, checks?: Check[] }} [options]
 * @returns {number} Exit code: 0 when no check failed.
 */
export function runDoctorCommand(context, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const checks = options.checks ?? runChecks(context);
  for (const line of formatChecks(checks)) stdout.write(`${line}\n`);
  return checks.some((check) => check.level === 'fail') ? 1 : 0;
}