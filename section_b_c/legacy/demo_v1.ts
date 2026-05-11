/**
 * demo.ts — npx ts-node src/demo.ts
 *
 * Point C: Interactive demonstration of all resilience patterns.
 * A simulated upstream service presents various failure modes; the framework
 * mitigates each one in real-time, rendered inline as events fire.
 *
 * Scenarios:
 *   1. Retry + Exponential Backoff + Jitter
 *   2. Timeout + AbortSignal cancellation
 *   3. Circuit Breaker: CLOSED → OPEN → HALF_OPEN → CLOSED
 *   4. Idempotency: concurrent duplicate requests
 *   5. Combined: all patterns in a realistic payment service
 *
 * Flags:
 *   --auto   run all scenarios without pausing (useful for CI / piped output)
 */

import * as readline from 'readline'
import { createClient }    from './index'
import { sleep }           from './backoff'
import { CircuitOpenError, LogEntry } from './types'

// ─── Terminal helpers ─────────────────────────────────────────────────────────

const R  = '\x1b[0m'
const BD = '\x1b[1m'
const DM = '\x1b[2m'
const RD = '\x1b[31m'
const GR = '\x1b[32m'
const YL = '\x1b[33m'
const CY = '\x1b[36m'

function W(msg: string): void { process.stdout.write(msg) }
function P(msg: string): void { process.stdout.write(msg + '\n') }

const AUTO = process.argv.includes('--auto') || !process.stdin.isTTY

// ─── UI components ────────────────────────────────────────────────────────────

function banner(n: number, total: number, title: string, description: string): void {
  const sep = `${CY}${'─'.repeat(62)}${R}`
  P(`\n${sep}`)
  P(`${BD}${CY}  Scenario ${n}/${total}: ${title}${R}`)
  P(sep)
  P('')
  for (const line of description.split('\n')) P(`  ${DM}${line}${R}`)
  P('')
}

function subBanner(n: number, title: string): void {
  P(`\n  ${BD}${CY}  Part ${n}/4 — ${title}${R}`)
  P(`  ${DM}${'─'.repeat(44)}${R}`)
}

function printCircuitBadge(state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): void {
  const c = state === 'CLOSED' ? GR : state === 'OPEN' ? RD : YL
  P(`\n  ${BD}Circuit Breaker:${R} ${c}■ ${state}${R} ${DM}${'─'.repeat(40)}${R}\n`)
}

function printSummary(rows: Array<{ label: string; value: string }>): void {
  const w = Math.max(...rows.map(r => r.label.length))
  P(`\n  ${DM}${'─'.repeat(52)}${R}`)
  P(`  ${BD}Summary${R}`)
  P(`  ${DM}${'─'.repeat(52)}${R}`)
  for (const { label, value } of rows)
    P(`  ${label.padEnd(w + 2)}${CY}${value}${R}`)
  P(`  ${DM}${'─'.repeat(52)}${R}`)
}

function printFinalTable(rows: Array<{ pattern: string; result: string }>): void {
  const w = Math.max(...rows.map(r => r.pattern.length))
  P(`\n${CY}${BD}${'═'.repeat(62)}${R}`)
  P(`${BD}${CY}  All Patterns Demonstrated${R}`)
  P(`${CY}${'═'.repeat(62)}${R}\n`)
  for (const { pattern, result } of rows)
    P(`  ${GR}✓${R}  ${BD}${pattern.padEnd(w + 2)}${R}${DM}${result}${R}`)
  P('')
}

async function pause(): Promise<void> {
  if (AUTO) { P(''); return }
  await new Promise<void>(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`\n  ${DM}Press Enter to continue ▶${R}  `, () => { rl.close(); W('\n'); resolve() })
  })
}

// ─── Event capture — intercepts Logger's JSON console.log output ──────────────

function startCapture(cb: (e: LogEntry) => void): () => void {
  const orig = console.log
  console.log = (msg: unknown) => {
    try {
      if (typeof msg === 'string') {
        const e = JSON.parse(msg)
        if (e.timestamp && e.event) { cb(e as LogEntry); return }
      }
    } catch { /* not a Logger line */ }
    orig(msg)
  }
  return () => { console.log = orig }
}

// ─── ScenarioRenderer — converts log events to live terminal output ───────────

class ScenarioRenderer {
  private pending = false   // true when an 'attempt' line has been started without newline

