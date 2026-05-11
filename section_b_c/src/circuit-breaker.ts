import { CircuitBreakerConfig, CircuitOpenError, CircuitState } from './types'

/**
 * Circuit breaker — state machine with three states:
 *
 *  CLOSED    → normal operation, failures are counted
 *  OPEN      → fast-fail, no calls pass through
 *  HALF_OPEN → probe state: one call at a time allowed to test recovery
 *
 * Exported as a class so it can be instantiated and tested independently.
 * The ResilienceClient holds one instance per createClient() call.
 */
export class CircuitBreaker {
  private _state: CircuitState = 'CLOSED'
  private failureCount  = 0
  private successCount  = 0
  private openedAt?: number
  private halfOpenInFlight = false

  constructor(private readonly config: CircuitBreakerConfig) {}

  get state(): CircuitState {
    // Lazy transition: OPEN → HALF_OPEN based on elapsed time
    if (this._state === 'OPEN' && this.openedAt !== undefined) {
      if (Date.now() - this.openedAt >= this.config.openTimeoutMs) {
        this._state        = 'HALF_OPEN'
        this.successCount  = 0
        this.halfOpenInFlight = false
      }
    }
    return this._state
  }

  /**
   * Call before executing fn().
   * Throws CircuitOpenError if the circuit should reject the call.
   */
  guard(): void {
    const state = this.state
    if (state === 'OPEN') throw new CircuitOpenError()
    if (state === 'HALF_OPEN' && this.halfOpenInFlight) throw new CircuitOpenError()
    if (state === 'HALF_OPEN') this.halfOpenInFlight = true
  }

  recordSuccess(): void {
    if (this._state === 'HALF_OPEN') {
      this.successCount++
      this.halfOpenInFlight = false
      if (this.successCount >= this.config.successThreshold) {
        this.transitionTo('CLOSED')
      }
    } else {
      // Reset failure streak on success in CLOSED state
      this.failureCount = 0
    }
  }

  recordFailure(): void {
    if (this._state === 'HALF_OPEN') {
      this.transitionTo('OPEN')
      return
    }
    this.failureCount++
    if (this.failureCount >= this.config.failureThreshold) {
      this.transitionTo('OPEN')
    }
  }

  /** Test helper — force a specific state without going through the normal transitions */
  forceState(state: CircuitState): void {
    this.transitionTo(state)
  }

  private transitionTo(state: CircuitState): void {
    this._state = state
    if (state === 'OPEN') {
      this.openedAt         = Date.now()
      this.halfOpenInFlight = false
    } else if (state === 'CLOSED') {
      this.failureCount     = 0
      this.successCount     = 0
      this.openedAt         = undefined
      this.halfOpenInFlight = false
    } else if (state === 'HALF_OPEN') {
      this.successCount     = 0
      this.halfOpenInFlight = false
    }
  }
}
