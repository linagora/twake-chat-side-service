/**
 * Values kept for a time, the oldest dropped past `maxEntries`: what one replica remembers
 * of the homeserver and the directory between two events.
 */
export class TtlCache<V> {
  #entries = new Map<string, { value: V; expiresAt: number }>()
  #ttlMs: number
  #maxEntries: number
  #now: () => number

  constructor(ttlMs: number, maxEntries: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs
    this.#maxEntries = maxEntries
    this.#now = now
  }

  /** The value, or `undefined` when none is kept: `null` is a value like another. */
  get(key: string): V | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: V): this {
    // Deleted first: a Map keeps the order of the first insertion
    this.#entries.delete(key)
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs })
    if (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done !== true) this.#entries.delete(oldest.value)
    }
    return this
  }

  delete(key: string): boolean {
    return this.#entries.delete(key)
  }
}