  render(e: LogEntry): void {
    switch (e.event) {
      case 'attempt':
        if (this.pending) W('\n')
        W(`  ${DM}→ Attempt ${e.attempt ?? '?'}${R}  `)
        this.pending = true
        break

      case 'success':
        if (this.pending) {
          W(`${GR}✓${R}  ${DM}${e.durationMs}ms${R}\n`)
          this.pending = false
        } else {
          P(`  ${GR}✓${R}  success  ${DM}${e.durationMs}ms${R}`)
        }
        break

      case 'failure':
        if (e.level === 'error') break          // duplicate of warn — skip
        if (this.pending) {
          W(`${RD}✗${R}  ${e.error ?? 'error'}  ${DM}(${e.durationMs ?? '?'}ms)${R}\n`)
          this.pending = false
        } else {
          P(`  ${RD}✗${R}  ${e.error ?? 'error'}  ${DM}(${e.durationMs ?? '?'}ms)${R}`)
        }
        break

      case 'timeout':
        if (this.pending) {
          W(`${YL}⏱ TIMEOUT${R}  ${DM}(limit ${e.durationMs}ms)${R}\n`)
          this.pending = false
        } else {
          P(`  ${YL}⏱ TIMEOUT${R}  ${DM}(limit ${e.durationMs}ms)${R}`)
        }
        break

      case 'retry':
        P(`  ${DM}     ⟳  waiting ${e.delayMs}ms before next attempt${R}`)
        break

      case 'circuit_open':
        if (this.pending) { W('\n'); this.pending = false }
        P(`  ${RD}⚡ Circuit OPEN${R}  ${DM}— request rejected instantly, fn() never called${R}`)
        break

      case 'idempotent_hit':
        if (this.pending) { W('\n'); this.pending = false }
        P(`  ${YL}↩${R}  ${DM}Idempotency hit — returning cached result${R}`)
        break
    }
  }

  flush(): void {
    if (this.pending) { W('\n'); this.pending = false }
  }
}

// ─── Upstream Simulator ───────────────────────────────────────────────────────

class UpstreamSimulator {
  private calls    = 0
  private successes = 0
  private failures  = 0
  private totalMs   = 0

  constructor(private readonly fn: (n: number) => Promise<string>) {}

  async call(): Promise<string> {
    this.calls++
    const n = this.calls
    const t = Date.now()
    try   { const r = await this.fn(n); this.successes++; this.totalMs += Date.now() - t; return r }
    catch (e) {                          this.failures++;  this.totalMs += Date.now() - t; throw e }
  }

  stats() {
    return {
      calls:      this.calls,
      successes:  this.successes,
      failures:   this.failures,
      avgMs:      this.calls > 0 ? Math.round(this.totalMs / this.calls) : 0,
    }
  }
}

// ─── Scenario 1: Retry + Exponential Backoff + Jitter ─────────────────────────

