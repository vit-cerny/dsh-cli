/**
 * Memory sampling for the client and the DSH runtime it drives.
 *
 * Two measurements with very different reliability:
 *
 * - **client RSS** comes from `process.memoryUsage()` and is always available;
 * - **runtime RSS** needs an OS probe (`tasklist` on Windows, `ps` elsewhere).
 *   That probe costs a child process, so it is bounded by a timeout, cached
 *   between samples, and every failure degrades to `null` rather than an error:
 *   a status line is not worth crashing a session over.
 *
 * The probe takes its command runner as a parameter, so a unit test asserts the
 * parsing and the sampling schedule without ever spawning anything.
 *
 * The two-second default is deliberate: a per-second process spawn would cost
 * more than the number it displays.
 *
 * @module dsh-cli/session/resources
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

/** Default sampling period; a status line does not need more. */
const DEFAULT_INTERVAL_MS = 2000;

/** A probe that hangs must not outlive the sample it belongs to. */
const PROBE_TIMEOUT_MS = 1500;

/** Bytes in one KiB, the unit `tasklist` and `ps` report in. */
const KIB = 1024;

/**
 * One client-side memory sample.
 *
 * @typedef {object} RssSample
 * @property {number} rssBytes Resident set size.
 * @property {number} heapUsedBytes Used JS heap.
 * @property {number} externalBytes Off-heap memory owned by JS objects.
 * @property {number} at Epoch milliseconds when the sample was taken.
 */

/**
 * One sampler snapshot, in bytes.
 *
 * @typedef {object} ResourceSnapshot
 * @property {number|null} clientRss This process's resident set.
 * @property {number|null} runtimeRss The DSH runtime's resident set, when probed.
 * @property {number|null} totalRss Client plus runtime; client alone without a probe.
 * @property {number} at Epoch milliseconds of the last sample.
 */

/**
 * Run one probe command and return its standard output.
 *
 * `execFileSync` rather than a shell keeps the pid a plain argument, and the
 * timeout is enforced by the OS call itself.
 *
 * @param {string} file Executable name.
 * @param {string[]} args Arguments.
 * @param {{ timeoutMs: number }} options Bound on the whole call.
 * @returns {string} Captured stdout.
 */
function defaultRun(file, args, { timeoutMs }) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Parse the memory cell of a `tasklist /FO CSV /NH` row.
 *
 * Output shape: `"node.exe","12345","Console","1","123,456 K"`. The thousands
 * separator sits inside the quoted cell, so the cell is read by keeping digits
 * rather than by splitting on commas.
 *
 * @param {unknown} text Probe stdout.
 * @param {number} pid Process id that must match.
 * @returns {number|null} Resident bytes, or `null` when no row matches.
 */
function parseTasklistCsv(text, pid) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ''));
    if (cells.length < 5) continue;
    if (Math.trunc(Number(cells[1])) !== pid) continue;
    const kib = Number(cells[4].replace(/[^0-9]/g, ''));
    if (Number.isFinite(kib) && kib > 0) return kib * KIB;
  }
  return null;
}

/**
 * Parse the bare KiB number printed by `ps -o rss= -p <pid>`.
 *
 * @param {unknown} text Probe stdout.
 * @returns {number|null} Resident bytes, or `null` when the row is absent.
 */
function parsePsRss(text) {
  const match = /(\d+)/.exec(String(text ?? ''));
  if (match === null) return null;
  const kib = Number(match[1]);
  return Number.isFinite(kib) && kib > 0 ? kib * KIB : null;
}

/**
 * Sample this process's memory. Never throws.
 *
 * @param {{ now?: () => number }} [options] Clock override for tests.
 * @returns {RssSample|null} The sample, or `null` when the OS refuses.
 */
