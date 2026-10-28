import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const INCREMENTAL_RSS_BUDGET_MIB = 64
export const DEFAULT_REPETITIONS = 3
const MIB = 1024 * 1024
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ENTRY = path.join(ROOT, 'src', 'main.js')
const PROBE = pathToFileURL(path.join(ROOT, 'tests', 'ram', 'rss-probe.mjs')).href
const MARKER = '__DSH_CLI_RSS__='
const CHILD_TIMEOUT_MS = 15_000

function benchmarkEnvironment() {
  const allowed = process.platform === 'win32'
    ? ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
    : ['PATH', 'TMPDIR']
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function parseMetrics(stderr, label) {
  const line = stderr.split(/\r?\n/u).find((entry) => entry.startsWith(MARKER))
  if (line === undefined) throw new Error(`RSS probe did not report metrics for ${label}`)
  try {
    return JSON.parse(line.slice(MARKER.length))
  } catch {
    throw new Error(`RSS probe reported invalid metrics for ${label}`)
  }
}

function runProcess(args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', PROBE, ...args], {
      cwd: ROOT,
      // Do not inherit DSH_PROFILE, DSH_HOME, API keys, or other user config.
      env: benchmarkEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, CHILD_TIMEOUT_MS)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      // Keep diagnostics bounded if a broken command loops or floods stderr.
      stderr = `${stderr}${chunk}`.slice(-64 * 1024)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`could not spawn ${label}: ${error.message}`))
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${label} exceeded the ${CHILD_TIMEOUT_MS} ms measurement timeout`))
        return
      }
      if (code !== 0) {
        const diagnostic = stderr.split(/\r?\n/u).filter((line) => !line.startsWith(MARKER)).join('\n').trim()
        reject(new Error(`${label} exited with ${code ?? signal}: ${diagnostic}`))
        return
      }
      try {
        resolve(parseMetrics(stderr, label))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function summarize(samples, baselinePeakBytes) {
  const peakBytes = median(samples.map((sample) => sample.osPeakBytes))
  const sampledPeakBytes = median(samples.map((sample) => sample.sampledPeakBytes))
  return {
    peakRssMiB: peakBytes / MIB,
    sampledPeakRssMiB: sampledPeakBytes / MIB,
    incrementalPeakRssMiB: Math.max(0, peakBytes - baselinePeakBytes) / MIB,
    repetitions: samples.length,
  }
}

/**
 * Measure CLI-only process RSS for help/version commands that do not read DSH
 * profiles or boot the SDK runtime. The empty Node baseline uses the same RSS probe.
 *
 * @param {{ repetitions?: number }} [options]
 * @returns {Promise<object>} Median RSS evidence for help and version.
 */
export async function measureCliRss({ repetitions = DEFAULT_REPETITIONS } = {}) {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 9) {
    throw new TypeError('repetitions must be an integer between 1 and 9')
  }
  if (process.resourceUsage === undefined || process.memoryUsage?.().rss === undefined) {
    throw new Error('this Node build does not expose process RSS metrics')
  }

  const baselineSamples = []
  for (let index = 0; index < repetitions; index += 1) {
    baselineSamples.push(await runProcess(['--eval', ''], 'empty Node baseline'))
  }
  const baselinePeakBytes = median(baselineSamples.map((sample) => sample.osPeakBytes))
  const scenarios = {}
  for (const [name, args] of [
    ['help', [ENTRY, '--help']],
    ['version', [ENTRY, '--version']],
  ]) {
    const samples = []
    for (let index = 0; index < repetitions; index += 1) {
      samples.push(await runProcess(args, `dsh-cli ${name}`))
    }
    scenarios[name] = summarize(samples, baselinePeakBytes)
  }

  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const hasDependencySections =
    Object.hasOwn(packageJson, 'dependencies') || Object.hasOwn(packageJson, 'devDependencies')
  const nodeModulesPath = path.join(ROOT, 'node_modules')
  const nodeModulesEntries = existsSync(nodeModulesPath) ? readdirSync(nodeModulesPath) : []
  const packageManagerMarkers = new Set(['.package-map.json', '.pnpm-workspace-state-v1.json'])
  const installedPackageEntries = nodeModulesEntries.filter((entry) => !packageManagerMarkers.has(entry))
  return {
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    repetitions,
    baselinePeakRssMiB: baselinePeakBytes / MIB,
    budget: {
      component: 'incremental RSS of the dsh-cli Node process for --help and --version (no DSH profile or runtime child)',
      ceilingMiB: INCREMENTAL_RSS_BUDGET_MIB,
    },
    scenarios,
    dependencyCheck: {
      dependencySections: hasDependencySections,
      installedPackageEntries,
      packageManagerMetadataOnly: nodeModulesEntries.length > 0 && installedPackageEntries.length === 0,
    },
  }
}

export function assertRssBudget(report) {
  for (const [name, measurement] of Object.entries(report.scenarios)) {
    if (measurement.incrementalPeakRssMiB > INCREMENTAL_RSS_BUDGET_MIB) {
      throw new Error(
        `dsh-cli ${name} incremental peak RSS ${measurement.incrementalPeakRssMiB.toFixed(2)} MiB exceeds ${INCREMENTAL_RSS_BUDGET_MIB} MiB`,
      )
    }
  }
  if (report.dependencyCheck.dependencySections || report.dependencyCheck.installedPackageEntries.length > 0) {
    throw new Error('dsh-cli must not declare or install npm dependencies')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const report = await measureCliRss()
    assertRssBudget(report)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`RAM benchmark failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
