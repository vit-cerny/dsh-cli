/**
 * Capture the interactive UI in a real PTY.
 *
 * @module tests/gui/capture
 */

import process from 'node:process';

import { launchCli } from '../helpers/pty-harness.js';

const cli = launchCli({ cols: 100, rows: 30 });
const settle = (ms = 600) => new Promise((resolve) => { setTimeout(resolve, ms); });

try {
  await cli.waitFor((rows) => rows.some((row) => row.includes('\u276f')), {
    timeoutMs: 25_000,
    label: 'the prompt',
  });
  await settle();
  for (const [index, row] of cli.screen().entries()) {
    if (row.trim() !== '') process.stdout.write(`${String(index + 1).padStart(2)} |${row.trimEnd()}\n`);
  }
} catch (error) {
  process.stdout.write(`FAILED: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await cli.dispose();
}
