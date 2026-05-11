import { IdempotencyStore } from './types'

type InFlightEntry<T> = {
  promise: Promise<T>
  timer:   ReturnType<typeof setTimeout>
}

/**
 * In-memory IdempotencyStore backed by a Map.
 *
 * Design decision: the store is hidden behind the IdempotencyStore interface,
 * so a future Redis/DynamoDB adapter can be plugged in without touching
 * the execution pipeline. The interface contract:
 *
 *   getOrCreate(key, ttlMs, fn) →
 *     if key is in-flight:  return the same promise (no double execution)
 *     if key is not known:  execute fn(), cache the result for ttlMs, return it
 *
 * Both success and failure are cached for the TTL duration,
 * so concurrent callers share the same outcome either way.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly cache = new Map<string, InFlightEntry<unknown>>()

  async getOrCreate<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const existing = this.cache.get(key) as InFlightEntry<T> | undefined
    if (existing) return existing.promise

    const promise = fn().finally(() => {
      // Keep result in cache until TTL expires, then evict
      // The timer is already set below — this is a no-op placeholder
    })

    const timer = setTimeout(() => {
      this.cache.delete(key)
    }, ttlMs)

    // Allow Node.js to exit if this is the only pending operation
    if (timer.unref) timer.unref()

    this.cache.set(key, { promise: promise as Promise<unknown>, timer })

    return promise
  }

  /** Exposed for testing — clear all entries */
  clear(): void {
    for (const { timer } of this.cache.values()) clearTimeout(timer)
    this.cache.clear()
  }
}
