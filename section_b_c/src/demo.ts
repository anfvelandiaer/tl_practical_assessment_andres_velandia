/**
 * demo.ts — npx ts-node src/demo.ts
 *
 * Point C: Interactive demonstration of resilience patterns.
 * A simulated upstream service presents various failure modes; the framework
 * mitigates each one in real-time, rendered inline as events fire.
 *
 * Scenarios:
 *   1. Retry + Exponential Backoff + Jitter
 *   2. Circuit Breaker: CLOSED → OPEN → HALF_OPEN → CLOSED
 *   3. Structured Logging + Level Filtering
 *   4. Combined: all patterns in a realistic payment service
 *
 * Flags:
 *   --auto   run all scenarios without pausing (useful for CI / piped output)
 */

import * as readline from 'readline'
import { createClient } from './index'
import { sleep }        from './backoff'
import { CircuitOpenError, LogEntry } from './types'

// ─── Terminal colors ──────────────────────────────────────────────────────────

const RESET  = '\x1b[0m'
const BOLD   = '\x1b[1m'
const DIM    = '\x1b[2m'
const RED    = '\x1b[31m'
const GREEN  = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN   = '\x1b[36m'

function W(s: string): void { process.stdout.write(s) }
function P(s: string): void { process.stdout.write(s + '\n') }

const AUTO = process.argv.includes('--auto') || !process.stdin.isTTY

// ─── UI helpers ───────────────────────────────────────────────────────────────

function banner(n: number, title: string, description: string): void {
  const sep = `${CYAN}${'─'.repeat(62)}${RESET}`
  P(`\n${sep}`)
  P(`${BOLD}${CYAN}  Scenario ${n}/4: ${title}${RESET}`)
  P(sep)
  P('')
  for (const line of description.split('\n')) P(`  ${DIM}${line}${RESET}`)
  P('')
}

function subBanner(n: number, total: number, title: string): void {
  P(`\n  ${BOLD}${CYAN}  Part ${n}/${total} — ${title}${RESET}`)
  P(`  ${DIM}${'─'.repeat(44)}${RESET}`)
}

function printCircuitBadge(state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): void {
  const color = state === 'CLOSED' ? GREEN : state === 'OPEN' ? RED : YELLOW
  P(`\n  ${BOLD}Circuit Breaker:${RESET} ${color}■ ${state}${RESET} ${DIM}${'─'.repeat(40)}${RESET}\n`)
}

function printSummary(rows: Array<{ label: string; value: string }>): void {
  const w = Math.max(...rows.map(r => r.label.length))
  P(`\n  ${DIM}${'─'.repeat(52)}${RESET}`)
  P(`  ${BOLD}Summary${RESET}`)
  P(`  ${DIM}${'─'.repeat(52)}${RESET}`)
  for (const { label, value } of rows)
    P(`  ${label.padEnd(w + 2)}${CYAN}${value}${RESET}`)
  P(`  ${DIM}${'─'.repeat(52)}${RESET}`)
}

function printFinalTable(rows: Array<{ pattern: string; result: string }>): void {
  const w = Math.max(...rows.map(r => r.pattern.length))
  P(`\n${CYAN}${BOLD}${'═'.repeat(62)}${RESET}`)
  P(`${BOLD}${CYAN}  All Patterns Demonstrated${RESET}`)
  P(`${CYAN}${'═'.repeat(62)}${RESET}\n`)
  for (const { pattern, result } of rows)
    P(`  ${GREEN}✓${RESET}  ${BOLD}${pattern.padEnd(w + 2)}${RESET}${DIM}${result}${RESET}`)
  P('')
}

async function pause(): Promise<void> {
  if (AUTO) { P(''); return }
  await new Promise<void>(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`\n  ${DIM}Press Enter to continue ▶${RESET}  `, () => { rl.close(); W('\n'); resolve() })
  })
}

// ─── Scenario 1: Retry + Exponential Backoff + Jitter ─────────────────────────

