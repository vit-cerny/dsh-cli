/**
 * `dsh-cli plugins` — what Desktop has installed versus what the CLI mounts.
 *
 * The runtime assembles a session from a patch stack, so "installed" is not one
 * file: `profiles/<profile>/cordis.patch.yml`, then the shared
 * `$DSH_HOME/cordis.patch.yml`, which every profile applies last and which
 * therefore outranks the profile's own rows.
 *
 * A row from that shared home layer is mounted by both profiles, so a
 * comparison that forgets it reports shared capabilities as missing from the
 * CLI. Keep the home rows in the lists passed to {@link diffPlugins}.
 *
 * Nothing here opens the credential store or writes the Desktop profile: a
 * copied row carries credential *reference* names (`apiKeyEnv`), and the only
 * file ever written is the `dsh-cli` profile patch.
 *
 * @module src/cli/plugins
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { CLI_PROFILE, COPIED_ROWS, splitPatchRows } from '../../scripts/install-profile.mjs';

/**
 * @typedef {object} PluginRow
 * @property {string} id Loader id the patch entry targets.
 * @property {string} name Package or plugin name; the id when the row only overrides config.
 * @property {boolean} enabled False when the row carries `disabled: true`.
 * @property {'desktop' | 'dsh-cli' | 'home'} source Patch layer the row came from.
 * @property {boolean} bundled True for `@deepseek-ai/` rows shipped with the runtime.
 */

/**
 * @typedef {object} SyncResult
 * @property {string} target `dsh-cli` patch that was, or would be, appended to.
 * @property {{ missing: PluginRow[], extra: PluginRow[], disabled: PluginRow[] }} diff
 *   Profile comparison the sync was derived from.
 * @property {string[]} copied Ids appended, or that a dry run would append.
 * @property {{ id: string, reason: string }[]} skipped Missing rows deliberately left alone.
 * @property {boolean} written False on a dry run, and on an already-synced profile.
 */

const DESKTOP_PROFILE = 'desktop';

/** Patch layers a row can come from; the home layer applies to both profiles. */
const LAYERS = Object.freeze([
  { source: 'desktop', profile: DESKTOP_PROFILE },
  { source: 'dsh-cli', profile: CLI_PROFILE },
  { source: 'home', profile: null },
]);

/** Row-level keys sit at indent 0 or 2; deeper keys belong to `config:`. */
const ROW_KEY = /^(?:- | {2})(name|disabled)\s*:\s*(.+?)\s*$/;
const TRUTHY = /^(true|yes|on|1)$/i;

/**
 * Read one patch, tolerating absence.
 *
 * @param {string} file Absolute path.
 * @returns {string} Contents, or `''`.
 */
