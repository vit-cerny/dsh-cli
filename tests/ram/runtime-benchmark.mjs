import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DEFAULT_RUNTIME_BIN } from '../../src/rpc/client.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PROBE = pathToFileURL(path.join(ROOT, 'tests', 'ram', 'rss-probe.mjs')).href
const RUNTIME_PROBE = pathToFileURL(path.join(ROOT, 'tests', 'ram', 'sdk-runtime-rss-probe.mjs')).href
const SDK_INIT_PROBE = path.join(ROOT, 'tests', 'ram', 'sdk-init-probe.mjs')
const MIB = 1024 * 1024
const IDLE_MS = 1_500
const STARTUP_TIMEOUT_MS = 60_000
const CLOSE_TIMEOUT_MS = 15_000

function platformEnvironment() {
  const keys = process.platform === 'win32'
    ? ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
    : ['PATH', 'TMPDIR']
  return Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
}

function createIsolatedEnv(tempRoot, metricsFile) {
  const home = path.join(tempRoot, 'home')
  const dshHome = path.join(tempRoot, 'dsh-home')
  const appData = path.join(tempRoot, 'appdata')
  const localAppData = path.join(tempRoot, 'local-appdata')
  for (const directory of [home, dshHome, appData, localAppData]) {
    mkdirSync(directory, { recursive: true })
  }
  return {
    ...platformEnvironment(),
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    DSH_HOME: dshHome,
    DSH_CLI_PROFILE: process.env.DSH_CLI_RAM_PROFILE ?? 'sdk',
    DSH_CLI_RUNTIME_BIN: DEFAULT_RUNTIME_BIN,
    DSH_CLI_RAM_IDLE_MS: String(IDLE_MS),
    DSH_CLI_RAM_RUNTIME_TARGET: DEFAULT_RUNTIME_BIN,
    DSH_CLI_RAM_METRICS_FILE: metricsFile,
    NODE_OPTIONS: `--import=${RUNTIME_PROBE}`,
  }
}

function waitForPrefix(child, state, prefix, timeoutMs) {
  const findLine = () => state.stdout.split(/\r?\n/u).find((line) => line.startsWith(prefix))
  const alreadyPresent = findLine()
  if (alreadyPresent !== undefined) return Promise.resolve(alreadyPresent)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`SDK init probe did not emit ${prefix} within ${timeoutMs} ms`))
    }, timeoutMs)
    const onData = () => {
      const line = findLine()
      if (line !== undefined) {
        cleanup()
        resolve(line)
      }
    }
    const onClose = (code, signal) => {
      cleanup()
      reject(new Error(`SDK init probe exited before ${prefix} (${code ?? signal}): ${state.stderr.trim()}`))
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('close', onClose)
      child.off('error', onError)
    }
    child.stdout.on('data', onData)
    child.once('close', onClose)
    child.once('error', onError)
  })
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

function readJson(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function parseCliMetrics(stderr) {
  const marker = '__DSH_CLI_RSS__='
  const line = stderr.split(/\r?\n/u).find((entry) => entry.startsWith(marker))
  if (line === undefined) throw new Error('SDK init harness RSS probe did not report metrics')
  return JSON.parse(line.slice(marker.length))
}

function safeRemoveTempRoot(tempRoot) {
  const target = path.resolve(tempRoot)
  const parent = path.resolve(os.tmpdir())
  if (path.dirname(target) !== parent || !path.basename(target).startsWith('dsh-cli-ram-sdk-')) {
    throw new Error(`refusing to remove unexpected benchmark path: ${target}`)
  }
  rmSync(target, { recursive: true, force: true })
}

/**
 * Initialize the real DSH SDK runtime via SessionDriver with a temporary DSH_HOME.
 * No session prompt is sent; SDK client and runtime RSS are reported separately.
 *
 * @returns {Promise<object>} Separate harness and DSH SDK runtime measurements.
 */
export async function measureOfflineRuntime() {
  if (!existsSync(DEFAULT_RUNTIME_BIN)) {
    return { status: 'unavailable', reason: `DSH runtime not found at ${DEFAULT_RUNTIME_BIN}` }
  }
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-ram-sdk-'))
  const metricsFile = path.join(tempRoot, 'sdk-runtime-rss.json')
  const env = createIsolatedEnv(tempRoot, metricsFile)
  const startedAt = performance.now()
  const child = spawn(process.execPath, ['--import', PROBE, SDK_INIT_PROBE], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const state = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    state.stdout = `${state.stdout}${chunk}`.slice(-64 * 1024)
  })
  child.stderr.on('data', (chunk) => {
    state.stderr = `${state.stderr}${chunk}`.slice(-64 * 1024)
  })
  const closed = waitForClose(child)
  try {
    await waitForPrefix(child, state, 'SDK_READY', STARTUP_TIMEOUT_MS)
    const idleLine = await waitForPrefix(child, state, 'SDK_IDLE=', STARTUP_TIMEOUT_MS)
    const idleMetrics = JSON.parse(idleLine.slice('SDK_IDLE='.length))
    const closeResult = await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), CLOSE_TIMEOUT_MS)),
    ])
    if (closeResult.timeout === true) {
      child.kill()
      throw new Error(`SDK init harness did not close within ${CLOSE_TIMEOUT_MS} ms`)
    }
    if (closeResult.code !== 0) {
      throw new Error(`SDK init harness exited with ${closeResult.code ?? closeResult.signal}: ${state.stderr.trim()}`)
    }
    const finalRuntimeMetrics = readJson(metricsFile)
    if (finalRuntimeMetrics === null) throw new Error('SDK runtime process did not report RSS metrics')
    const harnessMetrics = parseCliMetrics(state.stderr)
    return {
      status: 'measured',
      mode: 'SDK initialize + idle; no prompt or turn submitted',
      measuredAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      runtimeBin: DEFAULT_RUNTIME_BIN,
      isolation: 'temporary DSH_HOME, HOME/USERPROFILE, APPDATA, and LOCALAPPDATA; no user profile or credential files inherited',
      promptSubmitted: false,
      startupToSdkReadyMs: Math.round(performance.now() - startedAt),
      idleWindowMs: IDLE_MS,
      sdkClientHarnessProcess: {
        osPeakRssMiB: harnessMetrics.osPeakBytes / MIB,
        sampledPeakRssMiB: harnessMetrics.sampledPeakBytes / MIB,
      },
      sdkRuntimeProcess: {
        idleSampleRssMiB: idleMetrics.currentRssBytes / MIB,
        idleSampleAgeMs: Math.max(0, Date.now() - idleMetrics.sampledAt),
        osPeakRssMiB: finalRuntimeMetrics.osPeakBytes / MIB,
        sampledPeakRssMiB: finalRuntimeMetrics.sampledPeakBytes / MIB,
        idleSampleCount: idleMetrics.sampleCount,
      },
      totalAgentRssClaimed: false,
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))])
    }
    const message = error instanceof Error ? error.message : String(error)
    const detail = state.stderr.trim()
    throw new Error(detail === '' ? message : `${message}\n${detail}`)
  } finally {
    safeRemoveTempRoot(tempRoot)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await measureOfflineRuntime(), null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`SDK RSS benchmark failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
