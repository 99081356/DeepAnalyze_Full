/**
 * Startup profiling utility for measuring and reporting time spent in various
 * initialization phases.
 *
 * Enable by setting DA_PROFILE_STARTUP=1 for a detailed report with memory snapshots.
 *
 * Uses Node.js built-in performance hooks API for standard timing measurement.
 */

import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { formatMs, formatTimelineLine, getPerformance } from './profilerBase.ts'

// Module-level state - decided once at module load
const DETAILED_PROFILING = process.env.DA_PROFILE_STARTUP === '1'

// Track memory snapshots separately (perf_hooks doesn't track memory).
// Only used when DETAILED_PROFILING is enabled.
// Stored as an array that appends in the same order as perf.mark() calls, so
// memorySnapshots[i] corresponds to getEntriesByType('mark')[i]. Using a Map
// keyed by checkpoint name is wrong because some checkpoints fire more than
// once (e.g. loadSettingsFromDisk_start fires during init and again after
// plugins reset the settings cache), and the second call would overwrite the
// first's memory snapshot.
const memorySnapshots: NodeJS.MemoryUsage[] = []

// Record initial checkpoint if profiling is enabled
if (DETAILED_PROFILING) {
  profileCheckpoint('profiler_initialized')
}

/**
 * Record a checkpoint with the given name
 */
export function profileCheckpoint(name: string): void {
  if (!DETAILED_PROFILING) return

  const perf = getPerformance()
  perf.mark(name)

  // Capture memory when detailed profiling enabled
  memorySnapshots.push(process.memoryUsage())
}

/**
 * Get a formatted report of all checkpoints
 * Only available when DETAILED_PROFILING is enabled
 */
function getReport(): string {
  if (!DETAILED_PROFILING) {
    return 'Startup profiling not enabled'
  }

  const perf = getPerformance()
  const marks = perf.getEntriesByType('mark')
  if (marks.length === 0) {
    return 'No profiling checkpoints recorded'
  }

  const lines: string[] = []
  lines.push('='.repeat(80))
  lines.push('STARTUP PROFILING REPORT')
  lines.push('='.repeat(80))
  lines.push('')

  let prevTime = 0
  for (const [i, mark] of marks.entries()) {
    lines.push(
      formatTimelineLine(
        mark.startTime,
        mark.startTime - prevTime,
        mark.name,
        memorySnapshots[i],
        8,
        7,
      ),
    )
    prevTime = mark.startTime
  }

  const lastMark = marks[marks.length - 1]
  lines.push('')
  lines.push(`Total startup time: ${formatMs(lastMark?.startTime ?? 0)}ms`)
  lines.push('='.repeat(80))

  return lines.join('\n')
}

let reported = false

/**
 * Output the startup profile report. Logs to console and optionally writes to file
 * if DA_PROFILE_STARTUP=1 is set.
 */
export function profileReport(): void {
  if (reported) return
  reported = true

  // Output detailed report if DA_PROFILE_STARTUP=1
  if (DETAILED_PROFILING) {
    const report = getReport()

    // Write to file
    const path = getStartupPerfLogPath()
    const dir = dirname(path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(path, report, { encoding: 'utf8' })

    console.log(report)
  }
}

export function isDetailedProfilingEnabled(): boolean {
  return DETAILED_PROFILING
}

/**
 * Get the path where the startup performance log will be written.
 * Uses the current working directory under a .da-perf subdirectory.
 */
export function getStartupPerfLogPath(): string {
  return join(process.cwd(), '.da-perf', `startup-${Date.now()}.txt`)
}
