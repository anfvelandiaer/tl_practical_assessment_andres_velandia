import * as fs from 'fs'
import { LogEntry, LogEvent, LoggingConfig, LogLevel, TelemetryConfig } from './types'

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3
}

// Generates a 16-char hex id — compatible with OTel trace/span id format
function hexId(bytes: number): string {
  return [...Array(bytes)].map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('')
}

export function generateTraceId(): string { return hexId(16) } // 128-bit
export function generateSpanId():  string { return hexId(8)  } // 64-bit

export class Logger {
  private readonly minLevel: number
  private readonly fileStream?: fs.WriteStream

  constructor(
    private readonly loggingConfig: LoggingConfig,
    private readonly telemetryConfig: TelemetryConfig
  ) {
    this.minLevel = LOG_LEVEL_RANK[loggingConfig.level]

    if (loggingConfig.exportToFile) {
      this.fileStream = fs.createWriteStream(loggingConfig.exportToFile, { flags: 'a' })
    }
  }

  log(
    level: LogLevel,
    event: LogEvent,
    context: {
      traceId:       string
      spanId:        string
      operationName: string
      attempt?:      number
      delayMs?:      number
      durationMs?:   number
      error?:        Error
    }
  ): void {
    if (LOG_LEVEL_RANK[level] < this.minLevel) return

    const entry: LogEntry = {
      timestamp:     new Date().toISOString(),
      level,
      traceId:       context.traceId,
      spanId:        context.spanId,
      operationName: context.operationName,
      event,
      ...(context.attempt   !== undefined && { attempt:    context.attempt   }),
      ...(context.delayMs   !== undefined && { delayMs:    context.delayMs   }),
      ...(context.durationMs !== undefined && { durationMs: context.durationMs }),
      ...(context.error     !== undefined && { error:      context.error.message })
    }

    const line = JSON.stringify(entry)
    console.log(line)
    this.fileStream?.write(line + '\n')
  }

  close(): void {
    this.fileStream?.end()
  }
}
