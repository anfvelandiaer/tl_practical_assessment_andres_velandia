// ─── Errors ────────────────────────────────────────────────────────────────

export class TimeoutError extends Error {
  readonly name = 'TimeoutError'
  constructor(public readonly timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms`)
  }
}

export class CircuitOpenError extends Error {
  readonly name = 'CircuitOpenError'
  readonly state = 'OPEN' as const
  constructor() {
    super('Circuit breaker is OPEN — request rejected without attempting')
  }
}

export class MaxRetriesError extends Error {
  readonly name = 'MaxRetriesError'
  constructor(
    public readonly attempts: number,
    public readonly originalError: Error
  ) {
    super(`Failed after ${attempts} attempts. Last error: ${originalError.message}`)
  }
}

// ─── Configuration ──────────────────────────────────────────────────────────

export type JitterStrategy = 'full' | 'equal' | 'none'
export type CircuitState   = 'CLOSED' | 'OPEN' | 'HALF_OPEN'
export type LogLevel       = 'debug' | 'info' | 'warn' | 'error'

export interface TimeoutConfig {
  defaultMs: number
}

export interface RetryConfig {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs:  number
  jitter:      JitterStrategy
  retryOn?:    (error: Error) => boolean
}

export interface CircuitBreakerConfig {
  failureThreshold: number
  successThreshold: number
  openTimeoutMs:    number
}

export interface IdempotencyConfig {
  enabled: boolean
  ttlMs:   number
}

export interface LoggingConfig {
  level:          LogLevel
  exportToFile?:  string
}

export interface TelemetryConfig {
  serviceName: string
  enabled:     boolean
}

export interface ResilienceConfig {
  timeout:        TimeoutConfig
  retry:          RetryConfig
  circuitBreaker: CircuitBreakerConfig
  idempotency:    IdempotencyConfig
  logging:        LoggingConfig
  telemetry:      TelemetryConfig
}

// ─── Idempotency store interface (extensible) ───────────────────────────────

export interface IdempotencyStore {
  getOrCreate<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>
}

// ─── Execute options ────────────────────────────────────────────────────────

export interface ExecuteOptions {
  idempotencyKey?:     string
  timeout?:            number
  operationName?:      string
  skipCircuitBreaker?: boolean
}

// ─── Trace context ──────────────────────────────────────────────────────────

export interface TraceContext {
  traceId: string
  spanId:  string
}

// ─── Log entry ──────────────────────────────────────────────────────────────

export type LogEvent =
  | 'attempt'
  | 'success'
  | 'failure'
  | 'retry'
  | 'timeout'
  | 'circuit_open'
  | 'idempotent_hit'

export interface LogEntry {
  timestamp:     string
  level:         LogLevel
  traceId:       string
  spanId:        string
  operationName: string
  event:         LogEvent
  attempt?:      number
  delayMs?:      number
  durationMs?:   number
  error?:        string
}
