/**
 * Searchable, favouritable model picker.
 *
 * ## Why a picker instead of more `/model` typing
 *
 * `/model` with a typed id is unusable with 400 models across 8 providers: the
 * user has to remember `provider/model` exactly. A picker turns that into
 * "type a few letters, arrow, Enter", and a favourite list makes the handful of
 * routes someone actually uses reachable without searching at all.
 *
 * ## Favourites
 *
 * One small JSON file under `~/.dsh-cli/`. Reading a corrupt or missing file
 * degrades to "no favourites" — a preference file must never break the UI.
 *
 * @module src/ui/model-picker
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { displayWidth, truncateToWidth } from './text.js';

/** Rows the list shows before scrolling. */
export const MODEL_PICKER_ROWS = 12;

/**
 * Favourites file path.
 *
 * @param {Record<string, string | undefined>} [env] Environment.
 * @returns {string} Absolute path.
 */
export function favouritesPath(env = process.env) {
  const home = env.DSH_CLI_HOME !== undefined && env.DSH_CLI_HOME !== ''
    ? env.DSH_CLI_HOME
    : path.join(os.homedir(), '.dsh-cli');
  return path.join(home, 'favourites.json');
}

/**
 * Load favourite model ids.
 *
 * @param {string} [file] Path override (tests).
 * @returns {Set<string>} Favourite ids.
 */
