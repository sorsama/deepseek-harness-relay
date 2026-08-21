/**
 * Per-address request throttling and sign-in lockout.
 *
 * Both are keyed by source address and held in memory only: they are abuse
 * controls, not durable policy, and losing them on restart is correct — the
 * credentials themselves are what survive.
 * @module dsh-relay/auth/ratelimit
 */

/** One address's live counters. */
interface Counters {
  /** Request timestamps inside the current window, oldest first. */
  requests: number[]
  /** Consecutive failed sign-ins. */
  failures: number
  /** Epoch millis until which sign-in is refused outright. */
  lockedUntil: number
}

/** How long an idle address's counters are kept before being dropped. */
const IDLE_EVICTION_MS = 3_600_000

/** Window the request rate is measured over. */
const WINDOW_MS = 60_000

/**
 * Request and sign-in throttles, keyed by source address.
 *
 * The eviction sweep is the only timer; the caller owns it through
 * {@link dispose} so a plugin unload leaves nothing running.
 */
export class Throttle {
  readonly #addresses = new Map<string, Counters>()
  readonly #sweep: NodeJS.Timeout

  /**
   * @param limits.requestsPerMinute - requests one address may make per minute.
   * @param limits.maxFailures - failed sign-ins before lockout.
   * @param limits.lockoutMs - how long a lockout lasts.
   */
  constructor(private readonly limits: {
    readonly requestsPerMinute: number
    readonly maxFailures: number
    readonly lockoutMs: number
  }) {
    this.#sweep = setInterval(() => { this.#evict() }, IDLE_EVICTION_MS)
    this.#sweep.unref()
  }

  /**
   * Counters for one address, created on first sight.
   * @param address - normalized source address.
   * @returns the live counters.
   */
  #for(address: string): Counters {
    let counters = this.#addresses.get(address)
    if (counters === undefined) {
      counters = { requests: [], failures: 0, lockedUntil: 0 }
      this.#addresses.set(address, counters)
    }
    return counters
  }

  /**
   * Record one request and report whether it exceeds the rate limit.
   * @param address - normalized source address.
   * @param now - current epoch millis.
   * @returns true when the request is over the limit and must be refused.
   */
  exceedsRate(address: string, now: number): boolean {
    const counters = this.#for(address)
    const cutoff = now - WINDOW_MS
    while (counters.requests.length > 0 && counters.requests[0]! <= cutoff) counters.requests.shift()
    counters.requests.push(now)
    return counters.requests.length > this.limits.requestsPerMinute
  }

  /**
   * Whether sign-in from this address is currently locked out.
   * @param address - normalized source address.
   * @param now - current epoch millis.
   * @returns epoch millis the lockout ends, or undefined when not locked.
   */
  lockedUntil(address: string, now: number): number | undefined {
    const counters = this.#addresses.get(address)
    if (counters === undefined || counters.lockedUntil <= now) return undefined
    return counters.lockedUntil
  }

  /**
   * Record a failed sign-in, locking the address out at the threshold.
   * @param address - normalized source address.
   * @param now - current epoch millis.
   */
  recordFailure(address: string, now: number): void {
    const counters = this.#for(address)
    counters.failures += 1
    if (counters.failures >= this.limits.maxFailures) {
      counters.failures = 0
      counters.lockedUntil = now + this.limits.lockoutMs
    }
  }

  /**
   * Clear the failure counter after a successful sign-in.
   * @param address - normalized source address.
   */
  recordSuccess(address: string): void {
    const counters = this.#addresses.get(address)
    if (counters === undefined) return
    counters.failures = 0
    counters.lockedUntil = 0
  }

  /** Drop counters for addresses that have gone quiet. */
  #evict(): void {
    const cutoff = Date.now() - IDLE_EVICTION_MS
    for (const [address, counters] of this.#addresses) {
      const lastRequest = counters.requests.at(-1) ?? 0
      if (lastRequest <= cutoff && counters.lockedUntil <= Date.now()) this.#addresses.delete(address)
    }
  }

  /** Stop the eviction sweep and drop every counter. */
  dispose(): void {
    clearInterval(this.#sweep)
    this.#addresses.clear()
  }
}