async function scenarioRetry(): Promise<{ pattern: string; result: string }> {
  banner(1,
    'Retry + Exponential Backoff + Jitter',
    'Upstream fails the first 3 calls, then recovers.\n' +
    'Without retry the call would fail permanently on attempt 1.')

  const upstream = makeUpstream(async n => {
    await sleep(200)
    if (n <= 3) throw new Error('503 Service Unavailable')
    return '{ "orderId": "ORD-001", "status": "processed" }'
  })

  const client = createClient({
    timeout:        { defaultMs: 5000 },
    retry:          { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 3000, jitter: 'equal' },
    circuitBreaker: { failureThreshold: 10, successThreshold: 2, openTimeoutMs: 60000 },
    idempotency:    { enabled: false, ttlMs: 0 },
    logging:        { level: 'debug' },
    telemetry:      { serviceName: 'demo', enabled: false },
  })

  P(`  ${DIM}Config:${RESET}   maxAttempts=5 · baseDelay=500ms · jitter='equal'`)
  P(`  ${DIM}Upstream:${RESET} fails × 3, then recovers`)
  P('')

  const renderer = new ScenarioRenderer()
  const stop = startCapture(e => renderer.render(e))
  let result = ''
  try {
    result = await client.execute(() => upstream.call(), { operationName: 'order-api' })
    renderer.flush()
    P(`\n  ${GREEN}Result:${RESET} ${result}`)
  } catch (e) {
    renderer.flush()
    P(`\n  ${RED}Failed:${RESET} ${(e as Error).message}`)
  } finally {
    stop()
  }

  const { calls } = upstream.stats()
  printSummary([
    { label: 'Upstream calls made',  value: String(calls) },
    { label: 'Retries performed',    value: String(calls - 1) },
    { label: 'Without retry',        value: 'would have failed permanently on attempt 1' },
    { label: 'With retry',           value: `succeeded on attempt ${calls}` },
  ])

  return { pattern: 'Retry + Backoff + Jitter', result: `recovered on attempt ${calls}` }
}

// ─── Scenario 2: Circuit Breaker ──────────────────────────────────────────────

async function scenarioCircuitBreaker(): Promise<{ pattern: string; result: string }> {
  banner(2,
    'Circuit Breaker: CLOSED → OPEN → HALF_OPEN → CLOSED',
    'Upstream goes completely down.\n' +
    'After 3 failures the circuit opens — subsequent requests fail instantly\n' +
    'without calling fn(). After a timeout it probes and self-heals.')

  const cbCfg = { failureThreshold: 3, successThreshold: 2, openTimeoutMs: 5000 }

  const client = createClient({
    timeout:        { defaultMs: 2000 },
    retry:          { maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 50, jitter: 'none' },
    circuitBreaker: cbCfg,
    idempotency:    { enabled: false, ttlMs: 0 },
    logging:        { level: 'debug' },
    telemetry:      { serviceName: 'demo', enabled: false },
  })

  const renderer = new ScenarioRenderer()
  const stop = startCapture(e => renderer.render(e))

  // Phase 1 — exhaust the failure threshold to open the circuit
  printCircuitBadge('CLOSED')
  P(`  ${DIM}Sending ${cbCfg.failureThreshold + 2} requests to a failing upstream (failureThreshold=${cbCfg.failureThreshold})...${RESET}`)
  P('')

  let blocked = 0
  for (let i = 1; i <= cbCfg.failureThreshold + 2; i++) {
    await sleep(400)
    try {
      await client.execute(
        async () => { await sleep(150); throw new Error('500 Internal Server Error') },
        { operationName: 'inventory-svc' }
      )
    } catch (e) {
      if (e instanceof CircuitOpenError) blocked++
    }
    if (i === cbCfg.failureThreshold) {
      renderer.flush()
      await sleep(400)
      printCircuitBadge('OPEN')
      await sleep(300)
      P(`  ${DIM}Requests ${i + 1}–${cbCfg.failureThreshold + 2}: rejected without calling fn()...${RESET}`)
      P('')
    }
  }

  // Phase 2 — wait for the circuit's openTimeoutMs to elapse → HALF_OPEN
  renderer.flush()
  await sleep(500)
  P(`\n  ${DIM}⏳ Waiting ${cbCfg.openTimeoutMs}ms for circuit to move to HALF_OPEN...${RESET}`)
  await new Promise(r => setTimeout(r, cbCfg.openTimeoutMs + 300))
  printCircuitBadge('HALF_OPEN')
  await sleep(400)
  P(`  ${DIM}Sending recovery requests (successThreshold=${cbCfg.successThreshold})...${RESET}`)
  P('')

  // Phase 3 — send successful probes to close the circuit
  let closed = false
  for (let i = 1; i <= cbCfg.successThreshold && !closed; i++) {
    await sleep(400)
    try {
      await client.execute(
        async () => { await sleep(150); return '{"status":"ok"}' },
        { operationName: 'inventory-svc' }
      )
      if (i === cbCfg.successThreshold) {
        closed = true
        renderer.flush()
        await sleep(400)
        printCircuitBadge('CLOSED')
      }
    } catch { /* still probing */ }
  }

  stop()

  printSummary([
    { label: 'Requests hitting upstream',  value: String(cbCfg.failureThreshold) },
    { label: 'Requests blocked by CB',     value: `${blocked} (fn() never called)` },
    { label: 'Time in OPEN state',         value: `${cbCfg.openTimeoutMs}ms` },
    { label: 'Successes to close CB',      value: String(cbCfg.successThreshold) },
    { label: 'Final state',                value: closed ? 'CLOSED ✓' : 'HALF_OPEN' },
  ])

  return { pattern: 'Circuit Breaker', result: `CLOSED→OPEN→HALF_OPEN→CLOSED, ${blocked} requests protected` }
}