export function sampleRss({ now = Date.now } = {}) {
  try {
    const usage = process.memoryUsage();
    return {
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
      at: now(),
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort resident memory of another process, in bytes.
 *
 * @param {number} pid Target process.
 * @param {object} [options] Probe wiring.
 * @param {(file: string, args: string[], options: { timeoutMs: number }) => string} [options.run]
 *   Command runner; injected in tests so no child process is ever spawned.
 * @param {NodeJS.Platform} [options.platform] Platform to probe for.
 * @param {number} [options.timeoutMs] Probe bound (default 1500 ms).
 * @returns {number|null} Resident bytes, or `null` on any failure.
 */
export function sampleRuntimeRss(pid, options = {}) {
  const id = Math.trunc(Number(pid));
  if (!Number.isFinite(id) || id <= 0) return null;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const timeoutMs =
    Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : PROBE_TIMEOUT_MS;
  try {
    if (platform === 'win32') {
      const output = run('tasklist', ['/FI', `PID eq ${id}`, '/FO', 'CSV', '/NH'], { timeoutMs });
      return parseTasklistCsv(output, id);
    }
    const output = run('ps', ['-o', 'rss=', '-p', String(id)], { timeoutMs });
    return parsePsRss(output);
  } catch {
    return null;
  }
}

/**
 * Binary byte size for a status segment.
 *
 * @param {unknown} bytes Byte count.
 * @returns {string} e.g. `0 B`, `512 B`, `84.2 MiB`, `1.5 GiB`.
 */
export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < KIB) return `${Math.round(value)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value / KIB;
  let index = 0;
  while (scaled >= KIB && index < units.length - 1) {
    scaled /= KIB;
    index += 1;
  }
  // `1.0 MiB` reads as noise, so a zero fraction is dropped.
  return `${scaled.toFixed(1).replace(/\.0$/, '')} ${units[index]}`;
}

/**
 * Periodic memory sampler for the status bar.
 *
 * Construction never probes, and `snapshot` reuses the last sample: a repaint
 * must not cost a process spawn, so probing happens on `start()` and per tick
 * only. The exception is a changed `runtimePid`, which is sampled at once so a
 * runtime started after the sampler still appears without waiting a tick.
 */
export class ResourceSampler {
  /** @type {number} */
  #intervalMs;
  /** @type {ResourceSnapshot|null} */
  #snapshot = null;
  /** @type {number|null} */
  #sampledPid = null;
  /** @type {unknown} */
  #timer = null;
  /** @type {() => number} */
  #now;
  /** @type {() => RssSample|null} */
  #rss;
  /** @type {(pid: number) => number|null} */
  #probe;
  /** @type {{ setInterval: Function, clearInterval: Function }} */
  #timers;

  /**
   * Process id probed for runtime memory. A field rather than a constructor
   * argument only because the pid is known after the client spawns and can
   * change when the runtime restarts.
   *
   * @type {number|undefined}
   */
  runtimePid;

  /**
   * @param {object} [options] Sampler wiring.
   * @param {number} [options.intervalMs] Sampling period (default 2000 ms).
   * @param {number} [options.runtimePid] Runtime process to probe.
   * @param {() => number} [options.now] Clock override for `at`.
   * @param {() => RssSample|null} [options.rss] Client sampler override.
   * @param {(pid: number) => number|null} [options.sampleRuntime] Runtime probe override.
   * @param {{ setInterval: Function, clearInterval: Function }} [options.timers] Timer override for tests.
   */
  constructor({ intervalMs = DEFAULT_INTERVAL_MS, runtimePid, now, rss, sampleRuntime, timers } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new TypeError('ResourceSampler intervalMs must be a positive safe integer');
    }
    this.#intervalMs = intervalMs;
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#rss = typeof rss === 'function' ? rss : sampleRss;
    this.#probe = typeof sampleRuntime === 'function' ? sampleRuntime : sampleRuntimeRss;
    this.#timers = timers ?? { setInterval, clearInterval };
    this.runtimePid = Number.isFinite(Number(runtimePid)) ? Number(runtimePid) : undefined;
  }

  /**
   * Take one sample. Any failure inside a probe narrows the snapshot instead of
   * escaping, because the sampler runs on a timer nobody awaits.
   *
   * @returns {ResourceSnapshot} The new snapshot.
   */
  #sample() {
    let clientRss = null;
    let runtimeRss = null;
    try {
      clientRss = this.#rss()?.rssBytes ?? null;
    } catch {
      clientRss = null;
    }
    const pid = Number.isFinite(Number(this.runtimePid)) ? Number(this.runtimePid) : null;
    this.#sampledPid = pid;
    if (pid !== null) {
      try {
        runtimeRss = this.#probe(pid);
      } catch {
        runtimeRss = null;
      }
    }
    this.#snapshot = {
      clientRss,
      runtimeRss,
      totalRss: runtimeRss === null ? clientRss : (clientRss ?? 0) + runtimeRss,
      at: this.#now(),
    };
    return this.#snapshot;
  }

  /**
   * Begin sampling: one sample immediately, then one per interval. Idempotent.
   *
   * @returns {void}
   */
  start() {
    if (this.#timer !== null) return;
    this.#sample();
    this.#timer = this.#timers.setInterval(() => this.#sample(), this.#intervalMs);
    // A status line must never keep the process alive on its own.
    this.#timer?.unref?.();
  }

  /**
   * Stop sampling. Idempotent; the last snapshot stays readable.
   *
   * @returns {void}
   */
  stop() {
    if (this.#timer === null) return;
    this.#timers.clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * The current sample. It is taken on first access, and again whenever
   * `runtimePid` changed, so a runtime that starts after the sampler appears
   * without waiting a tick; otherwise a repaint reuses the last tick and costs
   * nothing.
   *
   * @returns {ResourceSnapshot} Bytes for the client, the runtime and their sum.
   */
  get snapshot() {
    const pid = Number.isFinite(Number(this.runtimePid)) ? Number(this.runtimePid) : null;
    if (this.#snapshot === null || pid !== this.#sampledPid) return this.#sample();
    return this.#snapshot;
  }
}
