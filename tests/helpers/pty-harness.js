/**
 * Real-terminal harness for the interactive UI.
 *
 * ## Why a pseudo-terminal
 *
 * The interactive UI cannot be tested through a pipe. `App` checks
 * `stdin.isTTY && stdout.isTTY` and takes a completely different code path in
 * line mode, so a piped test passes while the real screen is broken. Every bug
 * this harness was written to catch — the cursor arithmetic that ate the
 * transcript, Enter never submitting, Ctrl+D hanging — was invisible to piped
 * tests and obvious in a PTY.
 *
 * `node-pty` allocates a Windows ConPTY; `@xterm/headless` replays the byte
 * stream into a cell grid, the same emulator family the Desktop terminal uses.
 * Assertions therefore read the screen a user would actually see, including
 * cursor addressing, erases and alternate-screen behaviour.
 *
 * Both packages ship with DSH Desktop, so this adds no dependency to the CLI
 * itself. When they cannot be resolved the whole group skips, which keeps the
 * suite runnable on a machine without the app installed.
 *
 * @module tests/helpers/pty-harness
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

/** Directories that may hold DSH Desktop's bundled node_modules. */
const CANDIDATE_MODULES = [
  'C:\\Program Files\\DSH Desktop\\resources\\app\\node_modules',
  process.env.DSH_DESKTOP_MODULES ?? '',
].filter((value) => value !== '');

/**
 * Resolve one bundled package, or null when it is unavailable.
 *
 * @param {string} name Package to resolve.
 * @returns {any|null} The module, or null.
 */
function resolveBundled(name) {
  for (const modules of CANDIDATE_MODULES) {
    try {
      const require = createRequire(path.join(modules, 'noop.js'));
      return require(name);
    } catch {
      continue;
    }
  }
  return null;
}

let cached = null;

/**
 * Load the two packages this harness needs.
 *
 * @returns {{ spawn: Function, Terminal: Function } | null} Loaded API, or null.
 */
export function loadPtySupport() {
  if (cached !== null) return cached;
  const pty = resolveBundled('node-pty');
  const headless = resolveBundled('@xterm/headless');
  if (pty === null || headless === null) return null;
  cached = { spawn: pty.spawn, Terminal: headless.Terminal };
  return cached;
}

/**
 * Whether GUI tests should run in this environment.
 *
 * They are off by default because each launches the real application and its
 * child runtime (about ten seconds per case), which would dominate a suite whose
 * unit tests finish in one. `npm run test:gui` turns them on.
 *
 * @returns {string|false} A skip reason, or false when they can run.
 */
export function guiSkipReason() {
  if (process.env.DSH_CLI_GUI !== '1') return 'set DSH_CLI_GUI=1 (or run `npm run test:gui`) to exercise the real terminal';
  if (loadPtySupport() === null) return 'node-pty / @xterm/headless unavailable: install DSH Desktop';
  if (process.platform !== 'win32') return 'the PTY harness is written against the Windows ConPTY';
  return false;
}

/**
 * Launch the CLI inside a pseudo-terminal.
 *
 * @param {object} [options] Options.
 * @param {number} [options.cols] Terminal width.
 * @param {number} [options.rows] Terminal height.
 * @param {string} [options.entry] Entry module, relative to the repo root.
 * @param {string} [options.cwd] Working directory.
 * @param {Record<string, string|undefined>} [options.env] Extra environment.
 * @returns {object} Harness handle.
 */
