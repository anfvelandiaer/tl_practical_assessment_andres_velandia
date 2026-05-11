import { JitterStrategy } from './types'

/**
 * Computes the delay for a given attempt using exponential backoff + jitter.
 *
 * Jitter strategies prevent thundering herd when many clients retry simultaneously:
 *
 *  'none'  → pure exponential, predictable but risky under load
 *  'full'  → full random in [0, cap] — spreads retries maximally
 *  'equal' → [cap/2, cap] — balanced: not too early, not too spread
 *
 */
export function computeDelay(
  attempt:     number,   // 0-indexed
  baseDelayMs: number,
  maxDelayMs:  number,
  jitter:      JitterStrategy
): number {
  const exponential = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs)

  switch (jitter) {
    case 'none':
      return exponential

    case 'full':
      return Math.random() * exponential

    case 'equal': {
      const half = exponential / 2
      return half + Math.random() * half
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