// ─── Scenario 3: Structured Logging + Level Filtering ────────────────────────

async function scenarioLogging(): Promise<{ pattern: string; result: string }> {
  banner(3,
    'Structured Logging + Level Filtering',
    'Every framework event emits a structured JSON line — ready for any\n' +
    'log aggregator (Datadog, CloudWatch, ELK). The level setting controls\n' +
    'which events reach the stream. exportToFile persists lines to disk.')

  const TOTAL_PARTS = 2

  // Shared config for both parts — only logging.level differs
  const baseCfg = {
    timeout:        { defaultMs: 5000 },
    retry:          { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 200, jitter: 'none' as const },
    circuitBreaker: { failureThreshold: 10, successThreshold: 2, openTimeoutMs: 60000 },
    idempotency:    { enabled: false, ttlMs: 0 },
    telemetry:      { serviceName: 'payment-svc', enabled: false },
  }

  // Upstream that fails the first call then recovers — used in both parts
  function makeLogUpstream() {
    let n = 0
    return async () => { n++; await sleep(50); if (n <= 1) throw new Error('503 Service Unavailable'); return 'ok' }
  }

  // ── Part 1: level='debug' — all events visible ────────────────────────────
  subBanner(1, TOTAL_PARTS, "Raw JSON output  (level: 'debug')")
  P(`  ${DIM}A call that fails once then recovers. Raw Logger output — no rendering:${RESET}`)
  P('')

  await createClient({ ...baseCfg, logging: { level: 'debug' } })
    .execute(makeLogUpstream(), { operationName: 'payment-svc' })

  P('')
  P(`  ${DIM}Fields: timestamp · level · traceId · spanId · operationName · event · attempt · durationMs · error${RESET}`)

  // ── Part 2: level='warn' — debug and info events filtered out ─────────────
  subBanner(2, TOTAL_PARTS, "Level filtering  (level: 'warn')")
  P(`  ${DIM}Same scenario. attempt + retry (debug) and success (info) are suppressed:${RESET}`)
  P('')

  await createClient({ ...baseCfg, logging: { level: 'warn' } })
    .execute(makeLogUpstream(), { operationName: 'payment-svc' })

  P('')
  P(`  ${DIM}Only the warn-level failure line appeared — 4 of 5 events were filtered out.${RESET}`)

  printSummary([
    { label: 'Format',           value: 'structured JSON on every framework event' },
    { label: "level: 'debug'",   value: 'attempt · retry · success · failure · timeout · circuit_open' },
    { label: "level: 'warn'",    value: 'failure · timeout · circuit_open only' },
    { label: 'File export',      value: "set logging.exportToFile: '<path>' to persist lines to disk" },
  ])

  return { pattern: 'Structured Logging', result: "JSON lines visible · level filter: 5 events → 1 at 'warn'" }
}