export function loadFavourites(file = favouritesPath()) {
  if (!existsSync(file)) return new Set();
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const list = data?.models;
    return new Set(Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * Save favourite model ids.
 *
 * @param {Set<string>} ids Ids to store.
 * @param {string} [file] Path override (tests).
 * @returns {void}
 */
export function saveFavourites(ids, file = favouritesPath()) {
  let data = {};
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8')) ?? {};
  } catch {
    data = {};
  }
  data.models = [...ids];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * Model list with search, favourites and a moving cursor.
 *
 * Rows are `{ id, provider, model }`, where `id` is the `provider/model` string
 * the driver accepts. Favourites sort first and stay visible while searching,
 * so a starred route is always one Enter away.
 */
export class ModelPicker {
  /**
   * @param {string[]} routes `provider/model` strings.
   * @param {{ file?: string, current?: string }} [options] Options.
   */
  constructor(routes, options = {}) {
    this.file = options.file;
    this.current = options.current ?? '';
    this.all = (Array.isArray(routes) ? routes : [])
      .filter((route) => {
        if (typeof route !== 'string') return false;
        const slash = route.indexOf('/');
        // A route needs a non-empty provider AND a non-empty model: `7api/` and
        // `/broken` are both unselectable, so they never reach the list.
        return slash > 0 && slash < route.length - 1;
      })
      .map((route) => {
        const slash = route.indexOf('/');
        return {
          id: route,
          provider: route.slice(0, slash),
          model: route.slice(slash + 1),
        };
      });
    this.favourites = loadFavourites(this.file ?? favouritesPath());
    this.query = '';
    this.index = 0;
  }

  /**
   * Rows after filtering, favourites first.
   *
   * @returns {{ id: string, provider: string, model: string }[]} Visible rows.
   */
  get rows() {
    const needle = this.query.trim().toLowerCase();
    const matched = needle === ''
      ? this.all
      : this.all.filter(
          (row) =>
            row.id.toLowerCase().includes(needle) ||
            row.provider.toLowerCase().includes(needle),
        );
    const favourite = matched.filter((row) => this.favourites.has(row.id));
    const rest = matched.filter((row) => !this.favourites.has(row.id));
    return [...favourite, ...rest];
  }

  /** Highlighted row, or null. */
  get selected() {
    return this.rows[this.index] ?? null;
  }

  /**
   * Move the cursor without wrapping past the ends.
   *
   * @param {number} delta Rows to move.
   * @returns {void}
   */
  move(delta) {
    const count = this.rows.length;
    if (count === 0) {
      this.index = 0;
      return;
    }
    this.index = Math.min(count - 1, Math.max(0, this.index + delta));
  }

  /**
   * Narrow the list further.
   *
   * @param {string} text Characters to append.
   * @returns {void}
   */
  type(text) {
    this.query += text;
    this.index = 0;
  }

  /** Drop the last search character. */
  backspace() {
    if (this.query === '') return;
    this.query = this.query.slice(0, -1);
    this.index = 0;
  }

  /**
   * Star or unstar the highlighted row and persist it.
   *
   * @returns {boolean} New favourite state.
   */
  toggleFavourite() {
    const row = this.selected;
    if (row === null) return false;
    const next = !this.favourites.has(row.id);
    if (next) this.favourites.add(row.id);
    else this.favourites.delete(row.id);
    try {
      saveFavourites(this.favourites, this.file ?? favouritesPath());
    } catch {
      /* a read-only home must not break the picker */
    }
    return next;
  }
}

/**
 * Render the picker.
 *
 * @param {ModelPicker} picker Picker to draw.
 * @param {object} [options] Options.
 * @param {number} [options.width] Columns.
 * @param {number} [options.height] Rows.
 * @param {{ style: Record<string, (text: string) => string> }} [options.theme] Theme.
 * @returns {string[]} Screen rows.
 */
export function renderModelPicker(picker, { width = 80, height = MODEL_PICKER_ROWS, theme } = {}) {
  const { style } = theme ?? { style: { muted: (t) => t, selected: (t) => t } };
  const rows = picker.rows;
  const heading = picker.query === ''
    ? 'models  type to filter · Enter select · Tab favourite · Esc cancel'
    : `models  filter: ${picker.query}`;
  const lines = [style.muted(truncateToWidth(heading, width))];

  if (rows.length === 0) {
    lines.push(style.muted('  no model matches that filter'));
    return lines;
  }

  const visible = Math.max(1, Math.min(height, rows.length));
  const start = Math.max(0, Math.min(picker.index - Math.floor(visible / 2), rows.length - visible));
  const starWidth = 2;
  const providerWidth = Math.max(8, Math.min(22, Math.floor(width * 0.25)));
  const modelWidth = Math.max(10, width - providerWidth - starWidth - 6);

  for (let offset = 0; offset < visible; offset += 1) {
    const row = rows[start + offset];
    if (row === undefined) break;
    const starred = picker.favourites.has(row.id);
    const active = row.id === picker.current;
    const star = starred ? '*' : ' ';
    const provider = truncateToWidth(row.provider, providerWidth).padEnd(providerWidth);
    const model = truncateToWidth(row.model, modelWidth).padEnd(modelWidth);
    const mark = active ? ' (current)' : '';
    const text = `${star} ${provider} ${model}${mark}`;
    lines.push(start + offset === picker.index ? style.selected(text) : `  ${text}`);
  }

  const above = start;
  const below = rows.length - (start + visible);
  if (above > 0 || below > 0) {
    const parts = [];
    if (above > 0) parts.push(`${above} above`);
    if (below > 0) parts.push(`${below} below`);
    lines.push(style.muted(`  ${parts.join(' · ')}`));
  }
  return lines;
}

/**
 * Compact project dashboard: totals plus the current route.
 *
 * Deliberately a few lines of text rather than a chart: the numbers that change
 * a decision are the token total, the context window still free, and the cost.
 *
 * @param {object} totals Usage totals.
 * @param {object} [options] Options.
 * @param {number} [options.width] Columns.
 * @param {string} [options.provider] Active provider.
 * @param {string} [options.model] Active model.
 * @param {number} [options.contextWindow] Model context window in tokens.
 * @param {number} [options.sessions] Session count for this project.
 * @param {number} [options.cost] Cost in USD.
 * @param {boolean} [options.priced] Whether the cost is known.
 * @param {{ style: Record<string, (text: string) => string> }} [options.theme] Theme.
 * @returns {string[]} Rows.
 */
export function renderDashboard(totals, options = {}) {
  const { style } = options.theme ?? { style: { muted: (t) => t } };
  const width = options.width ?? 80;
  const used = Number(totals?.totalTokens ?? totals?.inputTokens ?? 0) || 0;
  const window = Number(options.contextWindow ?? 0) || 0;
  const percent = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : null;
  const barWidth = Math.max(6, Math.min(24, Math.floor(width * 0.3)));
  const filled = percent === null ? 0 : Math.round((percent / 100) * barWidth);
  const bar = `${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}`;

  // The cost and its priced flag live on the usage totals; an explicit option
  // wins so a caller can override for a hypothetical route.
  const costValue = options.cost ?? totals?.costUsd;
  const priced = options.priced ?? totals?.priced;
  const cost = priced === false || costValue === undefined || costValue === null
    ? 'unpriced'
    : `$${Number(costValue).toFixed(4)}`;  const route = `${options.provider ?? '?'}/${options.model ?? '?'}`;
  const context = percent === null
    ? `${used.toLocaleString()} tokens`
    : `${used.toLocaleString()} / ${window.toLocaleString()} (${percent}%)`;

  return [
    style.muted(`project  ${options.cwd ?? ''}`),
    `  route    ${route}`,
    `  tokens   ${context}`,
    `  context  [${bar}] ${percent === null ? 'window unknown' : `${100 - percent}% free`}`,
    `  cost     ${cost}${options.sessions === undefined ? '' : `   sessions ${options.sessions}`}`,
  ];
}

/**
 * Drives whichever picker the app currently has open.
 *
 * ## Why this is a class and not app methods
 *
 * `App` was already over 900 lines, and model picking, session picking and the
 * dashboard are one cohesive concern: a list under the prompt with search,
 * favourites and a cursor. Keeping the keyboard contract here means `App` only
 * forwards keys and asks for rows to paint, instead of owning three more
 * branches in its key handler.
 */
export class PickerHost {
  /**
   * @param {object} options Options.
   * @param {() => string[]} options.listModels Full model catalogue.
   * @param {() => string} [options.currentModel] `provider/model` of the route.
   * @param {(id: string) => void} [options.onModel] Called with a chosen route.
   * @param {() => { id: string, label: string, detail?: string, active?: boolean }[]} [options.listSessions] Session rows.
   * @param {(id: string) => void} [options.onSession] Called with a chosen session id.
   * @param {string} [options.favouritesFile] Favourites path override (tests).
   */
  constructor(options) {
    this.listModels = options.listModels;
    this.currentModel = options.currentModel;
    this.onModel = options.onModel;
    this.listSessions = options.listSessions;
    this.onSession = options.onSession;
    this.favouritesFile = options.favouritesFile;
    /** Called with the palette choice, `{ kind, value }`. */
    this.onPalette = options.onPalette;
    /** @type {ModelPicker | null} */
    this.model = null;
    /** @type {ListPicker | null} */
    this.session = null;
    /** @type {ListPicker | null} */
    this.palette = null;
  }

  /** Whether any picker is open. */
  get open() {
    return this.model !== null || this.session !== null || this.palette !== null;
  }

  /**
   * Open the everything-picker: commands, models and sessions in one list.
   *
   * @param {{ id: string, label: string, detail?: string }[]} rows Entries whose ids start `cmd:`, `model:` or `session:`.
   * @returns {void}
   */
  openPalette(rows) {
    this.palette = new ListPicker({ kind: 'palette', rows });
    this.model = null;
    this.session = null;
  }

  /**
   * Act on the palette's highlighted row, dispatching on its id prefix.
   *
   * @returns {{ kind: string, value: string } | null} What was chosen.
   */
  acceptPalette() {
    const row = this.palette?.current ?? null;
    this.palette = null;
    if (row === null) return null;
    // ids are `kind:value`, so the first segment is the kind and the rest is
    // the value (a model id or session id may itself contain no colon, but a
    // provider quirk could, so the remainder is rejoined).
    const [kind, ...rest] = row.id.split(':');
    return { kind, value: rest.join(':') };
  }

  /** Whether the model picker specifically is open. */
  get modelOpen() {
    return this.model !== null;
  }

  /** Close everything. */
  close() {
    this.model = null;
    this.session = null;
    this.palette = null;
  }

  /** Open the model picker on the full catalogue. */
  openModel() {
    let routes = [];
    try {
      routes = this.listModels?.() ?? [];
    } catch {
      routes = [];
    }
    this.model = new ModelPicker(routes, {
      file: this.favouritesFile,
      current: this.currentModel?.() ?? '',
    });
    this.session = null;
  }

  /** Open the session picker. */
  openSession() {
    let rows = [];
    try {
      rows = this.listSessions?.() ?? [];
    } catch {
      rows = [];
    }
    this.session = new ListPicker({ kind: 'sessions', rows, file: this.favouritesFile });
    this.model = null;
  }

  /**
   * Handle one key.
   *
   * @param {string} key Key name.
   * @param {string} [payload] Text payload.
   * @param {string} [enterKey] The keymap's Enter name.
   * @param {string} [tabKey] The keymap's Tab name.
   * @param {string} [backspaceKey] The keymap's Backspace name.
   * @param {string} [escapeKey] The keymap's Escape name.
   * @param {string} [ctrlCKey] The keymap's Ctrl+C name.
   * @param {string} [textKey] The keymap's text name.
   * @returns {boolean} True when a picker consumed the key.
   */
  handleKey(key, payload, enterKey, tabKey, backspaceKey, escapeKey, ctrlCKey, textKey) {
    if (this.palette !== null) {
      if (key === 'up') { this.palette.move(-1); return true; }
      if (key === 'down') { this.palette.move(1); return true; }
      if (key === enterKey) {
        // Read the choice, then act on the next tick. Acting inline re-entered
        // the palette's own key handler through the command it dispatched, and
        // that cycle never returned.
        const choice = this.acceptPalette();
        setImmediate(() => this.onPalette?.(choice));
        return true;
      }
      if (key === backspaceKey) { this.palette.searchBackspace(); return true; }
      if (key === escapeKey || key === ctrlCKey) { this.close(); return true; }
      if (key === textKey) { this.palette.search(payload ?? ''); return true; }
      return false;
    }
    if (this.model !== null) {
      if (key === 'up') { this.model.move(-1); return true; }
      if (key === 'down') { this.model.move(1); return true; }
      if (key === enterKey) {
        const row = this.model.selected;
        this.close();
        if (row !== null) this.onModel?.(row.id);
        return true;
      }
      if (key === tabKey) { this.model.toggleFavourite(); return true; }
      if (key === backspaceKey) { this.model.backspace(); return true; }
      if (key === escapeKey || key === ctrlCKey) { this.close(); return true; }
      if (key === textKey) { this.model.type(payload ?? ''); return true; }
      return false;
    }
    if (this.session !== null) {
      if (key === 'up') { this.session.move(-1); return true; }
      if (key === 'down') { this.session.move(1); return true; }
      if (key === enterKey) {
        const row = this.session.current;
        this.close();
        if (row !== null) this.onSession?.(row.id);
        return true;
      }
      if (key === tabKey) { this.session.toggleFavourite(); return true; }
      if (key === backspaceKey) { this.session.searchBackspace(); return true; }
      if (key === escapeKey || key === ctrlCKey) { this.close(); return true; }
      if (key === textKey) { this.session.search(payload ?? ''); return true; }
      return false;
    }
    return false;
  }

  /**
   * Rows to paint under the prompt.
   *
   * @param {object} options Options.
   * @param {number} options.width Columns.
   * @param {any} options.theme Theme.
   * @returns {string[]} Screen rows.
   */
  rows({ width, theme }) {
    if (this.model !== null) return renderModelPicker(this.model, { width, theme });
    if (this.session !== null) return renderPicker(this.session, { width, theme });
    return [];
  }
}

/**
 * Filterable, favouritable list of anything with an id and a label.
 *
 * Sessions and projects share it so search and favourites behave identically
 * everywhere instead of being reimplemented per list.
 */
export class ListPicker {
  /**
   * @param {object} options Options.
   * @param {string} options.kind Favourites bucket.
   * @param {{ id: string, label: string, detail?: string, active?: boolean }[]} options.rows Rows.
   * @param {string} [options.file] Favourites path override.
   */
  constructor({ kind, rows, file }) {
    this.kind = kind;
    this.file = file;
    this.all = Array.isArray(rows) ? rows : [];
    this.query = '';
    this.index = 0;
    this.favourites = loadFavouritesFor(kind, file ?? favouritesPath());
  }

  /** Rows after filtering, favourites first. */
  get rows() {
    const needle = this.query.trim().toLowerCase();
    const matched = needle === ''
      ? this.all
      : this.all.filter(
          (row) =>
            row.label.toLowerCase().includes(needle) ||
            String(row.detail ?? '').toLowerCase().includes(needle),
        );
    return [
      ...matched.filter((row) => this.favourites.has(row.id)),
      ...matched.filter((row) => !this.favourites.has(row.id)),
    ];
  }

  /** Highlighted row, or null. */
  get current() {
    return this.rows[this.index] ?? null;
  }

  /**
   * Move the cursor within the list.
   *
   * @param {number} delta Rows to move.
   * @returns {void}
   */
  move(delta) {
    const count = this.rows.length;
    if (count === 0) { this.index = 0; return; }
    this.index = Math.min(count - 1, Math.max(0, this.index + delta));
  }

  /**
   * Append to the search filter.
   *
   * @param {string} text Characters.
   * @returns {void}
   */
  search(text) {
    this.query += text;
    this.index = 0;
  }

  /** Drop the last search character. */
  searchBackspace() {
    if (this.query === '') return;
    this.query = this.query.slice(0, -1);
    this.index = 0;
  }

  /**
   * Star or unstar the highlighted row.
   *
   * @returns {boolean} New state.
   */
  toggleFavourite() {
    const row = this.current;
    if (row === null) return false;
    const next = !this.favourites.has(row.id);
    if (next) this.favourites.add(row.id);
    else this.favourites.delete(row.id);
    try {
      saveFavouritesFor(this.kind, this.favourites, this.file ?? favouritesPath());
    } catch {
      /* read-only home must not break the picker */
    }
    return next;
  }
}

/**
 * Read favourites for an arbitrary bucket.
 *
 * @param {string} kind Bucket name.
 * @param {string} file Path.
 * @returns {Set<string>} Ids.
 */
function loadFavouritesFor(kind, file) {
  if (!existsSync(file)) return new Set();
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const list = data?.[kind];
    return new Set(Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * Persist favourites for an arbitrary bucket.
 *
 * @param {string} kind Bucket name.
 * @param {Set<string>} ids Ids.
 * @param {string} file Path.
 * @returns {void}
 */
function saveFavouritesFor(kind, ids, file) {
  let data = {};
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8')) ?? {};
  } catch {
    data = {};
  }
  data[kind] = [...ids];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * Render a generic list picker.
 *
 * @param {ListPicker} picker Picker.
 * @param {object} [options] Options.
 * @param {number} [options.width] Columns.
 * @param {number} [options.height] Rows.
 * @param {any} [options.theme] Theme.
 * @returns {string[]} Rows.
 */
export function renderPicker(picker, { width = 80, height = MODEL_PICKER_ROWS, theme } = {}) {
  const { style } = theme ?? { style: { muted: (t) => t, selected: (t) => t } };
  const rows = picker.rows;
  // The heading names what the list holds: the palette mixes commands, models
  // and sessions, so calling it "sessions" would misdescribe it.
  const title = picker.kind === 'palette' ? 'commands · models · sessions' : 'sessions';
  const action = picker.kind === 'palette' ? 'Enter run' : 'Enter resume';
  const heading = picker.query === ''
    ? `${title}  type to filter · ${action} · Tab favourite · Esc cancel`
    : `${title}  filter: ${picker.query}`;
  const lines = [style.muted(truncateToWidth(heading, width))];

  if (rows.length === 0) {
    lines.push(style.muted('  no matches'));
    return lines;
  }

  const visible = Math.max(1, Math.min(height, rows.length));
  const start = Math.max(0, Math.min(picker.index - Math.floor(visible / 2), rows.length - visible));
  const labelWidth = Math.max(10, Math.min(36, Math.floor(width * 0.35)));

  for (let offset = 0; offset < visible; offset += 1) {
    const row = rows[start + offset];
    if (row === undefined) break;
    const star = picker.favourites.has(row.id) ? '*' : ' ';
    const mark = row.active === true ? '>' : ' ';
    const label = truncateToWidth(row.label, labelWidth).padEnd(labelWidth);
    const detailWidth = Math.max(0, width - labelWidth - 6);
    const detail = row.detail === undefined ? '' : truncateToWidth(row.detail, detailWidth);
    // Two leading spaces keep unselected rows aligned with the selected one,
    // whose prefix is the star and active marks.
    const text = `  ${star}${mark} ${label} ${detail}`;
    lines.push(start + offset === picker.index ? style.selected(text) : text);
  }

  const above = start;
  const below = rows.length - (start + visible);
  if (above > 0 || below > 0) {
    const parts = [];
    if (above > 0) parts.push(`${above} above`);
    if (below > 0) parts.push(`${below} below`);
    lines.push(style.muted(`  ${parts.join(' · ')}`));
  }
  return lines;
}
