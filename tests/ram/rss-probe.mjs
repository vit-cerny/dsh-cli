import { writeSync } from 'node:fs'

const MARKER = '__DSH_CLI_RSS__='
const startedAtBytes = process.memoryUsage().rss
let sampledPeakBytes = startedAtBytes
const sampleTimer = setInterval(() => {
  sampledPeakBytes = Math.max(sampledPeakBytes, process.memoryUsage().rss)
}, 20)
sampleTimer.unref()

process.once('exit', () => {
  sampledPeakBytes = Math.max(sampledPeakBytes, process.memoryUsage().rss)
  const maxRssKiB = process.resourceUsage().maxRSS
  writeSync(2, `${MARKER}${JSON.stringify({
    startedAtBytes,
    sampledPeakBytes,
    osPeakBytes: maxRssKiB * 1024,
  })}\n`)
})
