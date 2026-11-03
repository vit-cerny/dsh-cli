/**
 * Top toolbar row and the session picker it opens.
 *
 * Both are pure string builders: nothing here writes to a stream or requires a
 * TTY, so the app can repaint the row in place and tests can assert it verbatim.
 *
 * @module src/ui/toolbar
 */

import { shortenPath } from './renderer.js';
import { displayWidth, formatDuration, padToWidth, truncateToWidth } from './text.js';
import { createTheme } from './theme.js';

/** Rows the picker shows before it starts scrolling. */
export const PICKER_ROWS = 10;

/** Segment separator, three columns wide, so width maths stays exact. */
const SEPARATOR = ' · ';

const DEFAULT_WIDTH = 80;

/** Columns the picker reserves for its id and age cells, so titles line up. */
const PICKER_ID_COLUMNS = 10;
const PICKER_AGE_COLUMNS = 6;
const PICKER_FIXED_COLUMNS = 2 + PICKER_ID_COLUMNS + 2 + 2 + PICKER_AGE_COLUMNS;

/** The title keeps at least this much before the cwd column gets the rest. */
const PICKER_TITLE_MIN = 12;

/** Below this the aligned columns cannot hold a usable title, so they collapse. */
const PICKER_COLUMNS_MIN = PICKER_FIXED_COLUMNS + PICKER_TITLE_MIN;

/** A narrower cwd column than this is noise, so it is dropped instead. */
const PICKER_CWD_MIN = 10;

/** A wider cwd column than this steals space the title needs more. */
const PICKER_CWD_MAX = 28;

/** Used when the caller renders without a theme; colour stays off. */
const DEFAULT_THEME = createTheme({ color: false });

/**
 * One row of the picker.
 *
 * @typedef {object} SessionRow
 * @property {string} [id] Session id, shown in the first column.
 * @property {string} [title] Display label.
 * @property {string|number} [age] Pre-formatted age, or milliseconds to format.
 * @property {string} [cwd] Working directory, middle-elided to fit.
 * @property {boolean} [active] Marks the session currently attached.
 */

/**
 * A styled column of the toolbar row.
 *
 * Width maths always runs on `plain`; measuring styled text is how ANSI escapes
 * leak into layout bugs.
 *
 * @typedef {object} Segment
 * @property {string} plain Visible text, no escapes.
 * @property {(text: string) => string} paint Painter for the finished segment.
 * @property {(maxWidth: number) => string} [fit] Shrink that keeps its own delimiters intact.
 */

/**
 * Trim a model field to text; absent and non-string values become empty.
 *
 * @param {unknown} value Field value.
 * @returns {string} Trimmed text.
 */