async function scenario1(): Promise<{ pattern: string; result: string }> {
  banner(1, 5,
    'Retry + Exponential Backoff + Jitter',
    'Upstream fails the first 3 calls, then recovers.\n' +
    'Without retry the call would fail permanently on attempt 1.')

  const upstream = new UpstreamSimulator(async n => {
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

  P(`  ${DM}Config:${R}   maxAttempts=5 · baseDelay=500ms · jitter='equal'`)
  P(`  ${DM}Upstream:${R} fails × 3, then succeeds`)
  P('')

  const renderer = new ScenarioRenderer()
  const stop = startCapture(e => renderer.render(e))
  let result = ''
  try {
    result = await client.execute(() => upstream.call(), { operationName: 'order-api' })
    renderer.flush()
    P(`\n  ${GR}Result:${R} ${result}`)
  } catch (e) {
    renderer.flush()
    P(`\n  ${RD}Failed:${R} ${(e as Error).message}`)
  } finally {
    stop()
  }

  const s = upstream.stats()
  printSummary([
    { label: 'Upstream calls made',  value: String(s.calls) },
    { label: 'Retries performed',    value: String(s.calls - 1) },
    { label: 'Without retry',        value: 'would have failed permanently on attempt 1' },
    { label: 'With retry',           value: `succeeded on attempt ${s.calls}` },
  ])

  return { pattern: 'Retry + Backoff + Jitter', result: `recovered on attempt ${s.calls}` }
}

// ─── Scenario 2: Timeout + AbortSignal ────────────────────────────────────────

async function scenario2(): Promise<{ pattern: string; result: string }> {
  banner(2, 5,
    'Timeout + AbortSignal Cancellation',
    'Upstream is slow — responds after 4 seconds. Client timeout: 800ms.\n' +
    'The AbortSignal is passed so fn() can cancel in-flight work immediately.')

  const client = createClient({
    timeout:        { defaultMs: 800 },
    retry:          { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 100, jitter: 'none' },
    circuitBreaker: { failureThreshold: 10, successThreshold: 2, openTimeoutMs: 60000 },
    idempotency:    { enabled: false, ttlMs: 0 },
    logging:        { level: 'debug' },
    telemetry:      { serviceName: 'demo', enabled: false },
  })

  P(`  ${DM}Config:${R}   timeout=800ms · maxAttempts=1`)
  P(`  ${DM}Upstream:${R} responds after 4000ms`)
  P('')

  const renderer = new ScenarioRenderer()
  const stop = startCapture(e => renderer.render(e))
  let aborted = false
  let elapsed = 0
  const t0 = Date.now()

  try {
    await client.execute(
      signal => new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve('slow-result'), 4000)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          aborted = true
          reject(new Error('AbortError'))
        })
      }),
      { operationName: 'report-api' }
    )
  } catch {
    renderer.flush()
    elapsed = Date.now() - t0
    P(`\n  ${YL}Timed out after ${elapsed}ms${R}  ${DM}(upstream would have taken 4000ms)${R}`)
    if (aborted) P(`  ${DM}AbortSignal fired → upstream fn() cancelled and cleaned up immediately${R}`)
  } finally {
    stop()
  }

  printSummary([
    { label: 'Timeout fired at',  value: `~${elapsed}ms` },
    { label: 'Time saved',        value: `~${4000 - elapsed}ms` },
    { label: 'AbortSignal',       value: aborted ? 'fired — fn() cleaned up' : 'not observed' },
    { label: 'Without timeout',   value: 'caller would hang for 4000ms' },
  ])

  return { pattern: 'Timeout + AbortSignal', result: `prevented ~${4000 - elapsed}ms hang, signal fired` }
}

// ─── Scenario 3: Circuit Breaker ──────────────────────────────────────────────

async function scenario3(): Promise<{ pattern: string; result: string }> {
  banner(3, 5,
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

  // Phase 1 — drive the circuit OPEN
  printCircuitBadge('CLOSED')
  P(`  ${DM}Sending ${cbCfg.failureThreshold + 2} requests to a failing upstream (failureThreshold=${cbCfg.failureThreshold})...${R}`)
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
      P(`  ${DM}Requests ${i + 1}–${cbCfg.failureThreshold + 2}: rejected without calling fn()...${R}`)
      P('')
    }
  }

  // Phase 2 — wait for HALF_OPEN
  renderer.flush()
  await sleep(500)
  P(`\n  ${DM}⏳ Waiting ${cbCfg.openTimeoutMs}ms for circuit to move to HALF_OPEN...${R}`)
  await new Promise(r => setTimeout(r, cbCfg.openTimeoutMs + 300))
  printCircuitBadge('HALF_OPEN')
  await sleep(400)
  P(`  ${DM}Sending recovery requests (successThreshold=${cbCfg.successThreshold})...${R}`)
  P('')

  // Phase 3 — recover
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

// ─── Scenario 4: Idempotency ──────────────────────────────────────────────────