// ─── Scenario 4: All Patterns Combined ────────────────────────────────────────

async function scenarioCombined(): Promise<{ pattern: string; result: string }> {
  banner(4,
    'Combined — Realistic Payment Processing Service',
    'A payment service calls an upstream payments API under stress.\n' +
    'All 4 resilience patterns activate in sequence.')

  const TOTAL_PARTS = 4

  function makeClient(overrides: object) {
    return createClient({
      timeout:        { defaultMs: 5000 },
      retry:          { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 2000, jitter: 'equal' },
      circuitBreaker: { failureThreshold: 10, successThreshold: 2, openTimeoutMs: 60000 },
      idempotency:    { enabled: false, ttlMs: 0 },
      logging:        { level: 'debug' },
      telemetry:      { serviceName: 'payment-svc', enabled: false },
      ...overrides,
    })
  }

  // ── Part 1: Idempotency ────────────────────────────────────────────────────
  subBanner(1, TOTAL_PARTS, 'Idempotency')
  P(`  ${DIM}User triple-clicks "Pay". 3 concurrent requests with key="payment-PMT-987".${RESET}`)
  P('')

  let p1Exec = 0
  const p1Client = makeClient({ idempotency: { enabled: true, ttlMs: 30000 } })

  type CapturedEv = { op: string; kind: 'attempt' | 'success' | 'hit' }
  const p1Evs: CapturedEv[] = []
  const stopP1 = startCapture((e: LogEntry) => {
    if      (e.event === 'attempt')        p1Evs.push({ op: e.operationName, kind: 'attempt' })
    else if (e.event === 'success')        p1Evs.push({ op: e.operationName, kind: 'success' })
    else if (e.event === 'idempotent_hit') p1Evs.push({ op: e.operationName, kind: 'hit'     })
  })

  const p1Results = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      p1Client.execute(
        async () => { p1Exec++; await sleep(80); return 'payment-accepted' },
        { idempotencyKey: 'payment-PMT-987', operationName: `pay-click-${i + 1}` }
      )
    )
  )
  stopP1()

  for (const { op, kind } of p1Evs) {
    const icon = kind === 'attempt' ? `${DIM}→ fn() called${RESET}` : kind === 'success' ? `${GREEN}✓${RESET}` : `${YELLOW}↩ cached${RESET}`
    P(`  ${DIM}[${op}]${RESET}  ${icon}`)
  }
  P(`\n  ${GREEN}✓${RESET}  "${p1Results[0]}" — fn() ran ${p1Exec}× instead of 3×`)

  // ── Part 2: Retry ──────────────────────────────────────────────────────────
  subBanner(2, TOTAL_PARTS, 'Retry + Backoff')
  P(`  ${DIM}Payment gateway is degraded — first 2 attempts fail with 502.${RESET}`)
  P('')

  const p2Up = makeUpstream(async n => {
    await sleep(200)
    if (n <= 2) throw new Error('502 Bad Gateway')
    return 'payment-confirmed'
  })
  const p2Client = makeClient({})

  const p2Renderer = new ScenarioRenderer()
  const stopP2 = startCapture(e => p2Renderer.render(e))
  try {
    const r = await p2Client.execute(() => p2Up.call(), { operationName: 'payment-gateway' })
    p2Renderer.flush()
    P(`\n  ${GREEN}✓${RESET}  ${r}`)
  } catch (e) {
    p2Renderer.flush()
    P(`\n  ${RED}✗${RESET}  ${(e as Error).message}`)
  } finally {
    stopP2()
  }

  // ── Part 3: Timeout ────────────────────────────────────────────────────────
  subBanner(3, TOTAL_PARTS, 'Timeout')
  P(`  ${DIM}Under load, gateway response takes 3s. Client timeout: 900ms.${RESET}`)
  P('')

  const p3Client = makeClient({
    timeout: { defaultMs: 900 },
    retry:   { maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 50, jitter: 'none' },
  })

  const p3Renderer = new ScenarioRenderer()
  const stopP3 = startCapture(e => p3Renderer.render(e))
  let p3Elapsed = 0
  let p3Aborted = false
  const p3Start = Date.now()
  try {
    await p3Client.execute(
      signal => new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => resolve('late'), 3000)
        signal?.addEventListener('abort', () => {
          clearTimeout(t)
          p3Aborted = true
          reject(new Error('aborted'))
        })
      }),
      { operationName: 'payment-slow' }
    )
  } catch {
    p3Renderer.flush()
    p3Elapsed = Date.now() - p3Start
    P(`  ${YELLOW}⏱ Timed out at ${p3Elapsed}ms${RESET}  ${DIM}(saved ~${3000 - p3Elapsed}ms)${RESET}`)
    if (p3Aborted) P(`  ${DIM}AbortSignal fired → upstream fn() cancelled${RESET}`)
  } finally {
    stopP3()
  }

  // ── Part 4: Circuit Breaker ────────────────────────────────────────────────
  subBanner(4, TOTAL_PARTS, 'Circuit Breaker')
  P(`  ${DIM}Gateway completely down. CB opens after 3 failures, then self-heals.${RESET}`)

  const p4Cfg = { failureThreshold: 3, successThreshold: 2, openTimeoutMs: 4000 }
  const p4Client = makeClient({
    timeout:        { defaultMs: 2000 },
    retry:          { maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 50, jitter: 'none' },
    circuitBreaker: p4Cfg,
  })

  const p4Renderer = new ScenarioRenderer()
  const stopP4 = startCapture(e => p4Renderer.render(e))
  let p4Blocked = 0

  printCircuitBadge('CLOSED')
  await sleep(300)
  for (let i = 1; i <= p4Cfg.failureThreshold + 2; i++) {
    await sleep(400)
    try {
      await p4Client.execute(
        async () => { await sleep(150); throw new Error('503 Gateway Down') },
        { operationName: 'payment-gateway' }
      )
    } catch (e) {
      if (e instanceof CircuitOpenError) p4Blocked++
    }
    if (i === p4Cfg.failureThreshold) {
      p4Renderer.flush()
      await sleep(400)
      printCircuitBadge('OPEN')
      await sleep(300)
    }
  }

  P(`  ${DIM}⏳ Waiting ${p4Cfg.openTimeoutMs}ms for HALF_OPEN probe...${RESET}`)
  await new Promise(r => setTimeout(r, p4Cfg.openTimeoutMs + 300))
  printCircuitBadge('HALF_OPEN')
  await sleep(400)

  let p4Closed = false
  for (let i = 1; i <= p4Cfg.successThreshold && !p4Closed; i++) {
    await sleep(400)
    try {
      await p4Client.execute(
        async () => { await sleep(150); return 'ok' },
        { operationName: 'payment-gateway' }
      )
      if (i === p4Cfg.successThreshold) p4Closed = true
    } catch { /* probing */ }
  }

  stopP4()
  if (p4Closed) { p4Renderer.flush(); await sleep(400); printCircuitBadge('CLOSED') }

  // ── Combined summary ───────────────────────────────────────────────────────
  printSummary([
    { label: 'Part 1 — Idempotency',     value: `3 concurrent calls → ${p1Exec} fn() execution` },
    { label: 'Part 2 — Retry',           value: `recovered on attempt ${p2Up.stats().calls}` },
    { label: 'Part 3 — Timeout',         value: `fired at ${p3Elapsed}ms, saved ~${3000 - p3Elapsed}ms` },
    { label: 'Part 4 — Circuit Breaker', value: `${p4Blocked} requests blocked (fn() never called)` },
  ])

  return {
    pattern: 'All patterns combined',
    result:  'idempotency + retry + timeout + circuit breaker all active',
  }
}

