import process from 'node:process'
import { SessionDriver } from '../../src/session/driver.js'

const idleMs = Number(process.env.DSH_CLI_RAM_IDLE_MS ?? 1_500)
let driver
try {
  driver = await SessionDriver.open({
    cwd: process.cwd(),
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    runtimeCommand: process.env.DSH_CLI_RAM_RUNTIME_BIN,
    runtimeArgs: ['--profile', 'sdk'],
  })
  process.stdout.write('SDK_READY\n')
  await new Promise((resolve) => setTimeout(resolve, idleMs))
  const metricsFile = process.env.DSH_CLI_RAM_METRICS_FILE
  const { readFileSync } = await import('node:fs')
  const idleMetrics = JSON.parse(readFileSync(metricsFile, 'utf8'))
  process.stdout.write(`SDK_IDLE=${JSON.stringify(idleMetrics)}\n`)
  await driver.close()
  process.stdout.write('SDK_CLOSED\n')
} catch (error) {
  try {
    await driver?.close()
  } catch {
    /* Preserve the initialization failure. */
  }
  process.stderr.write(`SDK init probe failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
