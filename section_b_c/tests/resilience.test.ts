import { createClient } from '../src/index'
import { CircuitBreaker } from '../src/circuit-breaker'
import { InMemoryIdempotencyStore } from '../src/idempotency'
import { computeDelay } from '../src/backoff'
import {
  CircuitOpenError,
  MaxRetriesError,
  ResilienceConfig,
  TimeoutError,
} from '../src/types'

function makeConfig(overrides: Partial<ResilienceConfig> = {}): ResilienceConfig {
  return {
    timeout:        { defaultMs: 1000 },
    retry:          { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: 'none' },
    circuitBreaker: { failureThreshold: 3, successThreshold: 2, openTimeoutMs: 5000 },
    idempotency:    { enabled: true, ttlMs: 5000 },
    logging:        { level: 'error' },
    telemetry:      { serviceName: 'test', enabled: false },
    ...overrides,
  }
}

// ─── Timeout ──────────────────────────────────────────────────────────────────

describe('Timeout', () => {
  it('resolves if fn() finishes before the timeout', async () => {
    const client = createClient(makeConfig())
    await expect(client.execute(() => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('rejects when fn() hangs past the timeout — originalError is TimeoutError', async () => {
    jest.useFakeTimers()
    const client = createClient(makeConfig({
      retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100, jitter: 'none' },
      idempotency: { enabled: false, ttlMs: 0 },
    }))
    const fn = () => new Promise<string>(resolve => setTimeout(() => resolve('late'), 5000))

    let caught: unknown
    const p = client.execute(fn, { timeout: 500 }).catch(e => { caught = e })
    await jest.advanceTimersByTimeAsync(600)
    await p

    expect(caught).toBeInstanceOf(MaxRetriesError)
    expect((caught as MaxRetriesError).originalError).toBeInstanceOf(TimeoutError)
    jest.useRealTimers()
  })

  it('per-call timeout overrides global config', async () => {
    jest.useFakeTimers()
    const client = createClient(makeConfig({
      timeout: { defaultMs: 5000 },
      retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100, jitter: 'none' },
      idempotency: { enabled: false, ttlMs: 0 },
    }))
    const fn = () => new Promise<string>(resolve => setTimeout(() => resolve('late'), 3000))

    let caught: unknown
    const p = client.execute(fn, { timeout: 200 }).catch(e => { caught = e })
    await jest.advanceTimersByTimeAsync(300)
    await p

    expect(caught).toBeInstanceOf(MaxRetriesError)
    expect((caught as MaxRetriesError).originalError).toBeInstanceOf(TimeoutError)
    jest.useRealTimers()
  })
})

// ─── Backoff ──────────────────────────────────────────────────────────────────

describe('Backoff — computeDelay()', () => {
  it('grows exponentially with jitter=none', () => {
    expect(computeDelay(0, 100, 10000, 'none')).toBe(100)
    expect(computeDelay(1, 100, 10000, 'none')).toBe(200)
    expect(computeDelay(2, 100, 10000, 'none')).toBe(400)
  })

  it('never exceeds maxDelayMs', () => {
    for (let i = 0; i < 20; i++) {
      expect(computeDelay(i, 1000, 2000, 'none')).toBeLessThanOrEqual(2000)
      expect(computeDelay(i, 1000, 2000, 'full')).toBeLessThanOrEqual(2000)
      expect(computeDelay(i, 1000, 2000, 'equal')).toBeLessThanOrEqual(2000)
    }
  })

  it('full jitter produces values in [0, cap]', () => {
    for (let i = 0; i < 50; i++) {
      const d = computeDelay(1, 100, 10000, 'full')
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(200)
    }
  })

  it('equal jitter produces values in [cap/2, cap]', () => {
    for (let i = 0; i < 50; i++) {
      const d = computeDelay(1, 100, 10000, 'equal')
      expect(d).toBeGreaterThanOrEqual(100)
      expect(d).toBeLessThanOrEqual(200)
    }
  })
})

// ─── Retry ────────────────────────────────────────────────────────────────────

describe('Retry', () => {
  it('does not retry on first-attempt success', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    const client = createClient(makeConfig({ idempotency: { enabled: false, ttlMs: 0 } }))
    await client.execute(fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries up to maxAttempts then throws MaxRetriesError', async () => {
    jest.useFakeTimers()
    const fn = jest.fn().mockRejectedValue(new Error('fail'))
    const client = createClient(makeConfig({
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: 'none' },
      idempotency: { enabled: false, ttlMs: 0 },
    }))
    let caught: unknown
    const p = client.execute(fn).catch(e => { caught = e })
    await jest.runAllTimersAsync()
    await p
    expect(caught).toBeInstanceOf(MaxRetriesError)
    expect(fn).toHaveBeenCalledTimes(3)
    jest.useRealTimers()
  })

  it('MaxRetriesError carries attempts count and originalError', async () => {
    jest.useFakeTimers()
    const original = new Error('root cause')
    const fn = jest.fn().mockRejectedValue(original)
    const client = createClient(makeConfig({
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, jitter: 'none' },
      idempotency: { enabled: false, ttlMs: 0 },
    }))
    let caught: unknown
    const p = client.execute(fn).catch(e => { caught = e })
    await jest.runAllTimersAsync()
    await p
    expect(caught).toBeInstanceOf(MaxRetriesError)
    expect((caught as MaxRetriesError).attempts).toBe(2)
    expect((caught as MaxRetriesError).originalError).toBe(original)
    jest.useRealTimers()
  })

  it('succeeds on retry after transient failures', async () => {
    jest.useFakeTimers()
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('flap'))
      .mockRejectedValueOnce(new Error('flap'))
      .mockResolvedValue('recovered')
    const client = createClient(makeConfig({
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: 'none' },
      idempotency: { enabled: false, ttlMs: 0 },
    }))
    const p = client.execute(fn)
    await jest.runAllTimersAsync()
    await expect(p).resolves.toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
    jest.useRealTimers()
  })

  it('respects retryOn predicate — does not retry when predicate returns false', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('unretriable'))
    const client = createClient(makeConfig({
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: 'none', retryOn: () => false },
      idempotency: { enabled: false, ttlMs: 0 },
    }))
    let caught: unknown
    await client.execute(fn).catch(e => { caught = e })
    expect(caught).toBeInstanceOf(MaxRetriesError)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