// ─── Event capture ────────────────────────────────────────────────────────────
// Intercepts Logger's JSON lines from console.log and routes them to a callback.
// Returns a cleanup function that restores console.log.

function startCapture(cb: (e: LogEntry) => void): () => void {
  const orig = console.log
  console.log = (msg: unknown) => {
    try {
      if (typeof msg === 'string') {
        const e = JSON.parse(msg)
        if (e.timestamp && e.event) { cb(e as LogEntry); return }
      }
    } catch { /* not a Logger JSON line — pass through */ }
    orig(msg)
  }
  return () => { console.log = orig }
}

// ─── ScenarioRenderer ─────────────────────────────────────────────────────────
// Converts structured LogEntry events into human-readable terminal output.
// Keeps a `pending` flag to print the attempt number and its result on one line.

class ScenarioRenderer {
  private pending = false

  render(e: LogEntry): void {
    switch (e.event) {
      case 'attempt':
        if (this.pending) W('\n')
        W(`  ${DIM}→ Attempt ${e.attempt ?? '?'}${RESET}  `)
        this.pending = true
        break

      case 'success':
        this.pending
          ? (W(`${GREEN}✓${RESET}  ${DIM}${e.durationMs}ms${RESET}\n`),       this.pending = false)
          : P(`  ${GREEN}✓${RESET}  success  ${DIM}${e.durationMs}ms${RESET}`)
        break

      case 'failure':
        if (e.level === 'error') break  // final-attempt duplicate of 'warn' — skip
        this.pending
          ? (W(`${RED}✗${RESET}  ${e.error ?? 'error'}  ${DIM}(${e.durationMs ?? '?'}ms)${RESET}\n`), this.pending = false)
          : P(`  ${RED}✗${RESET}  ${e.error ?? 'error'}  ${DIM}(${e.durationMs ?? '?'}ms)${RESET}`)
        break

      case 'timeout':
        this.pending
          ? (W(`${YELLOW}⏱ TIMEOUT${RESET}  ${DIM}(${e.durationMs}ms)${RESET}\n`), this.pending = false)
          : P(`  ${YELLOW}⏱ TIMEOUT${RESET}  ${DIM}(${e.durationMs}ms)${RESET}`)
        break

      case 'retry':
        P(`  ${DIM}     ⟳  waiting ${e.delayMs}ms before next attempt${RESET}`)
        break

      case 'circuit_open':
        if (this.pending) { W('\n'); this.pending = false }
        P(`  ${RED}⚡ Circuit OPEN${RESET}  ${DIM}— request rejected instantly, fn() never called${RESET}`)
        break
    }
  }

