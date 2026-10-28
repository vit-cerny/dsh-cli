/**
 * Shared output helpers and the top-level command dispatch table.
 *
 * `src/main.js` stays a thin entry point: it parses argv (`./args.js`), builds
 * a context (`./context.js`), and calls {@link dispatch}. Everything a command
 * prints goes through the streams handed to it, so a test can capture exact
 * output without a TTY.
 *
 * @module src/cli/index
 */

/**
 * Print one line to a stream.
 *
 * @param {NodeJS.WriteStream} stream Destination.
 * @param {string} [line] Text without a trailing newline.
 * @returns {void}
 */
export function writeLine(stream, line = '') {
  stream.write(`${line}\n`);
}

/**
 * Print a numbered list, aligned.
 *
 * @param {NodeJS.WriteStream} stream Destination.
 * @param {string[]} items Items to print under `title`.
 * @param {{ title?: string, indent?: string }} [options] Formatting.
 * @returns {void}
 */
export function writeList(stream, items, { title, indent = '  ' } = {}) {
  if (title !== undefined) writeLine(stream, title);
  for (const item of items) writeLine(stream, `${indent}${item}`);
}

/**
 * Display width of a string, ignoring ANSI escapes (only plain text is used here).
 *
 * @param {string} text Text.
 * @returns {number} Length.
 */
export function width(text) {
  return String(text).length;
}

export { parseArgs, COMMANDS, EXIT_USAGE, UsageError, findCommand } from './args.js';
export {
  CliError,
  FALLBACK_ROUTE,
  describeError,
  parseRouteFromPatch,
  readProfileRoute,
  resolveContext,
  resolveDshHome,
} from './context.js';
export {
  formatInventory,
  listSkills,
  parseLlmRoutes,
  parseMcpServers,
  readProfileInventory,
  runInfoCommand,
  runSessionsCommand,
  skillsFromSystemPrompt,
} from './info.js';
export { DEFAULT_RUN_TIMEOUT_MS, parseTimeout, runOnce, toolLabel } from './run.js';
export {
  driverOptions,
  reportingCommands,
  resolveResumeId,
  restoreTerminal,
  runInteractive,
  sessionsCommand,
} from './interactive.js';
export {
  encodeWorkspaceDir,
  formatAge,
  formatSessionRow,
  decodeSessionLog,
  readSessionHeader,
  readSessionSummaries,
} from './store.js';
export { appDirFromInstallRoot, resolveRuntimeBin, runtimeBinIn, runtimeHint } from './discover.js';
export {
  diffPlugins,
  formatPluginTable,
  readInstalledPlugins,
  readPluginProfileRows,
  runPluginsCommand,
  syncPlugins,
} from './plugins.js';
export {
  applyMigration,
  detectSources,
  formatPlan,
  planMigration,
  runMigrateCommand,
  SOURCE_IDS,
} from './migrate.js';
export { formatUsageReport, readSessionUsage, readStoreUsage, runUsageCommand } from './usage-command.js';
export { formatChecks, runChecks, runDoctorCommand } from './doctor.js';
export {
  PRICING_FILE,
  describePricing,
  pricingOverrideFor,
  readPricingFile,
  resolveOverride,
} from './pricing-config.js';