// ─── Circuit breaker ──────────────────────────────────────────────────────────

describe('Circuit breaker', () => {
  it('starts CLOSED', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, successThreshold: 2, openTimeoutMs: 5000 })
    expect(cb.state).toBe('CLOSED')
  })

  it('opens after failureThreshold consecutive failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, successThreshold: 2, openTimeoutMs: 5000 })
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure()
    expect(cb.state).toBe('OPEN')
  })

  it('throws CircuitOpenError when OPEN — fn() is never called', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    const client = createClient(makeConfig({
      circuitBreaker: { failureThreshold: 1, successThreshold: 2, openTimeoutMs: 10000 },
      retry:          { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100, jitter: 'none' },
      idempotency:    { enabled: false, ttlMs: 0 },
    }))
    await client.execute(() => Promise.reject(new Error('x'))).catch(() => {})
    fn.mockClear()
    let caught: unknown
    await client.execute(fn).catch(e => { caught = e })
    expect(caught).toBeInstanceOf(CircuitOpenError)
    expect(fn).not.toHaveBeenCalled()
  })

  it('transitions to HALF_OPEN after openTimeoutMs', () => {
    jest.useFakeTimers()
    const cb = new CircuitBreaker({ failureThreshold: 1, successThreshold: 2, openTimeoutMs: 5000 })
    cb.recordFailure()
    expect(cb.state).toBe('OPEN')
    jest.advanceTimersByTime(5001)
    expect(cb.state).toBe('HALF_OPEN')
    jest.useRealTimers()
  })

  it('closes from HALF_OPEN after successThreshold successes', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, successThreshold: 2, openTimeoutMs: 5000 })
    cb.forceState('HALF_OPEN')
    cb.recordSuccess()
    expect(cb.state).toBe('HALF_OPEN')
    cb.recordSuccess()
    expect(cb.state).toBe('CLOSED')
  })

  it('goes back to OPEN from HALF_OPEN on any failure', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, successThreshold: 2, openTimeoutMs: 5000 })
    cb.forceState('HALF_OPEN')
    cb.recordFailure()
    expect(cb.state).toBe('OPEN')
  })

  it('resets failure count on success in CLOSED state', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, successThreshold: 2, openTimeoutMs: 5000 })
    cb.recordFailure(); cb.recordFailure()
    cb.recordSuccess()
    cb.recordFailure()
    expect(cb.state).toBe('CLOSED')
  })
})

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe('Idempotency', () => {
  let store: InMemoryIdempotencyStore
  beforeEach(() => { store = new InMemoryIdempotencyStore() })
  afterEach(() => { store.clear() })

  it('executes fn() once for two concurrent calls with the same key', async () => {
    const fn = jest.fn().mockResolvedValue('result')
    const [r1, r2] = await Promise.all([
      store.getOrCreate('key-1', 5000, fn),
      store.getOrCreate('key-1', 5000, fn),
    ])
    expect(fn).toHaveBeenCalledTimes(1)
    expect(r1).toBe('result')
    expect(r2).toBe('result')
  })

  it('both calls receive the same error when fn() fails', async () => {
    const error = new Error('shared failure')
    const fn = jest.fn().mockRejectedValue(error)
    const errors: unknown[] = []
    await Promise.all([
      store.getOrCreate('err-key', 5000, fn).catch(e => errors.push(e)),
      store.getOrCreate('err-key', 5000, fn).catch(e => errors.push(e)),
    ])
    expect(errors[0]).toBe(error)
    expect(errors[1]).toBe(error)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('executes fn() again after TTL expires', async () => {
    jest.useFakeTimers()
    const fn = jest.fn().mockResolvedValue('ok')
    await store.getOrCreate('ttl-key', 100, fn)
    jest.advanceTimersByTime(101)
    await store.getOrCreate('ttl-key', 100, fn)
    expect(fn).toHaveBeenCalledTimes(2)
    jest.useRealTimers()
  })

  it('auto-generated keys produce independent executions', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    const client = createClient(makeConfig())
    await Promise.all([client.execute(fn), client.execute(fn)])
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

// ─── Integration ──────────────────────────────────────────────────────────────

describe('Integration pipeline', () => {
  it('handles a flaky service that fails twice then succeeds', async () => {
    jest.useFakeTimers()
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue({ data: 'ok' })
    const client = createClient(makeConfig({
      retry:       { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: 'none' },
      idempotency: { enabled: false, ttlMs: 0 },
    }))
    const p = client.execute(fn, { operationName: 'flaky-service' })
    await jest.runAllTimersAsync()
    await expect(p).resolves.toEqual({ data: 'ok' })
    expect(fn).toHaveBeenCalledTimes(3)
    jest.useRealTimers()
  })

  it('full circuit breaker lifecycle: open → half-open → closed', async () => {
    jest.useFakeTimers()
    const client = createClient(makeConfig({
      circuitBreaker: { failureThreshold: 2, successThreshold: 2, openTimeoutMs: 5000 },
      retry:          { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100, jitter: 'none' },
      idempotency:    { enabled: false, ttlMs: 0 },
    }))
    const failFn = jest.fn().mockRejectedValue(new Error('down'))

    await client.execute(failFn).catch(() => {})
    await client.execute(failFn).catch(() => {})
    let circuitErr: unknown
    await client.execute(failFn).catch(e => { circuitErr = e })
    expect(circuitErr).toBeInstanceOf(CircuitOpenError)

    jest.advanceTimersByTime(5001)

    const recoverFn = jest.fn().mockResolvedValue('ok')
    await client.execute(recoverFn)
    await client.execute(recoverFn)
    await expect(client.execute(recoverFn)).resolves.toBe('ok')
    jest.useRealTimers()
  })

  it('traceId is consistent across all retry attempts in a single execute()', async () => {
    jest.useFakeTimers()
    const logs: Array<{ traceId: string; event: string }> = []
    jest.spyOn(console, 'log').mockImplementation(msg => logs.push(JSON.parse(msg as string)))

    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValue('ok')

    const client = createClient(makeConfig({
      retry:       { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: 'none' },
      idempotency: { enabled: false, ttlMs: 0 },
      telemetry:   { serviceName: 'test', enabled: true },
      logging:     { level: 'debug' },
    }))

    const p = client.execute(fn, { operationName: 'trace-test' })
    await jest.runAllTimersAsync()
    await p

    const traceIds = new Set(logs.map(l => l.traceId))
    expect(traceIds.size).toBe(1)

    jest.restoreAllMocks()
    jest.useRealTimers()
  })
})
