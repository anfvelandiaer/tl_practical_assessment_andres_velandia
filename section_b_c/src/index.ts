import { randomUUID } from 'crypto'
import { CircuitBreaker }           from './circuit-breaker'
import { InMemoryIdempotencyStore } from './idempotency'
import { Logger, generateSpanId, generateTraceId } from './logger'
import { computeDelay, sleep }      from './backoff'
import { withTimeout }              from './timeout'
import {
  CircuitOpenError,
  ExecuteOptions,
  IdempotencyStore,
  MaxRetriesError,
  ResilienceConfig,
  TimeoutError,
} from './types'

// ─── Public surface ─────────────────────────────────────────────────────────

export interface ResilienceClient {
  /**
   * Execute any async function with the full resilience pipeline applied:
   * idempotency → timeout → circuit breaker → retry with backoff/jitter
   *
   * The function receives an optional AbortSignal so it can cancel
   * in-flight work (e.g. an HTTP request) when a timeout fires.
   */
  execute<T>(fn: (signal?: AbortSignal) => Promise<T>, options?: ExecuteOptions): Promise<T>
}

export function createClient(
  config: ResilienceConfig,
  // Injectable store — swap InMemoryIdempotencyStore for Redis/DynamoDB in production
  idempotencyStore: IdempotencyStore = new InMemoryIdempotencyStore()
): ResilienceClient {
  const breaker = new CircuitBreaker(config.circuitBreaker)
  const logger  = new Logger(config.logging, config.telemetry)

  return {
    execute<T>(fn: (signal?: AbortSignal) => Promise<T>, options: ExecuteOptions = {}): Promise<T> {
      const operationName = options.operationName ?? 'unknown'
      const timeoutMs     = options.timeout ?? config.timeout.defaultMs
      const idempKey      = options.idempotencyKey ?? randomUUID()

      // ── Idempotency gate ──────────────────────────────────────────────────
      // Wraps the entire pipeline so concurrent calls with the same key
      // share a single execution, not just a single fn() call.
      if (config.idempotency.enabled) {
        const traceId = generateTraceId()
        const spanId  = generateSpanId()
        let isNewExecution = false

        const result = idempotencyStore.getOrCreate(
          idempKey,
          config.idempotency.ttlMs,
          () => {
            isNewExecution = true
            return runPipeline(fn, { operationName, timeoutMs, options })
          }
        )

        if (!isNewExecution) {
          logger.log('debug', 'idempotent_hit', { traceId, spanId, operationName })
        }

        return result
      }

      return runPipeline(fn, { operationName, timeoutMs, options })
    }
  }

  // ── Execution pipeline ────────────────────────────────────────────────────

  async function runPipeline<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    ctx: { operationName: string; timeoutMs: number; options: ExecuteOptions }
  ): Promise<T> {
    const { operationName, timeoutMs, options } = ctx
    const traceId = generateTraceId()
    const rootSpan = generateSpanId()

    const { maxAttempts, baseDelayMs, maxDelayMs, jitter, retryOn } = config.retry
    let lastError: Error = new Error('unknown')

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const spanId = attempt === 0 ? rootSpan : generateSpanId()
      const start  = Date.now()

      // ── Circuit breaker guard ─────────────────────────────────────────────
      if (!options.skipCircuitBreaker) {
        try {
          breaker.guard()
        } catch (err) {
          logger.log('warn', 'circuit_open', { traceId, spanId, operationName, attempt })
          throw err
        }
      }

      logger.log('debug', 'attempt', { traceId, spanId, operationName, attempt: attempt + 1 })

      // ── Execute with timeout ──────────────────────────────────────────────
      try {
        const result = await withTimeout(fn, timeoutMs)
        const durationMs = Date.now() - start

        breaker.recordSuccess()
        logger.log('info', 'success', { traceId, spanId, operationName, attempt: attempt + 1, durationMs })

        return result

      } catch (err) {
        const error      = err instanceof Error ? err : new Error(String(err))
        const durationMs = Date.now() - start

        // Timeouts count as failures but don't retry (already retrying would overlap)
        if (error instanceof TimeoutError) {
          breaker.recordFailure()
          logger.log('warn', 'timeout', { traceId, spanId, operationName, attempt: attempt + 1, durationMs, error })
          lastError = error
          // Fall through to retry logic below
        } else if (error instanceof CircuitOpenError) {
          // Circuit was open — propagate immediately, do not retry
          throw error
        } else {
          breaker.recordFailure()
          logger.log('warn', 'failure', { traceId, spanId, operationName, attempt: attempt + 1, durationMs, error })
          lastError = error
        }

        // ── Should we retry? ────────────────────────────────────────────────
        const isLastAttempt = attempt === maxAttempts - 1
        const shouldRetry   = retryOn ? retryOn(error) : true

        if (isLastAttempt || !shouldRetry) {
          logger.log('error', 'failure', { traceId, spanId, operationName, attempt: attempt + 1, error })
          throw new MaxRetriesError(attempt + 1, lastError)
        }

        // ── Compute delay and wait ──────────────────────────────────────────
        const delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs, jitter)
        logger.log('debug', 'retry', { traceId, spanId, operationName, attempt: attempt + 1, delayMs })
        await sleep(delayMs)
      }
    }

    // Unreachable — TypeScript needs this
    throw new MaxRetriesError(maxAttempts, lastError)
  }
}
