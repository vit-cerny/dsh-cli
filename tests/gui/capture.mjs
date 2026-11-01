/**
 * Capture one real frame from the interactive UI.
 *
 * The GUI suite asserts against the live screen; this script exists to see that
 * screen when a case is failing or hanging, without guessing from the code.
 *
 * @module tests/gui/capture
 */

import process from 'node:process';

import { launchCli } from '../helpers/pty-harness.js';

const cli = launchCli({ cols: 100, rows: 30 });
const started = Date.now();

try {
  await cli.waitFor((rows) => rows.some((row) => row.includes('\u256d')), {
    timeoutMs: 20_000,
    label: 'the input box',
  });
  process.stdout.write(`--- frame after ${Date.now() - started}ms ---\n`);
  for (const [index, row] of cli.screen().entries()) {
    process.stdout.write(`${String(index + 1).padStart(2, ' ')} |${row}\n`);
  }
  process.stdout.write(`--- raw bytes: ${cli.raw().length} ---\n`);
  process.stdout.write(`--- first 600 bytes ---\n${JSON.stringify(cli.raw().slice(0, 600))}\n`);
} catch (error) {
  process.stdout.write(`--- no frame ---\n${error.message}\n`);
  process.stdout.write(`--- raw bytes: ${cli.raw().length} ---\n${JSON.stringify(cli.raw().slice(0, 1200))}\n`);
  process.exitCode = 1;
} finally {
  cli.dispose();
}