async function scenario4(): Promise<{ pattern: string; result: string }> {
  banner(4, 5,
    'Idempotency — Concurrent Duplicate Requests',
    '5 concurrent calls arrive with the same order ID.\n' +
    'Without idempotency: fn() runs 5×, charging the user $99 five times.\n' +
    'With idempotency: fn() runs once, all 5 callers receive the same result.')

  let execCount = 0
  const chargeUpstream = async (): Promise<string> => {
    execCount++
    await new Promise(r => setTimeout(r, 120))
    return `charged-$99 (txn-${execCount})`
  }

  const client = createClient({
    timeout:        { defaultMs: 5000 },
    retry:          { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 100, jitter: 'none' },
    circuitBreaker: { failureThreshold: 10, successThreshold: 2, openTimeoutMs: 60000 },
    idempotency:    { enabled: true, ttlMs: 30000 },
    logging:        { level: 'debug' },
    telemetry:      { serviceName: 'demo', enabled: false },
  })

  const IDEM_KEY = 'order-ORD-42-charge'

  type Ev = { op: string; kind: 'attempt' | 'success' | 'hit'; detail: string }
  const captured: Ev[] = []

  const stop = startCapture((e: LogEntry) => {
    if      (e.event === 'attempt')       captured.push({ op: e.operationName, kind: 'attempt', detail: `Attempt ${e.attempt}` })
    else if (e.event === 'success')       captured.push({ op: e.operationName, kind: 'success', detail: `${e.durationMs}ms` })
    else if (e.event === 'idempotent_hit') captured.push({ op: e.operationName, kind: 'hit',    detail: 'cached result' })
  })

  P(`  ${DM}Firing 5 concurrent execute() calls with idempotencyKey="${IDEM_KEY}"${R}`)
  P(`  ${DM}operationName per call: charge-request-1 … charge-request-5${R}`)
  P('')

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      client.execute(chargeUpstream, {
        idempotencyKey: IDEM_KEY,
        operationName:  `charge-request-${i + 1}`,
      })
    )
  )

  stop()

  for (const ev of captured) {
    if (ev.kind === 'attempt')
      P(`  ${DM}[${ev.op}]${R}  → ${ev.detail}  ${DM}← fn() actually executed${R}`)
    else if (ev.kind === 'success')
      P(`  ${DM}[${ev.op}]${R}  ${GR}✓${R}  ${ev.detail}`)
    else
      P(`  ${DM}[${ev.op}]${R}  ${YL}↩${R}  Idempotency hit — ${ev.detail}`)
  }

  P(`\n  ${DM}Results received by each caller:${R}`)
  results.forEach((r, i) => P(`    Request ${i + 1}: "${r}"`))

  const allSame = new Set(results).size === 1
  printSummary([
    { label: 'Concurrent requests',   value: '5' },
    { label: 'fn() executions',       value: `${execCount} (would be 5 without idempotency)` },
    { label: 'All results identical', value: allSame ? 'YES ✓' : 'NO ✗' },
    { label: 'Duplicate charges',     value: `0 (would be ${5 - execCount} without idempotency)` },
  ])

  return { pattern: 'Idempotency', result: `5 concurrent calls → ${execCount} fn() execution, all results identical` }
}

// ─── Scenario 5: All Patterns Combined ────────────────────────────────────────

