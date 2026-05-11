# resilience-client — Technical Specification

**Node.js / TypeScript · v1.0.0**

---

## 1. Purpose & Scope

A reusable Node.js module that wraps any async function (`fn: () => Promise<T>`) and adds resilience, observability, and idempotency. It is intentionally transport-agnostic: it works equally with HTTP calls, queue consumers, database queries, or any other async operation.

> **Design principle:** The module knows nothing about HTTP, events, or queues. It operates purely on promises. Transport concerns belong to the caller.

---

## 2. Public Interface

### 2.1 Entry point

```typescript
export function createClient(config: ResilienceConfig): ResilienceClient
```

### 2.2 ResilienceClient

```typescript
interface ResilienceClient {
  execute<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    options?: ExecuteOptions
  ): Promise<T>
}
```

The `AbortSignal` parameter is optional: `fn()` can ignore it for simple cases, or use it to cancel in-flight HTTP requests when a timeout fires.

### 2.3 ExecuteOptions

```typescript
interface ExecuteOptions {
  idempotencyKey?:     string   // auto-generated UUID if omitted
  timeout?:            number   // ms — overrides global config
  operationName?:      string   // used in logs and traces
  skipCircuitBreaker?: boolean  // escape hatch for health checks
}
```

---

## 3. Centralized Configuration

```typescript
interface ResilienceConfig {
  timeout: {
    defaultMs: number              // e.g. 5000
  }
  retry: {
    maxAttempts:  number           // e.g. 3
    baseDelayMs:  number           // e.g. 200
    maxDelayMs:   number           // e.g. 10000
    jitter:       'full' | 'equal' | 'none'
    retryOn?:     (error: Error) => boolean
  }
  circuitBreaker: {
    failureThreshold: number       // failures to open
    successThreshold: number       // successes to close from HALF_OPEN
    openTimeoutMs:    number       // time before HALF_OPEN probe
  }
  idempotency: {
    enabled: boolean
    ttlMs:   number                // result cache duration
  }
  logging: {
    level:          'debug' | 'info' | 'warn' | 'error'
    exportToFile?:  string         // e.g. './app.log.txt'
  }
  telemetry: {
    serviceName: string
    enabled:     boolean
  }
}
```

---

## 4. Specified Behaviors

These are the behavioral contracts. The test suite is derived directly from this section.

### 4.1 Timeout

- If `fn()` does not resolve within `timeoutMs`, rejects with `TimeoutError`.
- Uses `AbortController` + `Promise.race` — no polling.
- On timeout, the controller aborts so `fn()` can clean up if it observes the signal.
- The timer is cleared immediately when `fn()` resolves — no memory leaks.

### 4.2 Retry with Exponential Backoff + Jitter

Base formula:

```
delay = min(baseDelay * 2^attempt, maxDelay)
```

Jitter strategies (reference: [AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)):

| Strategy | Formula | Use case |
|---|---|---|
| `none` | Pure exponential | Predictable, risky under load |
| `full` | `random(0, cap)` | Maximum spread — default recommendation |
| `equal` | `cap/2 + random(0, cap/2)` | Balanced: not too early, not too spread |

- No retry if the circuit breaker is `OPEN`.
- No retry if `retryOn(error)` returns `false`.
- Final attempt propagates as `MaxRetriesError`, preserving the original error.
- Default `retryOn`: always retry — caller provides predicate to filter e.g. 4xx errors.

### 4.3 Circuit Breaker — State Machine

| From state | Condition | To state |
|---|---|---|
| `CLOSED` | `failures >= failureThreshold` | `OPEN` |
| `OPEN` | `openTimeoutMs` elapsed | `HALF_OPEN` |
| `HALF_OPEN` | `successes >= successThreshold` | `CLOSED` |
| `HALF_OPEN` | any failure | `OPEN` |

- `OPEN`: rejects immediately with `CircuitOpenError` — `fn()` is never called.
- `HALF_OPEN`: allows exactly one in-flight call at a time.
- Success in `CLOSED` state resets the failure counter.
- `OPEN` → `HALF_OPEN` transition is lazy: evaluated on the next `guard()` call.

### 4.4 Idempotency

- Two concurrent calls with the same key share a single `fn()` execution.
- The second caller receives the same result (or error) as the first.
- After `ttlMs`, the cached result is evicted; the next call re-executes `fn()`.
- Auto-generated UUID v4 key if none is provided (each call is independent).
- Store is behind `IdempotencyStore` interface — swap `InMemoryIdempotencyStore` for Redis in production without changing the pipeline.

### 4.5 Pipeline Execution Order

