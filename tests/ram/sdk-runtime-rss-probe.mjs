import { writeFileSync } from 'node:fs'

const target = process.env.DSH_CLI_RAM_RUNTIME_TARGET
const script = process.argv[1]
const metricsFile = process.env.DSH_CLI_RAM_METRICS_FILE
const normalize = (value) => String(value ?? '').replaceAll('\\', '/').toLowerCase()

if (target && script && metricsFile && normalize(script) === normalize(target)) {
  const startedAt = Date.now()
  const startedRssBytes = process.memoryUsage().rss
  let sampledPeakBytes = startedRssBytes
  let sampleCount = 0
  const writeMetrics = () => {
    const currentRssBytes = process.memoryUsage().rss
    sampledPeakBytes = Math.max(sampledPeakBytes, currentRssBytes)
    sampleCount += 1
    try {
      writeFileSync(metricsFile, JSON.stringify({
        pid: process.pid,
        startedAt,
        sampledAt: Date.now(),
        startedRssBytes,
        currentRssBytes,
        sampledPeakBytes,
        osPeakBytes: process.resourceUsage().maxRSS * 1024,
        sampleCount,
      }))
    } catch {
      // Measurement diagnostics must never interfere with the runtime itself.
    }
  }
  const timer = setInterval(writeMetrics, 200)
  timer.unref()
  process.once('exit', () => {
    clearInterval(timer)
    writeMetrics()
  })
}