export function launchCli({ cols = 100, rows = 30, entry = 'src/main.js', cwd, env = {} } = {}) {
  const support = loadPtySupport();
  if (support === null) throw new Error('PTY support is unavailable');
  const root = cwd ?? process.cwd();

  const terminal = new support.Terminal({ cols, rows, allowProposedApi: true });
  let raw = '';
  /** Populated by the exit callback: node-pty leaves `.exitCode` undefined. */
  let exitInfo = null;
  const child = support.spawn(process.execPath, [entry], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: root,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...env },
  });
  child.onData((chunk) => {
    raw += chunk;
    terminal.write(chunk);
  });
  child.onExit((info) => {
    exitInfo = info;
  });

  /**
   * The visible screen, one string per row, right-trimmed.
   *
   * @returns {string[]} Rows, top first.
   */
  const screen = () => {
    const buffer = terminal.buffer.active;
    const lines = [];
    for (let row = 0; row < terminal.rows; row += 1) {
      const line = buffer.getLine(row);
      lines.push(line === undefined ? '' : line.translateToString(true).replace(/\s+$/, ''));
    }
    return lines;
  };

  /**
   * Wait until a predicate over the screen holds.
   *
   * Polls rather than sleeping a fixed interval: startup cost varies with the
   * runtime handshake, and a generous fixed wait makes the suite slow while a
   * short one makes it flaky.
   *
   * @param {(lines: string[]) => boolean} predicate Condition.
   * @param {{ timeoutMs?: number, label?: string }} [options] Timing.
   * @returns {Promise<string[]>} The screen that satisfied it.
   */
  const waitFor = async (predicate, { timeoutMs = 30000, label = 'screen condition' } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let last = screen();
    while (Date.now() < deadline) {
      last = screen();
      if (predicate(last)) return last;
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    throw new Error(
      `timed out waiting for ${label} after ${timeoutMs}ms\n--- screen ---\n${last.join('\n')}`,
    );
  };

  return {
    child,
    screen,
    waitFor,
    /** Raw bytes received, for assertions about escape sequences. */
    raw: () => raw,
    /**
     * Send text exactly as given.
     *
     * Deliberately *not* an escape decoder: a JavaScript caller writing `'\n'`
     * means a newline byte (0x0A, which this UI maps to Ctrl+J), while Enter is
     * a carriage return (0x0D). Conflating the two silently turns "press
     * Enter" into "insert a line break", so the keys have explicit helpers.
     *
     * @param {string} text Raw text.
     * @returns {void}
     */
    type(text) {
      child.write(String(text));
    },
    /** Press Enter (carriage return). */
    enter() {
      child.write('\r');
    },
    /** Press Tab. */
    tab() {
      child.write('\t');
    },
    /**
     * Press a Ctrl chord.
     *
     * @param {string} letter Single letter, e.g. `'d'`.
     * @returns {void}
     */
    ctrl(letter) {
      const code = String(letter).toUpperCase().charCodeAt(0) - 64;
      child.write(String.fromCharCode(code));
    },
    // No `resize` helper on purpose. A Windows ConPTY does not deliver a resize
    // notification to the child: `process.stdout.columns` keeps its original
    // value and no `resize` event fires (verified by probing a bare child that
    // only listened for the event). Resizing the emulator alone would then
    // assert against a geometry the app never saw, which proves nothing. The
    // app's resize handler is covered by `tests/ui-resize.test.js`, which drives
    // a fake TTY and fires the event directly.
    /** Whether the child process has exited. */
    exited: () => exitInfo !== null,
    /** Exit code, or null while still running. */
    exitCode: () => (exitInfo === null ? null : exitInfo.exitCode),
    /**
     * Ask the app to quit and wait for it to exit.
     *
     * Preferred over {@link dispose}'s forced kill: a hard kill on a ConPTY
     * child makes node-pty look for its console-list helper and print
     * "Could not find ..." while sometimes leaving a handle open, which keeps
     * the test runner alive after every case has already passed.
     *
     * @param {{ timeoutMs?: number }} [options] Timing.
     * @returns {Promise<boolean>} True when the process exited.
     */
    async quit({ timeoutMs = 8000 } = {}) {
      if (exitInfo !== null) return true;
      try {
        child.write('\u0004');
      } catch {
        /* stdin already closed */
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (exitInfo !== null) return true;
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      return exitInfo !== null;
    },
    /**
     * Terminate the child and release the emulator.
     *
     * Called from a `finally`, so it also runs when a case failed mid-assertion
     * and never reached a graceful quit. It therefore has to *confirm* the
     * process is gone rather than fire-and-forget: a leaked child keeps the
     * runtime handshake busy, and the next case then times out waiting for a
     * frame that never arrives — a flake that looks like a product bug.
     *
     * @returns {Promise<void>} Resolves once the child is dead.
     */
    async dispose() {
      if (exitInfo === null) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        // The exit callback is asynchronous; give the OS time to reap it so the
        // next case starts against a clean process table.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && exitInfo === null) {
          await new Promise((resolve) => { setTimeout(resolve, 50); });
        }
      }
      terminal.dispose();
    },
  };
}

/**
 * Locate the input box in a rendered frame.
 *
 * @param {string[]} lines Screen rows.
 * @returns {{ top: number, bottom: number, left: number, right: number }|null} Bounds, or null.
 */
export function findBox(lines) {
  const top = lines.findIndex((line) => line.includes('\u256d'));
  if (top === -1) return null;
  const bottom = lines.findIndex((line, index) => index > top && line.includes('\u2570'));
  if (bottom === -1) return null;
  const left = lines[top].indexOf('\u256d');
  const right = lines[top].indexOf('\u256e');
  return { top, bottom, left, right };
}

/**
 * Structural problems with one rendered frame.
 *
 * Returns an array so a failing assertion can report every problem at once
 * rather than only the first.
 *
 * @param {string[]} lines Screen rows.
 * @param {{ cols?: number, requireBox?: boolean }} [options] Expectations.
 * @returns {string[]} Problems, empty when the frame is well formed.
 */
export function frameProblems(lines, { cols, requireBox = true } = {}) {
  const problems = [];
  const width = cols ?? Math.max(...lines.map((line) => line.length));

  for (const [index, line] of lines.entries()) {
    if (line.length > width) problems.push(`row ${index + 1} is ${line.length} wide, frame is ${width}`);
  }

  if (requireBox) {
    const box = findBox(lines);
    if (box === null) {
      problems.push('no input box found (expected a row with \u256d and a later row with \u2570)');
    } else if (box.right === -1) {
      problems.push('the input box top border has no right corner');
    } else {
      for (let index = box.top + 1; index < box.bottom; index += 1) {
        const line = lines[index] ?? '';
        if (line[box.left] !== '\u2502') problems.push(`box row ${index + 1} lost its left border`);
        if (line[box.right] !== '\u2502') problems.push(`box row ${index + 1} lost its right border`);
      }
      const bottomRow = lines[box.bottom] ?? '';
      if (bottomRow.indexOf('\u2570') !== box.left) {
        problems.push('the bottom-left corner is not aligned with the top-left');
      }
      if (bottomRow.indexOf('\u256f') !== box.right) {
        problems.push('the bottom-right corner is not aligned with the top-right');
      }
    }
  }

  return problems;
}