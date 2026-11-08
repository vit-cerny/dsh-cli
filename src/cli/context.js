/**
 * Runtime and route resolution for `dsh-cli`.
 *
 * The CLI never owns an agent core: every command drives the installed DSH SDK
 * runtime over JSON-RPC (see docs/FINDINGS.md §4). This module is the single
 * place that decides *which* runtime, *which* profile, and *which*
 * provider/model route a command will use, and it turns every way that answer
 * can be wrong into one actionable message instead of a stack trace.
 *
 * Precedence, highest first:
 *   1. explicit CLI flags      `--profile`, `--provider`, `--model`, `--cwd`
 *   2. environment             `DSH_CLI_PROFILE`, `DSH_CLI_PROVIDER`, `DSH_CLI_MODEL`
 *   3. the DSH Desktop profile `cordis.patch.yml` (same file Desktop reads, so
 *                              the CLI and the GUI cannot fork into two truths)
 *   4. built-in defaults       profile `sdk`, route `deepseek-official` /
 *                              `deepseek-flash`
 *
 * The last fallback is only used when the profile patch cannot be read; a real
 * installation always supplies a route at step 3.
 *
 * @module src/cli/context
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { resolveRuntimeBin, runtimeHint } from './discover.js';
import { DEFAULT_RUNTIME_PROFILE } from '../rpc/client.js';

/** Fallback route when the profile patch does not name one. */
export const FALLBACK_ROUTE = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-flash',
});

/**
 * An error whose message is written for the end user (no stack trace shown).
 * `src/cli/` prints `message`, then `hint` when present, and exits `exitCode`.
 */