  flush(): void {
    if (this.pending) { W('\n'); this.pending = false }
  }
}

// ─── Upstream factory ─────────────────────────────────────────────────────────
// Wraps a behavior function and tracks call statistics.

function makeUpstream(fn: (callNo: number) => Promise<string>) {
  let calls = 0, successes = 0, failures = 0

  async function call(): Promise<string> {
    calls++
    const n = calls
    try   { const r = await fn(n); successes++; return r }
    catch (e) {                     failures++;  throw e  }
  }

  function stats() { return { calls, successes, failures } }

  return { call, stats }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  P('')
  P(`${BOLD}${CYAN}  resilience-client — interactive demo${RESET}`)
  P(`  ${DIM}4 scenarios · all resilience patterns · real-time rendering${RESET}`)
  P(`  ${DIM}Run with: npx ts-node src/demo.ts${RESET}`)
  if (AUTO) P(`  ${DIM}Running in auto mode (--auto or non-TTY)${RESET}`)

  const summary: Array<{ pattern: string; result: string }> = []

  summary.push(await scenarioRetry());          await pause()
  summary.push(await scenarioCircuitBreaker()); await pause()
  summary.push(await scenarioLogging());        await pause()
  summary.push(await scenarioCombined())

  printFinalTable(summary)
}

main().catch(console.error)