async function scenario5(): Promise<{ pattern: string; result: string }> {
  banner(5, 5,
    'Combined — Realistic Payment Processing Service',
    'A payment service calls an upstream payments API under stress.\n' +
    'All 4 resilience patterns activate in sequence.')

  // ── Part 1: Idempotency ────────────────────────────────────────────────────
  subBanner(1, 'Idempotency')
  P(`  ${DM}User triple-clicks "Pay". 3 concurrent requests with key="payment-PMT-987".${R}`)
  P('')

  let p1Exec = 0
  const p1Client = createClient({
    timeout: { defaultMs: 5000 }, retry: { maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 50, jitter: 'none' },
    circuitBreaker: { failureThreshold: 10, successThreshold: 2, openTimeoutMs: 60000 },
    idempotency: { enabled: true, ttlMs: 30000 },
    logging: { level: 'debug' }, telemetry: { serviceName: 'payment-svc', enabled: false },
  })

  type Ev1 = { op: string; kind: string; detail: string }
  const p1Evs: Ev1[] = []
  const stopP1 = startCapture((e: LogEntry) => {
    if      (e.event === 'attempt')        p1Evs.push({ op: e.operationName, kind: 'attempt', detail: `Attempt ${e.attempt}` })
    else if (e.event === 'success')        p1Evs.push({ op: e.operationName, kind: 'success', detail: `${e.durationMs}ms` })
    else if (e.event === 'idempotent_hit') p1Evs.push({ op: e.operationName, kind: 'hit',     detail: 'cached' })
  })

  const p1Results = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      p1Client.execute(
        async () => { p1Exec++; await new Promise(r => setTimeout(r, 80)); return 'payment-accepted' },
        { idempotencyKey: 'payment-PMT-987', operationName: `pay-click-${i + 1}` }
      )
    )
  )
  stopP1()

  for (const ev of p1Evs) {
    const icon = ev.kind === 'attempt' ? `${DM}→ fn() called${R}` : ev.kind === 'success' ? `${GR}✓${R}` : `${YL}↩ cached${R}`
    P(`  ${DM}[${ev.op}]${R}  ${icon}`)
  }
  P(`\n  ${GR}✓${R}  "${p1Results[0]}" — fn() ran ${p1Exec}× instead of 3×`)

  // ── Part 2: Retry ──────────────────────────────────────────────────────────
  subBanner(2, 'Retry + Backoff')
  P(`  ${DM}Payment gateway is degraded — first 2 attempts fail with 502.${R}`)
  P('')

  const p2Up = new UpstreamSimulator(async n => {
    await sleep(200)
    if (n <= 2) throw new Error('502 Bad Gateway')
    return 'payment-confirmed'
  })
  const p2Client = createClient({
    timeout: { defaultMs: 5000 }, retry: { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 2000, jitter: 'equal' },
    circuitBreaker: { failureThreshold: 10, successThreshold: 2, openTimeoutMs: 60000 },
    idempotency: { enabled: false, ttlMs: 0 },
    logging: { level: 'debug' }, telemetry: { serviceName: 'payment-svc', enabled: false },
  })

  const p2r = new ScenarioRenderer()
  const stopP2 = startCapture(e => p2r.render(e))
  try {
    const r = await p2Client.execute(() => p2Up.call(), { operationName: 'payment-gateway' })
    p2r.flush()
    P(`\n  ${GR}✓${R}  ${r}`)
  } catch (e) {
    p2r.flush()
    P(`\n  ${RD}✗${R}  ${(e as Error).message}`)
  } finally {
    stopP2()
  }

  // ── Part 3: Timeout ────────────────────────────────────────────────────────
  subBanner(3, 'Timeout')
  P(`  ${DM}Under load, gateway response takes 3s. Client timeout: 900ms.${R}`)
  P('')

  const p3Client = createClient({
    timeout: { defaultMs: 900 }, retry: { maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 50, jitter: 'none' },
    circuitBreaker: { failureThreshold: 10, successThreshold: 2, openTimeoutMs: 60000 },
    idempotency: { enabled: false, ttlMs: 0 },
    logging: { level: 'debug' }, telemetry: { serviceName: 'payment-svc', enabled: false },
  })

  const p3r = new ScenarioRenderer()
  const stopP3 = startCapture(e => p3r.render(e))
  let p3Elapsed = 0
  let p3Aborted = false
  const p3t0 = Date.now()
  try {
    await p3Client.execute(
      signal => new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => resolve('late'), 3000)
        signal?.addEventListener('abort', () => { clearTimeout(t); p3Aborted = true; reject(new Error('aborted')) })
      }),
      { operationName: 'payment-slow' }
    )
  } catch {
    p3r.flush()
    p3Elapsed = Date.now() - p3t0
    P(`  ${YL}⏱ Timed out at ${p3Elapsed}ms${R}  ${DM}(saved ~${3000 - p3Elapsed}ms)${R}`)
    if (p3Aborted) P(`  ${DM}AbortSignal fired → upstream fn() cancelled${R}`)
  } finally {
    stopP3()
  }

  // ── Part 4: Circuit Breaker ────────────────────────────────────────────────
  subBanner(4, 'Circuit Breaker')
  P(`  ${DM}Gateway completely down. CB opens after 3 failures, then self-heals.${R}`)

  const p4Cfg = { failureThreshold: 3, successThreshold: 2, openTimeoutMs: 4000 }
  const p4Client = createClient({
    timeout: { defaultMs: 2000 }, retry: { maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 50, jitter: 'none' },
    circuitBreaker: p4Cfg, idempotency: { enabled: false, ttlMs: 0 },
    logging: { level: 'debug' }, telemetry: { serviceName: 'payment-svc', enabled: false },
  })

  const p4r = new ScenarioRenderer()
  const stopP4 = startCapture(e => p4r.render(e))
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
      p4r.flush()
      await sleep(400)
      printCircuitBadge('OPEN')
      await sleep(300)
    }
  }

  P(`  ${DM}⏳ Waiting ${p4Cfg.openTimeoutMs}ms for HALF_OPEN probe...${R}`)
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
      if (i === p4Cfg.successThreshold) { p4Closed = true }
    } catch { /* probing */ }
  }

  stopP4()
  if (p4Closed) { p4r.flush(); await sleep(400); printCircuitBadge('CLOSED') }

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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  P('')
  P(`${BD}${CY}  resilience-client — interactive demo${R}`)
  P(`  ${DM}5 scenarios · all resilience patterns · real-time rendering${R}`)
  P(`  ${DM}Run with: npx ts-node src/demo.ts${R}`)
  if (AUTO) P(`  ${DM}Running in auto mode (--auto or non-TTY)${R}`)

  const summary: Array<{ pattern: string; result: string }> = []

  summary.push(await scenario1()); await pause()
  summary.push(await scenario2()); await pause()
  summary.push(await scenario3()); await pause()
  summary.push(await scenario4()); await pause()
  summary.push(await scenario5())

  printFinalTable(summary)
}

main().catch(console.error)
