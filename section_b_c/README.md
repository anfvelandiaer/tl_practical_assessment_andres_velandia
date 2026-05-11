# resilience-client

A reusable, transport-agnostic resilience module for Node.js with TypeScript.

Wraps any async function with: **timeouts**, **retries with exponential backoff and jitter**, a **circuit breaker**, **centralized configuration**, **unified structured logging**, **OpenTelemetry-compatible trace propagation**, and **idempotency key support**.

---

## Quick start

```bash
npm install
npm test                      # 26 tests, all passing
npx ts-node src/demo.ts       # interactive demo — 5 live scenarios
```

The demo writes structured JSON logs to `demo.log.txt` as it runs.

---

## What's included

| File | Responsibility |
|---|---|
| `src/index.ts` | `createClient()` — assembles and exposes the execution pipeline |
| `src/types.ts` | All interfaces, typed errors, and configuration types |
| `src/circuit-breaker.ts` | State machine: CLOSED / OPEN / HALF_OPEN |
| `src/timeout.ts` | AbortController + Promise.race |
| `src/backoff.ts` | Exponential backoff with full / equal / none jitter |
| `src/idempotency.ts` | In-memory store behind an `IdempotencyStore` interface |
| `src/logger.ts` | Structured JSON logging + OTel-compatible traceId/spanId |
| `src/demo.ts` | Five end-to-end scenarios with colored output |
| `tests/resilience.test.ts` | 26 Jest tests covering all mechanisms and the integrated pipeline |

---

## Usage

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

// Works with any async function — HTTP, queue, DB query, anything
const result = await client.execute(
  (signal) => fetch('https://api.example.com/payments', { signal }).then(r => r.json()),
  { operationName: 'getPayments', idempotencyKey: 'order-abc-123' }
)
```

Per-call options override global config:

```typescript
await client.execute(fn, {
  timeout:            500,    // override global defaultMs for this call
  idempotencyKey:     'k1',   // deduplicates concurrent calls with the same key
  operationName:      'healthCheck',
  skipCircuitBreaker: true    // bypass the circuit breaker for health probes
})
```

---

## Pipeline execution order

```
execute(fn)
  1. Idempotency gate     — deduplicate concurrent calls with the same key
  2. Per attempt:
     a. Circuit breaker   — reject immediately if OPEN
     b. Timeout race      — fn(signal) vs AbortController timer
     c. On success        — record success, resolve
     d. On failure        — record failure, compute backoff delay, wait
     e. If exhausted      — throw MaxRetriesError(attempts, originalError)
  3. CircuitOpenError     — propagates immediately, bypasses retry loop
```

---

## Error types

| Error | When |
|---|---|
| `TimeoutError` | `fn()` exceeded `timeoutMs` |
| `CircuitOpenError` | Circuit is OPEN — thrown before calling `fn()` |
| `MaxRetriesError` | All attempts exhausted — wraps `TimeoutError` too |

`MaxRetriesError` carries `.attempts` and `.originalError` for root cause analysis.

---

## Idempotency store

The default `InMemoryIdempotencyStore` is backed by a `Map`. For production deployments that need cross-instance deduplication, implement the `IdempotencyStore` interface and pass it as the second argument:

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

createClient(config, new RedisIdempotencyStore(redisClient))
```

---

## Log output

Each event emits a structured JSON line to `console.log` and optionally to a `.txt` file:

```json
{
  "timestamp": "2026-05-09T21:00:00.000Z",
  "level": "warn",
  "traceId": "bd70c722eaaa1b7d35e5aa248908d0ba",
  "spanId": "bfec00bc0f4e6251",
  "operationName": "getPayments",
  "event": "retry",
  "attempt": 2,
  "delayMs": 143,
  "error": "Service unavailable"
}
```

`traceId` is consistent across all retry attempts for a single `execute()` call. The format is W3C Trace Context-compatible — IDs can be passed directly to an OpenTelemetry SDK or injected into outbound HTTP headers.

---

## Design decisions

See [`DECISIONS.md`](./DECISIONS.md) for the full rationale behind each architectural choice.
