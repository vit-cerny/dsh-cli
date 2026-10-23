#!/usr/bin/env node
/**
 * dsh-cli entry point.
 *
 * Scaffold placeholder (task T1). Real behaviour is added by later tasks:
 *   T2 src/rpc + src/session, T3 src/ui, T4 packages/web-deepseek-api,
 *   T5 src/config, T6 tests/ram, T8 src/acp + src/cli.
 *
 * Design constraints for this file: pure ESM, zero runtime dependencies,
 * no build step. Types are expressed as JSDoc so an editor can check it
 * without a TypeScript compile phase.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Read and parse the package manifest that owns this entry point.
 *
 * @returns {{ name?: string, version?: string }} Parsed package.json fields.
 */
function readManifest() {
  const manifestUrl = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(manifestUrl, 'utf8'));
}

/**
 * Print the one-line usage hint.
 *
 * @param {NodeJS.WriteStream} stream Destination stream.
 * @returns {void}
 */
function printUsage(stream) {
  stream.write(
    'dsh-cli — DeepSeek Harness terminal client. ' +
      'Usage: dsh-cli [--version|-V] [--help|-h]\n',
  );
}

/**
 * Entry point.
 *
 * @param {string[]} argv Arguments without the node executable and script path.
 * @returns {number} Process exit code.
 */
function main(argv) {
  const flags = new Set(argv);

  if (flags.has('--version') || flags.has('-V')) {
    process.stdout.write(`${readManifest().version}\n`);
    return 0;
  }

  if (flags.has('--help') || flags.has('-h')) {
    printUsage(process.stdout);
    return 0;
  }

  if (argv.length === 0) {
    printUsage(process.stdout);
    return 0;
  }

  process.stderr.write(`dsh-cli: unknown argument: ${argv[0]}\n`);
  printUsage(process.stderr);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
