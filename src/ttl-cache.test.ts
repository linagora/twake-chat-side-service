import { describe, expect, it } from 'vitest'
import { TtlCache } from './ttl-cache.ts'

describe('TtlCache', () => {
  it('keeps a value for its time only', () => {
    let now = 1000
    const cache = new TtlCache<string | null>(500, 10, () => now)
    cache.set('a', 'kept').set('none', null)

    now = 1499
    expect(cache.get('a')).toBe('kept')
    expect(cache.get('none')).toBeNull()
    expect(cache.get('unknown')).toBeUndefined()

    now = 1500
    expect(cache.get('a')).toBeUndefined()
  })

  it('drops the oldest value past its size', () => {
    const cache = new TtlCache<number>(500, 2, () => 0)
    cache.set('a', 1).set('b', 2)
    // Set again: « a » is now the latest
    cache.set('a', 3).set('c', 4)

    expect(cache.get('a')).toBe(3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBe(4)
  })

  it('forgets a value on request', () => {
    const cache = new TtlCache<number>(500, 2, () => 0)
    cache.set('a', 1)

    expect(cache.delete('a')).toBe(true)
    expect(cache.get('a')).toBeUndefined()
  })
})