export class CliError extends Error {
  /**
   * @param {string} message What failed, in one sentence.
   * @param {{ hint?: string, exitCode?: number, cause?: unknown }} [options]
   */
  constructor(message, { hint, exitCode = 1, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CliError';
    /** @type {string} */
    this.exitCode = exitCode;
    /** @type {string | undefined} */
    this.hint = hint;
  }
}

/**
 * The directory holding DSH profiles (`~/.dsh` unless `DSH_HOME` overrides it).
 *
 * @param {Record<string, string | undefined>} [env] Environment to read.
 * @returns {string} Absolute home directory.
 */
export function resolveDshHome(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : path.join(homedir(), '.dsh');
}

/**
 * Resolve the runtime entry point and refuse a path that cannot work.
 *
 * @param {string | undefined} runtimeBin Explicit candidate from the environment.
 * @returns {string} The validated path.
 * @throws {CliError} When no DSH install can be found.
 */
export function assertRuntimeBin(runtimeBin) {
  if (typeof runtimeBin === 'string' && runtimeBin !== '') {
    if (!existsSync(runtimeBin)) {
      throw new CliError(`DSH runtime not found: ${runtimeBin}`, {
        hint: 'DSH_CLI_RUNTIME_BIN points at a file that does not exist. Unset it to auto-detect.',
      });
    }
    return runtimeBin;
  }
  const resolved = resolveRuntimeBin();
  if (resolved.bin === null) {
    throw new CliError('no DSH runtime found', { hint: runtimeHint(resolved.tried) });
  }
  return resolved.bin;
}

/**
 * Minimal reader for the subset of YAML the profile patch uses.
 *
 * It is not a YAML parser. It reads the two facts the CLI needs from the
 * loader patch tree — `provider`, `model`, `reasoningEffort`, `maxTokens` —
 * by indentation, which is exactly how `cordis.patch.yml` is written. Anything
 * it cannot see falls back to {@link FALLBACK_ROUTE}; the runtime itself then
 * validates the route during `initialize`, so a misread cannot silently
 * mis-route a turn.
 *
 * @param {string} text File contents.
 * @returns {{ provider?: string, model?: string, reasoningEffort?: string, maxTokens?: number }}
 *   The first (top-most) route found in the tree.
 */
export function parseRouteFromPatch(text) {
  /** @type {{ provider?: string, model?: string, reasoningEffort?: string, maxTokens?: number }} */
  const route = {};
  if (typeof text !== 'string') return route;
  const lines = text.split(/\r?\n/);

  // The authoritative route is the configured default-agent model: the runtime
  // loads it as the default route and applies it to newly created sessions.
  const anchor = lines.findIndex((line) => /^\s*-\s*id\s*:\s*['"]?agent-default-model['"]?\s*$/.test(line));
  if (anchor >= 0) {
    const anchorIndent = /^\s*/.exec(lines[anchor])[0].length;
    for (let index = anchor + 1; index < lines.length; index += 1) {
      const line = lines[index].replace(/\s+#.*$/, '');
      if (line.trim() === '') continue;
      const indent = /^\s*/.exec(line)[0].length;
      // A sibling or shallower `- id:` ends this entry.
      if (indent <= anchorIndent && /^\s*-\s/.test(line)) break;
      const keyed = /^\s*(provider|model|reasoningEffort|maxTokens)\s*:\s*(.+?)\s*$/.exec(line);
      if (keyed === null) continue;
      const [, key, rawValue] = keyed;
      if (rawValue === '' || rawValue.startsWith('!!') || rawValue.startsWith('${')) continue;
      const value = rawValue.replace(/^['"]|['"]$/g, '');
      if (key === 'maxTokens') {
        const numeric = Number(value);
        if (Number.isSafeInteger(numeric) && numeric > 0) route.maxTokens ??= numeric;
      } else if (key === 'provider') route.provider ??= value;
      else if (key === 'model') route.model ??= value;
      else route.reasoningEffort ??= value;
    }
    if (route.provider !== undefined && route.model !== undefined) return route;
  }

  // Fallback for a patch with no `agent-default-model` entry: the shallowest
  // adjacent provider/model pair. 2-space `- id:` items are top-level entries.
  /** @type {{ indent: number, provider?: string } | null} */
  let candidate = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, '');
    const keyed = /^(\s*)(?:-\s+)?(provider|model)\s*:\s*(.+?)\s*$/.exec(line);
    if (keyed === null) continue;
    const [, indentText, key, rawValue] = keyed;
    if (rawValue.startsWith('!!') || rawValue.startsWith('${')) continue;
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    const indent = indentText.length;
    if (key === 'provider') {
      if (candidate === null || indent < candidate.indent) candidate = { indent };
      if (candidate.provider === undefined) candidate.provider = value;
      continue;
    }
    if (candidate === null || route.provider !== undefined) continue;
    route.provider = candidate.provider;
    route.model = value;
  }
  return route;
}

/**
 * Path to the remembered-route file.
 *
 * @param {Record<string, string | undefined>} [env] Environment.
 * @returns {string} Absolute path under the CLI home.
 */
export function lastRouteFile(env = process.env) {
  const home = env.DSH_CLI_HOME !== undefined && env.DSH_CLI_HOME !== ''
    ? env.DSH_CLI_HOME
    : path.join(homedir(), '.dsh-cli');
  return path.join(home, 'last-route.json');
}

/**
 * Read the route the user last chose in the TUI.
 *
 * @param {Record<string, string | undefined>} [env] Environment.
 * @returns {{ provider: string, model: string } | null} Remembered route, or null.
 */
export function readLastRoute(env = process.env) {
  try {
    const data = JSON.parse(readFileSync(lastRouteFile(env), 'utf8'));
    if (typeof data?.provider !== 'string' || typeof data?.model !== 'string') return null;
    if (data.provider === '' || data.model === '') return null;
    return { provider: data.provider, model: data.model };
  } catch {
    // A missing or unreadable file just means "no memory yet".
    return null;
  }
}

/**
 * Remember the route for the next session.
 *
 * @param {{ provider: string, model: string }} route Route that worked.
 * @param {Record<string, string | undefined>} [env] Environment.
 * @returns {void}
 */
export function saveLastRoute(route, env = process.env) {
  try {
    const file = lastRouteFile(env);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ provider: route.provider, model: route.model }, null, 2)}\n`, 'utf8');
  } catch {
    // A read-only home must not break a model switch.
  }
}

/**
 * Read the default route from the patch stack a command will boot.
 *
 * Order matters and mirrors the runtime (`dsh/lib/profile-boot-*.js`): the
 * profile's own `cordis.patch.yml` first, then the home-level
 * `$DSH_HOME/cordis.patch.yml`, which is applied on top and therefore
 * outranks the profile layer. The first route found at each layer wins.
 *
 * @param {string} dshHome DSH home directory.
 * @param {string} profile Profile name.
 * @returns {{ provider?: string, model?: string, reasoningEffort?: string, maxTokens?: number }}
 *   Route fields, possibly empty when no patch names one.
 */
export function readProfileRoute(dshHome, profile) {  for (const file of [
    path.join(dshHome, 'profiles', profile, 'cordis.patch.yml'),
    path.join(dshHome, 'cordis.patch.yml'),
  ]) {
    try {
      const route = parseRouteFromPatch(readFileSync(file, 'utf8'));
      if (route.provider !== undefined && route.model !== undefined) return route;
      if (Object.keys(route).length > 0) return route;
    } catch {
      // Missing or unreadable layer: try the next one.
    }
  }
  return {};
}

/**
 * Every value a resolved context carries. Built once per command.
 *
 * @typedef {object} CliContext
 * @property {string} runtimeBin Absolute runtime entry point.
 * @property {string[]} runtimeArgs `['--profile', name]`.
 * @property {string} profile Profile name.
 * @property {string} dshHome DSH home directory.
 * @property {string} profileDir Profile directory.
 * @property {string} cwd Working directory for the session.
 * @property {string} provider Provider route id.
 * @property {string} model Model id.
 * @property {string} [reasoningEffort] Routed reasoning effort.
 * @property {number} [maxTokens] Per-conversation output cap.
 * @property {Record<string, string | undefined>} env Environment used.
 */

/**
 * The profile a command boots when neither `--profile` nor the environment
 * names one.
 *
 * Two defaults, because the two command families need different things:
 *
 * - **sessions** (`run`, interactive, `resume`) need a profile the terminal can
 *   boot. That is `dsh-cli` when `scripts/install-profile.mjs` installed it,
 *   else the stock `sdk` profile.
 * - **inventory** only reads patch files, so it should describe the richest
 *   configured profile. `dsh-cli` when present, else `desktop` — which the CLI
 *   can read even though it cannot launch it.
 *
 * @param {string} dshHome DSH home directory.
 * @param {'session' | 'inventory'} [kind] Command family.
 * @returns {string} Profile name.
 */
export function defaultProfile(dshHome, kind = 'session') {
  const derived = path.join(dshHome, 'profiles', 'dsh-cli', 'package.json');
  if (existsSync(derived)) return 'dsh-cli';
  return kind === 'inventory' ? 'desktop' : DEFAULT_RUNTIME_PROFILE;
}

/**
 * Build the command context.
 *
 * @param {{
 *   options?: { profile?: string, provider?: string, model?: string, cwd?: string },
 *   env?: Record<string, string | undefined>,
 *   cwd?: string,
 *   kind?: 'session' | 'inventory',
 * }} [input] Parsed options plus the environment to resolve against.
 * @returns {CliContext} A fully resolved context.
 * @throws {CliError} When the runtime or working directory is unusable.
 */
export function resolveContext({ options = {}, env = process.env, cwd, kind = 'session' } = {}) {
  const runtimeBin = assertRuntimeBin(env.DSH_CLI_RUNTIME_BIN);
  const dshHome = resolveDshHome(env);
  const profile =
    options.profile ??
    (env.DSH_CLI_PROFILE !== undefined && env.DSH_CLI_PROFILE !== ''
      ? env.DSH_CLI_PROFILE
      : defaultProfile(dshHome, kind));
  const profileDir = path.join(dshHome, 'profiles', profile);

  const workingDir = path.resolve(cwd ?? options.cwd ?? process.cwd());
  if (!existsSync(workingDir)) {
    throw new CliError(`working directory does not exist: ${workingDir}`);
  }

  const fromProfile = readProfileRoute(dshHome, profile);
  // A model the user picked in a previous session wins over the profile
  // default: reopening the CLI on the route you last chose is what people
  // expect, and the profile only carries the initial value.
  const remembered = options.provider === undefined && options.model === undefined
    ? readLastRoute(env)
    : null;
  const provider =
    options.provider ?? env.DSH_CLI_PROVIDER ?? remembered?.provider ?? fromProfile.provider ?? FALLBACK_ROUTE.provider;
  const model =
    options.model ?? env.DSH_CLI_MODEL ?? remembered?.model ?? fromProfile.model ?? FALLBACK_ROUTE.model;
  if (provider === '' || model === '') {
    throw new CliError('provider and model must be non-empty', {
      hint: 'Pass --provider/--model, or set DSH_CLI_PROVIDER / DSH_CLI_MODEL.',
    });
  }

  /** @type {CliContext} */
  const context = {
    runtimeBin,
    runtimeArgs: ['--profile', profile],
    profile,
    dshHome,
    profileDir,
    cwd: workingDir,
    provider,
    model,
    env,
  };
  // A route override may target a model with different capabilities, so the
  // profile's effort/token settings only apply when the route came from it.
  const routeFromProfile =
    options.provider === undefined &&
    options.model === undefined &&
    env.DSH_CLI_PROVIDER === undefined &&
    env.DSH_CLI_MODEL === undefined;
  if (routeFromProfile) {
    if (fromProfile.reasoningEffort !== undefined) context.reasoningEffort = fromProfile.reasoningEffort;
    if (fromProfile.maxTokens !== undefined) context.maxTokens = fromProfile.maxTokens;
  }
  return context;
}
/**
 * Turn any thrown value into a user-facing one-liner plus optional hint.
 *
 * @param {unknown} error Thrown value.
 * @param {CliContext} [context] Used to append the runtime stderr tail.
 * @returns {{ message: string, hint: string | undefined, exitCode: number }} Report.
 */
export function describeError(error, context) {
  if (error instanceof CliError) {
    return { message: error.message, hint: error.hint, exitCode: error.exitCode };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = /** @type {any} */ (error)?.code;
  if (code === 'SPAWN_FAILED') {
    return {
      message,
      hint: context
        ? `Runtime: ${context.runtimeBin} (set DSH_CLI_RUNTIME_BIN to override).`
        : undefined,
      exitCode: 1,
    };
  }
  const runtimeStderr = /** @type {any} */ (error)?.runtimeStderr;
  const trimmed = typeof runtimeStderr === 'string' ? runtimeStderr.trim() : '';
  const stage = /** @type {any} */ (error)?.stage;
  if (code === 'PROCESS_EXITED') {
    return {
      message: 'the DSH runtime exited unexpectedly',
      hint: trimmed === ''
        ? 'Check that the profile boots on its own: dsh --profile <name> --help'
        : trimmed.split('\n').slice(-8).join('\n'),
      exitCode: 1,
    };
  }
  return {
    message: stage === undefined ? message : `${stage}: ${message}`,
    hint:
      trimmed === ''
        ? undefined
        : `runtime stderr:\n${trimmed.split('\n').slice(-8).join('\n')}`,
    exitCode: 1,
  };
}