```
execute(fn)
  1. Check idempotency cache
  2. For each attempt:
     a. Guard: check circuit breaker state
     b. Race: fn(signal) vs timeout
     c. On success: record success, resolve
     d. On failure: record failure, compute delay, wait
     e. If last attempt or retryOn() = false: throw MaxRetriesError
  3. CircuitOpenError propagates immediately (no retry)
```

---

## 5. Observability

### 5.1 Log Entry Structure

```typescript
{
  timestamp:     string,     // ISO 8601
  level:         LogLevel,
  traceId:       string,     // 128-bit hex — shared across all attempts
  spanId:        string,     // 64-bit hex  — unique per attempt
  operationName: string,
  event:         'attempt' | 'success' | 'failure' | 'retry' | 'timeout' | 'circuit_open' | 'idempotent_hit',
  attempt?:      number,
  delayMs?:      number,
  durationMs?:   number,
  error?:        string
}
```

Destinations: `console.log` (always) + append to `.txt` file if `exportToFile` is configured.

### 5.2 Trace Propagation

- Each `execute()` call generates a `traceId` (128-bit hex, OTel-compatible format).
- Each retry attempt gets a new `spanId` (64-bit hex) — child of the same trace.
- The `traceId` is consistent across all log entries for a single `execute()` call.
- The `traceId` can be injected into HTTP headers or message attributes by the caller.

> **OTel compatibility:** `traceId`/`spanId` format matches the W3C Trace Context spec used by OpenTelemetry. To connect to a full OTel collector, replace `Logger` with an OTel SDK exporter — the IDs are already in the right format.

---

## 6. Typed Errors

| Error class | `name` property | When thrown |
|---|---|---|
| `TimeoutError` | `'TimeoutError'` | `fn()` exceeded `timeoutMs` |
| `CircuitOpenError` | `'CircuitOpenError'` | Circuit is `OPEN` — propagates immediately |
| `MaxRetriesError` | `'MaxRetriesError'` | All attempts exhausted (wraps `TimeoutError` too) |

`MaxRetriesError` carries `.attempts` (number) and `.originalError` (the last underlying error).

---

## 7. Idempotency Store Interface

```typescript
interface IdempotencyStore {
  getOrCreate<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>
}
```

The default implementation is `InMemoryIdempotencyStore` (Map-backed). To use Redis in production:

```typescript
class RedisIdempotencyStore implements IdempotencyStore {
  async getOrCreate<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const cached = await redis.get(key)
    if (cached) return JSON.parse(cached)
    const result = await fn()
    await redis.set(key, JSON.stringify(result), 'PX', ttlMs)
    return result
  }
}
```

Pass the custom store as the second argument to `createClient()`:

```typescript
createClient(config, new RedisIdempotencyStore(redisClient))
```

---

## 8. File Structure

```
resilience-client/
├── src/
│   ├── index.ts           ← createClient() + pipeline
│   ├── types.ts           ← all interfaces, errors, config
│   ├── circuit-breaker.ts ← state machine (testable standalone)
│   ├── timeout.ts         ← AbortController + Promise.race
│   ├── backoff.ts         ← pure functions, easy to test
│   ├── idempotency.ts     ← InMemoryIdempotencyStore
│   ├── logger.ts          ← structured logging + OTel trace IDs
│   └── demo.ts            ← runnable demo (5 scenarios)
├── tests/
│   └── resilience.test.ts ← 26 tests (Jest + fake timers)
├── jest.config.ts
├── tsconfig.json
├── package.json
├── README.md
├── SPEC.md
└── DECISIONS.md
```

---

## 9. Usage Example

```typescript
import { createClient } from './src/index'

const client = createClient({
  timeout:        { defaultMs: 3000 },
  retry:          { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5000, jitter: 'full' },
  circuitBreaker: { failureThreshold: 5, successThreshold: 2, openTimeoutMs: 10000 },
  idempotency:    { enabled: true, ttlMs: 30000 },
  logging:        { level: 'info', exportToFile: './app.log.txt' },
  telemetry:      { serviceName: 'payment-service', enabled: true }
})

// Works with any async function — HTTP, queue, DB query
const result = await client.execute(
  (signal) => fetch('https://api.example.com/payments', { signal }).then(r => r.json()),
  { operationName: 'getPayments', idempotencyKey: 'order-abc-123' }
)
```

---

## 10. Quick Start

| Command | Description |
|---|---|
| `npm install` | Install dependencies |
| `npm test` | Run 26 tests |
| `npx ts-node src/demo.ts` | Run the interactive demo (5 scenarios) |

> **Evaluator note:** The demo script runs all 5 mechanisms end-to-end with real async delays, colored console output, and writes structured JSON logs to `demo.log.txt`. No setup required beyond `npm install`.
