import { TimeoutError } from './types'

/**
 * Races fn() against a timeout.
 * Uses AbortController so downstream consumers can opt into cancellation.
 * The abort signal is passed as an optional argument — fn() can ignore it
 * if not relevant (e.g. a pure in-memory operation).
 */
export async function withTimeout<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new TimeoutError(timeoutMs))
    }, timeoutMs)
    // allow Node.js to exit if this is the only pending operation
    if (timer.unref) timer.unref()
  })

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise])
  } finally {
    clearTimeout(timer!)
    controller.abort()
  }
}
