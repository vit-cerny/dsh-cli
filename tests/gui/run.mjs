/**
 * Run the GUI tests with the opt-in flag already set.
 *
 * `npm test` skips them because each case launches the real application, which
 * is far slower than the unit suite. This runner exists so the opt-in is one
 * command on every platform rather than a shell-specific `VAR=1` prefix.
 *
 * @module tests/gui/run
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-isolation=none',
    // node-pty keeps a ConPTY helper handle alive after the last case, so the
    // runner would otherwise report every test green and then hang forever.
    '--test-force-exit',
    '--test-reporter=spec',
    'tests/gui/*.test.js',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, DSH_CLI_GUI: '1' },
    cwd: process.cwd(),
  },
);

if (result.error) {
  process.stderr.write(`gui tests failed to start: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);