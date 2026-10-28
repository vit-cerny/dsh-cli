import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertRssBudget, measureCliRss } from './benchmark.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('dsh-cli stays dependency-free', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(Object.hasOwn(manifest, 'dependencies'), false, 'runtime dependencies must not be added')
  assert.equal(Object.hasOwn(manifest, 'devDependencies'), false, 'dev dependencies must not be added')
  const nodeModules = path.join(ROOT, 'node_modules')
  const entries = existsSync(nodeModules) ? readdirSync(nodeModules) : []
  const markers = new Set(['.package-map.json', '.pnpm-workspace-state-v1.json'])
  assert.deepEqual(entries.filter((entry) => !markers.has(entry)), [], 'installed npm packages must not be added')
})

test('CLI-only incremental peak RSS remains within budget', { timeout: 30_000 }, async (t) => {
  let report
  try {
    report = await measureCliRss({ repetitions: 1 })
  } catch (error) {
    // Measuring needs a child process. A sandbox that forbids spawning cannot run
    // the benchmark, and a skip says that instead of reporting a code defect.
    if (error?.code === 'EPERM' || /EPERM/.test(String(error?.message))) {
      t.skip('child processes are blocked in this sandbox; run outside it to measure')
      return
    }
    throw error
  }
  assertRssBudget(report)
  for (const [name, measurement] of Object.entries(report.scenarios)) {
    assert.ok(
      measurement.incrementalPeakRssMiB <= report.budget.ceilingMiB,
      `dsh-cli ${name} used ${measurement.incrementalPeakRssMiB.toFixed(2)} MiB incremental peak RSS (budget ${report.budget.ceilingMiB} MiB)`,
    )
  }
})