function textOf(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * Clamp a requested width to something renderable.
 *
 * @param {unknown} value Requested columns.
 * @returns {number} 1..400, defaulting to 80.
 */
function clampWidth(value) {
  const width = Math.trunc(Number(value));
  if (!Number.isFinite(width) || width < 1) return DEFAULT_WIDTH;
  return Math.min(400, width);
}

/**
 * Compact token count: `999 tok`, `12.3k tok`, `1.25M tok`.
 *
 * @param {number} value Token count.
 * @returns {string} Short label.
 */
function formatTokens(value) {
  const count = Math.max(0, Math.trunc(Number(value) || 0));
  if (count < 1000) return `${count} tok`;
  if (count < 1_000_000) return `${trimZeros((count / 1000).toFixed(1))}k tok`;
  return `${trimZeros((count / 1_000_000).toFixed(2))}M tok`;
}

/**
 * `12.0` reads as noise in a toolbar, so drop a trailing zero fraction.
 *
 * @param {string} value Fixed-point number.
 * @returns {string} Shortened number.
 */
function trimZeros(value) {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

/**
 * Pad on the left, for right-aligned numeric columns.
 *
 * @param {unknown} value Text.
 * @param {number} width Target columns.
 * @returns {string} Padded text.
 */
function padLeft(value, width) {
  const text = String(value ?? '');
  const deficit = width - displayWidth(text);
  return deficit > 0 ? ' '.repeat(deficit) + text : text;
}

/**
 * Session label plus how many sessions the workspace holds.
 *
 * @param {object} model Toolbar model.
 * @param {object} theme Theme from `createTheme`.
 * @returns {Segment|null} Segment, or null when there is no session at all.
 */
function sessionSegment(model, theme) {
  const title = textOf(model.sessionTitle);
  // A bare count with no label says nothing about which session is open.
  if (!title) return null;
  const rawCount = Math.trunc(Number(model.sessions));
  const count = Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : null;

  const inner = [count === null ? '' : String(count), title]
    .filter((part) => part !== '')
    .join(` ${theme.glyph.arrow} `);
  const plain = `[${inner}]`;

  return {
    plain,
    paint: theme.style.statusValue,
    // Clipping the whole segment would orphan the closing bracket, so shrink
    // the inside and rebuild it instead.
    fit(maxWidth) {
      if (maxWidth <= 2) return truncateToWidth(plain, maxWidth, theme.glyph.ellipsis);
      return `[${truncateToWidth(inner, maxWidth - 2, theme.glyph.ellipsis)}]`;
    },
  };
}

/**
 * Provider and model as one label, tolerating either one alone.
 *
 * @param {object} model Toolbar model.
 * @param {object} theme Theme from `createTheme`.
 * @returns {Segment|null} Segment, or null when neither is known.
 */
function modelSegment(model, theme) {
  const provider = textOf(model.provider);
  const name = textOf(model.model);
  const label = provider && name ? `${provider}/${name}` : name || provider;
  if (!label) return null;
  return { plain: label, paint: theme.style.statusValue };
}

/**
 * Token total as its own segment.
 *
 * @param {object} model Toolbar model.
 * @param {object} theme Theme from `createTheme`.
 * @returns {Segment|null} Segment, or null when no count is known.
 */
function tokensSegment(model, theme) {
  if (model.tokens === null || model.tokens === undefined) return null;
  const value = Number(model.tokens);
  if (!Number.isFinite(value) || value < 0) return null;
  return { plain: formatTokens(value), paint: theme.style.muted };
}

/**
 * A pre-formatted field (`cost`, `rss`) that is shown as-is.
 *
 * @param {unknown} value Pre-formatted text.
 * @param {(text: unknown) => string} paint Painter.
 * @returns {Segment|null} Segment, or null when the field is empty.
 */
function textSegment(value, paint) {
  const text = textOf(value);
  return text ? { plain: text, paint } : null;
}

/**
 * Turn / connection state with a glyph, so it reads without colour.
 *
 * @param {object} model Toolbar model.
 * @param {object} theme Theme from `createTheme`.
 * @returns {Segment|null} Segment, or null when no status is known.
 */
function statusSegment(model, theme) {
  const status = textOf(model.status);
  if (!status) return null;
  switch (status) {
    case 'idle':
      return { plain: `${theme.glyph.hollow} idle`, paint: theme.style.muted };
    case 'busy':
      return { plain: `${theme.glyph.filled} busy`, paint: theme.style.running };
    case 'error':
      return { plain: `${theme.glyph.cross} error`, paint: theme.style.failure };
    default:
      return { plain: status, paint: theme.style.muted };
  }
}

/**
 * Join the plain halves of segments for a width measurement.
 *
 * @param {Segment[]} segments Kept segments.
 * @returns {string} Plain row text.
 */
function joinPlain(segments) {
  return segments.map((segment) => segment.plain).join(SEPARATOR);
}

/**
 * Which row the window follows: the cursor when given, else the active session.
 *
 * @param {SessionRow[]} rows Session rows.
 * @param {number} [selected] Cursor index from the caller.
 * @returns {number} Index to keep visible.
 */
function focusIndex(rows, selected) {
  if (Number.isInteger(selected) && selected >= 0 && selected < rows.length) return selected;
  const active = rows.findIndex((row) => row.active === true);
  return active >= 0 ? active : 0;
}

/**
 * One picker row: marker, id, title, age and cwd in fixed columns.
 *
 * @param {SessionRow} row Session row.
 * @param {{ budget: number, theme: object, selected: boolean }} options Layout.
 * @returns {string} Styled row, never wider than `budget`.
 */
function pickerLine(row, { budget, theme, selected }) {
  // Cursor and attached session are different states: the arrow follows the
  // keyboard, the dot keeps marking the open session when the cursor moves.
  const marker = selected ? theme.glyph.arrow : row.active === true ? theme.glyph.filled : ' ';
  const ellipsis = theme.glyph.ellipsis;
  const title = textOf(row.title);
  const id = textOf(row.id);
  const age =
    typeof row.age === 'number' && Number.isFinite(row.age)
      ? formatDuration(row.age)
      : textOf(row.age);
  const cwd = textOf(row.cwd);

  let plain;
  if (budget < PICKER_COLUMNS_MIN) {
    // Too narrow for aligned columns: keep the marker and whatever title fits.
    const titleWidth = Math.max(0, budget - 2);
    plain = `${marker} ${truncateToWidth(title || id, titleWidth, ellipsis)}`.trimEnd();
  } else {
    const room = budget - PICKER_FIXED_COLUMNS;
    const cwdPart =
      room >= PICKER_CWD_MIN + PICKER_TITLE_MIN
        ? Math.min(PICKER_CWD_MAX + 2, room - PICKER_TITLE_MIN)
        : 0;
    const titleWidth = room - cwdPart;
    const columns = [
      `${marker} `,
      padToWidth(truncateToWidth(id, PICKER_ID_COLUMNS, ellipsis), PICKER_ID_COLUMNS),
      '  ',
      padToWidth(truncateToWidth(title, titleWidth, ellipsis), titleWidth),
      '  ',
      padLeft(truncateToWidth(age, PICKER_AGE_COLUMNS, ellipsis), PICKER_AGE_COLUMNS),
    ];
    if (cwdPart > 0) {
      const cwdWidth = cwdPart - 2;
      columns.push('  ', truncateToWidth(shortenPath(cwd, cwdWidth), cwdWidth));
    }
    plain = columns.join('').trimEnd();
  }

  const paint = selected
    ? theme.style.selected
    : row.active === true
      ? theme.style.statusValue
      : (value) => String(value);
  return paint(plain);
}

/**
 * Hidden-row hint; also the only affordance the picker has when it scrolls.
 *
 * @param {{ above: number, below: number, theme: object, budget: number }} options Counts.
 * @returns {string} Muted hint line.
 */
function scrollHint({ above, below, theme, budget }) {
  const parts = [];
  if (above > 0) parts.push(`${above} above`);
  if (below > 0) parts.push(`${below} below`);
  const text = `${theme.glyph.foldHint} ${parts.join(', ')}`;
  return theme.style.muted(truncateToWidth(text, budget, theme.glyph.ellipsis));
}

/** Tab labels shown in the top bar, one per entry point. */
export const TOOLBAR_TABS = Object.freeze(['sessions', 'project', 'plugins', 'skills', 'model']);

/**
 * Render the top tab bar: active tab in brackets plus the slash-command hint.
 *
 * The brackets carry the active state on their own, so the row still reads on a
 * terminal without colour, in a screenshot, and in a screen-reader transcript.
 *
 * @param {object} [options] Options.
 * @param {number} [options.width] Column budget.
 * @param {number} [options.active] Active tab index.
 * @param {object} [options.theme] Theme from `createTheme`.
 * @returns {string} Styled row, width-clipped, no trailing newline.
 */
export function renderTabBar({ width = DEFAULT_WIDTH, active = 0, theme = DEFAULT_THEME } = {}) {
  const budget = clampWidth(width);
  const index = Number.isInteger(active) && active >= 0 && active < TOOLBAR_TABS.length ? active : 0;
  const label = TOOLBAR_TABS.map((name, position) => {
    const text = position === index ? `[${name}]` : ` ${name} `;
    return position === index ? theme.style.selected(text) : theme.style.muted(text);
  }).join(theme.style.muted('│'));
  // The hint is the first thing to go when columns are scarce: the tabs are
  // navigation, the hint only advertises it.
  const hint = budget >= 72 ? theme.style.muted('  /help') : '';
  return truncateToWidth(`${label}${hint}`, budget);
}

/**
 * Render the session list the toolbar opens.
 *
 * @param {SessionRow[]} rows Sessions to list, newest first.
 * @param {object} [options] Rendering options.
 * @param {number} [options.width] Column budget (default 80).
 * @param {number} [options.height] Rows shown before scrolling (default 10).
 * @param {number} [options.selected] Cursor row; defaults to the active session.
 * @param {object} [options.theme] Theme from `createTheme`.
 * @returns {string[]} Lines, plus one hint line when the list is scrolled.
 */
export function renderSessionPicker(
  rows,
  { width = DEFAULT_WIDTH, height = PICKER_ROWS, selected, theme = DEFAULT_THEME } = {},
) {
  const list = Array.isArray(rows)
    ? rows.filter((row) => row !== null && typeof row === 'object')
    : [];
  // An empty list must say so. Returning nothing leaves a blank screen that
  // reads as a broken picker rather than "you have no sessions yet".
  if (list.length === 0) {
    return [theme.style.muted(truncateToWidth('  no sessions yet — send a prompt to create one', clampWidth(width), theme.glyph.ellipsis))];
  }

  const budget = clampWidth(width);
  const visible = Math.max(1, Math.min(Math.trunc(Number(height)) || PICKER_ROWS, list.length));
  const focus = focusIndex(list, selected);
  // Centre the cursor, then clamp the window to the ends of the list so the
  // first and last rows can still be selected.
  const start = Math.max(0, Math.min(focus - Math.floor(visible / 2), list.length - visible));

  const lines = [];
  for (let index = start; index < start + visible; index += 1) {
    lines.push(pickerLine(list[index], { budget, theme, selected: index === focus }));
  }
  if (list.length > visible) {
    lines.push(
      scrollHint({
        above: start,
        below: list.length - (start + visible),
        theme,
        budget,
      }),
    );
  }
  return lines;
}

/**
 * One-row session toolbar.
 *
 * The row is rebuilt from the caller's model on each repaint rather than kept
 * as mutable cells, so there is no second copy of the state to drift.
 */
export class Toolbar {
  /**
   * @param {object} [options] Options.
   * @param {number} [options.width] Column budget; assign to it again on resize.
   * @param {object} [options.theme] Theme from `createTheme`; colour off by default.
   * @param {boolean} [options.interactive] Pad to `width` so an in-place repaint overwrites
   *   the previous frame; a piped log stays free of trailing blanks.
   * @param {number} [options.height] Picker rows shown before scrolling.
   */
  constructor({ width = DEFAULT_WIDTH, theme, interactive = false, height = PICKER_ROWS } = {}) {
    this.width = width;
    this.height = height;
    this.theme = theme ?? DEFAULT_THEME;
    this.interactive = Boolean(interactive);
  }

  /**
   * Render the toolbar row, dropping segments from the right as it narrows so
   * the session label survives.
   *
   * @param {object} [model] Session/model snapshot; every field is optional.
   * @param {string} [model.sessionTitle] Label of the active session.
   * @param {number} [model.sessions] How many sessions exist for this workspace.
   * @param {string} [model.provider] Provider id.
   * @param {string} [model.model] Model id.
   * @param {number|null} [model.tokens] Token total.
   * @param {string|null} [model.cost] Pre-formatted cost, e.g. `$0.0042`.
   * @param {string|null} [model.rss] Pre-formatted memory, e.g. `250 MiB`.
   * @param {string} [model.status] `idle` | `busy` | `error`, or any short label.
   * @returns {string} Styled row, width-clipped, no trailing newline, empty when
   *   the model carries nothing to show.
   */
  render(model = {}) {
    const source = model !== null && typeof model === 'object' ? model : {};
    const { theme } = this;
    const budget = clampWidth(this.width);

    const segments = [
      sessionSegment(source, theme),
      modelSegment(source, theme),
      tokensSegment(source, theme),
      textSegment(source.cost, theme.style.muted),
      textSegment(source.rss, theme.style.muted),
      statusSegment(source, theme),
    ].filter((segment) => segment !== null);
    if (segments.length === 0) return '';

    let kept = segments;
    while (kept.length > 1 && displayWidth(joinPlain(kept)) > budget) {
      kept = kept.slice(0, -1);
    }

    let line;
    if (kept.length === 1) {
      const only = kept[0];
      const fitted =
        displayWidth(only.plain) <= budget
          ? only.plain
          : typeof only.fit === 'function'
            ? only.fit(budget)
            : truncateToWidth(only.plain, budget, theme.glyph.ellipsis);
      line = only.paint(fitted);
    } else {
      line = kept.map((segment) => segment.paint(segment.plain)).join(theme.style.muted(SEPARATOR));
    }

    return this.interactive ? padToWidth(line, budget) : line;
  }

  /**
   * Render the session picker this toolbar opens.
   *
   * @param {object} [model] Picker model.
   * @param {SessionRow[]} [model.rows] Sessions to list; `sessions` is accepted as an alias.
   * @param {number} [model.selected] Cursor row; defaults to the active session.
   * @param {number} [model.width] Override the instance width.
   * @param {number} [model.height] Override the instance picker height.
   * @returns {string[]} Lines, plus one hint line when the list is scrolled.
   */
  pick(model = {}) {
    const source = model !== null && typeof model === 'object' ? model : {};
    const rows = Array.isArray(source.rows)
      ? source.rows
      : Array.isArray(source.sessions)
        ? source.sessions
        : [];
    return renderSessionPicker(rows, {
      width: Number.isFinite(Number(source.width)) ? Number(source.width) : this.width,
      height: Number.isFinite(Number(source.height)) ? Number(source.height) : this.height,
      selected: Number.isInteger(source.selected) ? source.selected : undefined,
      theme: this.theme,
    });
  }
}