function readIfPresent(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Strip one layer of matching quotes from a patch scalar.
 *
 * @param {string} value Raw scalar.
 * @returns {string} Unquoted value.
 */
function unquote(value) {
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted === null ? value : quoted[2];
}

/**
 * Read the row-level facts the inventory reports.
 *
 * @param {{ id: string, lines: string[] }} row Split patch row.
 * @returns {{ id: string, name: string, enabled: boolean, bundled: boolean }} Row facts.
 */
function parseRow(row) {
  let name = '';
  let enabled = true;
  for (const line of row.lines) {
    const keyed = ROW_KEY.exec(line);
    if (keyed === null) continue;
    if (keyed[1] === 'name') name = unquote(keyed[2]);
    else enabled = !TRUTHY.test(unquote(keyed[2]));
  }
  const displayName = name === '' ? row.id : name;
  return {
    id: row.id,
    name: displayName,
    enabled,
    bundled: displayName.startsWith('@deepseek-ai/'),
  };
}

/**
 * Parse one layer into rows, letting a later duplicate of an id win.
 *
 * @param {string} file Patch path.
 * @param {'desktop' | 'dsh-cli' | 'home'} source Layer label.
 * @returns {PluginRow[]} Rows in file order.
 */
function rowsForLayer(file, source) {
  /** @type {Map<string, PluginRow>} */
  const byId = new Map();
  for (const row of splitPatchRows(readIfPresent(file))) {
    if (row.id === '') continue;
    byId.set(row.id, { ...parseRow(row), source });
  }
  return [...byId.values()];
}

/**
 * Fold a list of rows to one effective row per id, later rows winning.
 *
 * @param {PluginRow[]} rows Rows in layer order.
 * @returns {Map<string, PluginRow>} Effective rows keyed by id.
 */
function effectiveRows(rows) {
  /** @type {Map<string, PluginRow>} */
  const byId = new Map();
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

/**
 * Read every plugin row the runtime can see, from each patch layer.
 *
 * Rows keep their layer as `source` and are returned once per layer: "Desktop
 * has it" and "the CLI mounts it" are the two facts the command compares, so
 * collapsing them would erase the answer. Within one layer a repeated id keeps
 * its last definition, which is how the loader applies the patch.
 *
 * @param {string} dshHome DSH home directory.
 * @returns {PluginRow[]} Rows in layer order: desktop, dsh-cli, home.
 */
export function readInstalledPlugins(dshHome) {
  /** @type {PluginRow[]} */
  const rows = [];
  for (const layer of LAYERS) {
    const file =
      layer.profile === null
        ? path.join(dshHome, 'cordis.patch.yml')
        : path.join(dshHome, 'profiles', layer.profile, 'cordis.patch.yml');
    rows.push(...rowsForLayer(file, layer.source));
  }
  return rows;
}

/**
 * Enabled loader ids for one profile, after the shared home layer is applied.
 *
 * @param {string} dshHome DSH home directory.
 * @param {string} profile Profile name (`desktop`, `dsh-cli`, or any other).
 * @returns {Set<string>} Ids the profile will mount.
 */
export function readPluginProfileRows(dshHome, profile) {
  /** @type {Map<string, boolean>} */
  const enabledById = new Map();
  for (const file of [
    path.join(dshHome, 'profiles', profile, 'cordis.patch.yml'),
    path.join(dshHome, 'cordis.patch.yml'),
  ]) {
    for (const row of splitPatchRows(readIfPresent(file))) {
      if (row.id === '') continue;
      enabledById.set(row.id, parseRow(row).enabled);
    }
  }
  return new Set(
    [...enabledById].filter(([, enabled]) => enabled).map(([id]) => id),
  );
}

/**
 * Compare the two profiles by loader id.
 *
 * `missing` is what Desktop mounts and the CLI profile has no enabled row for;
 * `extra` is a CLI row Desktop does not have; `disabled` is a CLI row that is
 * switched off. A row from the shared home layer counts for both profiles, so a
 * home row is never reported missing or extra even when only one list holds it.
 *
 * @param {PluginRow[]} desktopRows Rows the Desktop profile mounts.
 * @param {PluginRow[]} cliRows Rows the dsh-cli profile mounts.
 * @returns {{ missing: PluginRow[], extra: PluginRow[], disabled: PluginRow[] }} Diff.
 */
export function diffPlugins(desktopRows, cliRows) {
  /** @type {Set<string>} */
  const shared = new Set();
  for (const row of [...desktopRows, ...cliRows]) {
    if (row.source === 'home') shared.add(row.id);
  }
  const desktop = effectiveRows(desktopRows);
  const cli = effectiveRows(cliRows);

  /** @type {PluginRow[]} */
  const missing = [];
  /** @type {PluginRow[]} */
  const extra = [];
  /** @type {PluginRow[]} */
  const disabled = [];
  for (const [id, row] of desktop) {
    if (!row.enabled || shared.has(id)) continue;
    if (!cli.has(id)) missing.push(row);
  }
  for (const [id, row] of cli) {
    if (!row.enabled) disabled.push(row);
    else if (!desktop.has(id) && !shared.has(id)) extra.push(row);
  }
  return { missing, extra, disabled };
}

/**
 * Render plugins as plain aligned text, one row per plugin.
 *
 * The status comes from the diff, so a row Desktop has and the CLI lacks reads
 * `missing` while a row both mount reads `synced`. `(bundled)` marks rows shipped
 * with the runtime, which cannot be uninstalled.
 *
 * @param {PluginRow[]} rows Rows from `readInstalledPlugins`; later layers win.
 * @param {{ missing?: PluginRow[], extra?: PluginRow[], disabled?: PluginRow[] }} [diff]
 *   Diff from {@link diffPlugins}; without it the status is read from `enabled`.
 * @returns {string[]} Header plus one aligned line per plugin, no trailing newline.
 */
export function formatPluginTable(rows, diff = {}) {
  const { missing = [], extra = [], disabled = [] } = diff;
  /** @type {Map<string, string>} */
  const statusById = new Map();
  for (const row of missing) statusById.set(row.id, 'missing');
  for (const row of extra) statusById.set(row.id, 'extra');
  for (const row of disabled) statusById.set(row.id, 'disabled');

  const entries = [...effectiveRows(rows).values()]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((row) => ({
      status: statusById.get(row.id) ?? (row.enabled ? 'synced' : 'disabled'),
      id: row.id,
      name: row.bundled ? `${row.name} (bundled)` : row.name,
      source: row.source,
    }));

  /** @type {{ status: number, id: number, name: number }} */
  const widths = { status: 'status'.length, id: 'id'.length, name: 'name'.length };
  for (const entry of entries) {
    widths.status = Math.max(widths.status, entry.status.length);
    widths.id = Math.max(widths.id, entry.id.length);
    widths.name = Math.max(widths.name, entry.name.length);
  }

  const render = (entry) =>
    `${entry.status.padEnd(widths.status)}  ${entry.id.padEnd(widths.id)}  ${entry.name.padEnd(widths.name)}  ${entry.source}`;
  return [
    render({ status: 'status', id: 'id', name: 'name', source: 'source' }).trimEnd(),
    ...entries.map((entry) => render(entry).trimEnd()),
  ];
}

/**
 * Append missing capability rows to the `dsh-cli` profile patch.
 *
 * A dry run is the default; `apply: true` is required to write. Only rows
 * `scripts/install-profile.mjs` already copies are eligible, so an Electron or
 * UI row can never land in a terminal profile. The desktop patch is never
 * written, and an already-synced profile is left untouched, which makes a second
 * run a no-op.
 *
 * @param {string} dshHome DSH home directory.
 * @param {{ apply?: boolean }} [options] Set `apply` to write instead of report.
 * @returns {SyncResult} What was, or would be, copied, plus the profile diff.
 */
export function syncPlugins(dshHome, { apply = false } = {}) {
  const rows = readInstalledPlugins(dshHome);
  const shared = rows.filter((row) => row.source === 'home');
  const diff = diffPlugins(
    [...rows.filter((row) => row.source === 'desktop'), ...shared],
    [...rows.filter((row) => row.source === 'dsh-cli'), ...shared],
  );

  const copyable = new Set(COPIED_ROWS);
  const wanted = diff.missing.filter((row) => copyable.has(row.id));
  const skipped = diff.missing
    .filter((row) => !copyable.has(row.id))
    .map((row) => ({ id: row.id, reason: 'not a row install-profile copies' }));
  const target = path.join(dshHome, 'profiles', CLI_PROFILE, 'cordis.patch.yml');
  /** @type {SyncResult} */
  const result = { target, diff, copied: wanted.map((row) => row.id), skipped, written: false };
  if (apply !== true) return result;

  const desktopPatch = path.join(dshHome, 'profiles', DESKTOP_PROFILE, 'cordis.patch.yml');
  /** @type {Map<string, { id: string, lines: string[] }>} */
  const sourceRows = new Map(
    splitPatchRows(readIfPresent(desktopPatch)).map((row) => [row.id, row]),
  );
  const blocks = wanted.map((row) => sourceRows.get(row.id)).filter((row) => row !== undefined);
  if (blocks.length === 0) return result;

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, appendPatchRows(readIfPresent(target), blocks), 'utf8');
  return { ...result, written: true };
}

/**
 * Print the plugin table, and optionally the sync summary.
 *
 * The table lists every plugin any layer declares, with the layer that last
 * defined it; the status column is what the diff says about the CLI profile.
 *
 * @param {{ dshHome: string, profile?: string }} context Resolved context.
 * @param {{ stdout?: NodeJS.WriteStream, dshHome?: string, json?: boolean, sync?: boolean,
 *   apply?: boolean }} [options] Overrides for tests and the `sync` subcommand.
 * @returns {number} Exit code.
 */
export function runPluginsCommand(context, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const dshHome = options.dshHome ?? context.dshHome;
  const write = (line) => stdout.write(`${line}\n`);

  const rows = readInstalledPlugins(dshHome);
  const shared = rows.filter((row) => row.source === 'home');
  const diff = diffPlugins(
    [...rows.filter((row) => row.source === 'desktop'), ...shared],
    [...rows.filter((row) => row.source === 'dsh-cli'), ...shared],
  );

  if (options.json === true) {
    write(JSON.stringify({ rows, diff }));
    return 0;
  }
  for (const line of formatPluginTable(rows, diff)) write(line);

  if (options.sync !== true) {
    if (diff.missing.length > 0) write('\nrun `dsh-cli plugins sync` to plan copying the missing capability rows');
    return 0;
  }

  const result = syncPlugins(dshHome, { apply: options.apply === true });
  write('');
  if (result.copied.length === 0 && result.skipped.length === 0) {
    write(`the ${CLI_PROFILE} profile already has every row install-profile copies`);
    return 0;
  }
  if (result.skipped.length > 0) {
    write(`not copied (not a capability row): ${result.skipped.map((row) => row.id).join(', ')}`);
  }
  if (result.copied.length === 0) return 0;
  if (result.written) {
    write(`appended to ${result.target}: ${result.copied.join(', ')}`);
  } else {
    write(`dry run: no files written; would append to ${result.target}: ${result.copied.join(', ')}`);
    write('run with --apply to write');
  }
  return 0;
}

/**
 * Append rows to a patch, keeping the block shape `buildProfilePatch` writes.
 *
 * Appending rather than regenerating is what lets a hand-added row in the CLI
 * profile survive a sync.
 *
 * @param {string} text Existing patch contents.
 * @param {{ id: string, lines: string[] }[]} rows Rows to append.
 * @returns {string} Patch text with the rows at the end.
 */
function appendPatchRows(text, rows) {
  /** @type {string[]} */
  const parts = [];
  const existing = String(text).replace(/\s+$/, '');
  if (existing !== '') parts.push(existing);
  for (const row of rows) {
    const body = [...row.lines];
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
    parts.push(`# == ${row.id} (copied from the Desktop profile)\n${body.join('\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}