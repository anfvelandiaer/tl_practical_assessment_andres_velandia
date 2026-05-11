# Design Decisions — resilience-client

| # | Decision | Chosen approach | Key reason |
|---|---|---|---|
| 1 | Interface shape | `fn: () => Promise<T>` | Transport-agnostic |
| 2 | Pipeline order | Idempotency → timeout → CB → retry | Each layer has a clear scope |
| 3 | Circuit breaker | Standalone injectable class | Testable in isolation |
| 4 | Jitter | 3 strategies (full / equal / none) | Testability + production flexibility |
| 5 | Idempotency store | Interface + in-memory default | Swappable without touching the pipeline |
| 6 | Logging | Structured JSON + OTel-compatible IDs | Machine-parseable, OTel-ready |
| 7 | Health checks | `skipCircuitBreaker` flag | Prevents probes from blocking themselves |

---

## 1. Transport-agnostic interface

The module wraps any async function returning a Promise without coupling to HTTP or any specific protocol. By operating on plain promises it works with HTTP, gRPC, databases, or queues without modification, avoiding coupling the resilience layer to a transport concern. The caller constructs the function that makes the actual call — the module manages *when* to call, not *how*.

---

## 2. Pipeline order

**Idempotency first:** Wraps the entire pipeline. Two concurrent calls with the same key share a single execution, including its retries — invisible to the caller.

**Timeout per attempt:** Each attempt gets a full fresh window. A shared budget would silently shrink the last attempt's window.

**Circuit breaker before the call:** Checked on every attempt. If the circuit opens mid-retry sequence, the current attempt fails immediately rather than waiting for a timeout.

**Retry as the outer loop:** Orchestrates the other mechanisms and decides whether to retry based on the error type and the `retryOn` predicate.

---

## 3. Circuit breaker as a standalone class

`CircuitBreaker` is a separate class with `forceState()` exposed exclusively for deterministic testing of edge cases — every state transition is verifiable in isolation without running the full pipeline or depending on real timers.

---

## 4. Jitter as a first-class option

Three configurable strategies (`full`, `equal`, `none`) to prevent thundering herd — many clients failing simultaneously and retrying at once, overwhelming a recovering service. `full` spreads retries maximally; `equal` avoids very short retry windows; `none` produces deterministic delays for testing.

---

## 5. Idempotency store behind an interface

`InMemoryIdempotencyStore` (Map-backed) implements `IdempotencyStore` and is injectable as the second argument to `createClient()`. The store caches the Promise itself — not the resolved value — guaranteeing `fn()` is never executed twice even if the second caller arrives before the first resolves. For multi-instance production deployments, implementing the interface with Redis or DynamoDB requires no pipeline changes.

---

## 6. Structured JSON logging with OTel-compatible IDs

Every log entry is a JSON object with a `traceId` (128-bit) shared across all retry attempts of a single `execute()` call, and a `spanId` (64-bit) unique per attempt. The format matches the W3C Trace Context spec used by OpenTelemetry internally — IDs pass directly to an OTel SDK without conversion and without pulling that dependency into the module.

---

## 7. `skipCircuitBreaker` escape hatch

`ExecuteOptions` includes `skipCircuitBreaker?: boolean` so health checks and recovery probes are not subject to the circuit breaker — they are the mechanism that determines whether the circuit should change state, so blocking them would make them useless.
