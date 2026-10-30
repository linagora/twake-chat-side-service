import { pino } from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type AnalyticsDeps, registerAnalytics } from './analytics.ts'
import { RateLimit } from './assistants.ts'
import type { DirectoryEntry } from './directory.ts'
import { createServer } from './http.ts'

const ALICE = '@alice:example.org'
const NOW = Date.parse('2026-10-27T10:00:00Z')
const HEADERS = {
  authorization: 'Bearer openid',
  'x-matrix-server-name': 'example.org'
}
const EVENT = {
  name: 'message_sent',
  properties: { room_kind: 'direct', count: 2, nested: { a: 1 } },
  view: 'room',
  at: '2026-10-27T09:59:00Z'
}

const entry = (overrides: Partial<DirectoryEntry> = {}): DirectoryEntry => ({
  email: 'alice@example.org',
  twakeInstance: null,
  actorId: 'uuid-alice',
  org: 'acme123',
  ...overrides
})

function fakes() {
  return {
    serverName: 'example.org',
    openId: {
      userOf: vi.fn<(token: string) => Promise<string | null>>(() =>
        Promise.resolve(ALICE)
      )
    },
    directory: {
      entry: vi.fn<(uid: string) => Promise<DirectoryEntry>>(() =>
        Promise.resolve(entry())
      )
    },
    publisher: {
      publish: vi.fn<
        (
          routingKey: string,
          event: Record<string, unknown>,
          messageId: string
        ) => Promise<void>
      >(() => Promise.resolve())
    },
    rateLimit: new RateLimit(60, () => NOW),
    now: () => NOW
  } satisfies AnalyticsDeps
}

let deps = fakes()

function post(
  payload: unknown,
  overrides: Partial<AnalyticsDeps> = {},
  headers: Record<string, string> = HEADERS
) {
  const server = createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(true)
  })
  registerAnalytics(server, { ...deps, ...overrides })
  return server.inject({
    method: 'POST',
    url: '/analytics/events',
    headers,
    payload: payload as Record<string, unknown>
  })
}

const batch = (...events: unknown[]) => ({
  app: 'twake-chat',
  version: '1.2.3',
  events
})

beforeEach(() => {
  deps = fakes()
})

describe('POST /analytics/events', () => {
  it('refuses a request without a valid OpenID token', async () => {
    expect((await post(batch(EVENT), {}, {})).statusCode).toBe(401)

    deps.openId.userOf.mockResolvedValue(null)
    const response = await post(batch(EVENT))

    expect(response.statusCode).toBe(401)
    expect(deps.publisher.publish).not.toHaveBeenCalled()
  })

  it('refuses an invalid body', async () => {
    const bad = [
      {},
      { ...batch(EVENT), events: 'nope' },
      batch(...Array.from({ length: 201 }, () => EVENT))
    ]
    for (const payload of bad) {
      expect((await post(payload)).statusCode).toBe(400)
    }
    expect(deps.publisher.publish).not.toHaveBeenCalled()
  })

  it('drops a bad event and keeps the others of the batch', async () => {
    const response = await post(
      batch(
        { ...EVENT, name: 'Message-Sent' },
        { ...EVENT, at: '2026-10-27T09:59:00' },
        'nope',
        { ...EVENT, name: 'kept' }
      )
    )

    expect(response.statusCode).toBe(202)
    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
    })
    expect(deps.publisher.publish.mock.calls[0]?.[1]).toMatchObject({
      data: { action: 'kept' }
    })
  })

  it('publishes one CloudEvent per event, with the flat properties only', async () => {
    const response = await post(
      batch(EVENT, {
        name: 'app_opened',
        properties: { long: 'x'.repeat(201), ok: null },
        at: '2026-10-27T09:00:00+02:00'
      })
    )

    expect(response.statusCode).toBe(202)
    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(2)
    })
    const [type, event, messageId] = deps.publisher.publish.mock.calls[0] ?? []
    expect(type).toBe('com.twake.chat.user.active.v1')
    expect(event).toEqual({
      specversion: '1.0',
      id: messageId,
      source: 'twake://chat',
      type: 'com.twake.chat.user.active.v1',
      time: '2026-10-27T09:59:00Z',
      twakeactor: 'alice@example.org',
      twakeactorid: 'uuid-alice',
      twakeorg: 'acme123',
      data: {
        category: 'foreground',
        action: 'message_sent',
        platform: 'web',
        properties: {
          room_kind: 'direct',
          count: 2,
          view: 'room',
          appVersion: '1.2.3'
        }
      }
    })
    expect(deps.publisher.publish.mock.calls[1]?.[1]).toMatchObject({
      data: {
        properties: { long: 'x'.repeat(200), ok: null, appVersion: '1.2.3' }
      }
    })
  })

  it('leaves out the actor id and the organization the directory lacks', async () => {
    deps.directory.entry.mockResolvedValue(entry({ actorId: null, org: null }))
    await post(batch(EVENT))

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalled()
    })
    const event = deps.publisher.publish.mock.calls[0]?.[1]
    expect(event).not.toHaveProperty('twakeactorid')
    expect(event).not.toHaveProperty('twakeorg')
  })

  it('drops the events older than a day or ahead of the clock', async () => {
    await post(
      batch(
        { ...EVENT, at: '2026-10-26T09:59:00Z' },
        { ...EVENT, at: '2026-10-27T10:06:00Z' },
        { ...EVENT, name: 'kept', at: '2026-10-27T10:04:00Z' }
      )
    )

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
    })
    expect(deps.publisher.publish.mock.calls[0]?.[1]).toMatchObject({
      data: { action: 'kept' }
    })
  })

  it('publishes nothing for a bot', async () => {
    for (const bot of ['@bot_alice:example.org', '@hermes_demo:example.org']) {
      deps.openId.userOf.mockResolvedValue(bot)
      expect((await post(batch(EVENT))).statusCode).toBe(202)
    }

    expect(deps.directory.entry).not.toHaveBeenCalled()
    expect(deps.publisher.publish).not.toHaveBeenCalled()
  })

  it('publishes nothing for a user with no mail', async () => {
    deps.directory.entry.mockResolvedValue(entry({ email: null }))

    expect((await post(batch(EVENT))).statusCode).toBe(202)
    await vi.waitFor(() => {
      expect(deps.directory.entry).toHaveBeenCalledWith('alice')
    })
    expect(deps.publisher.publish).not.toHaveBeenCalled()
  })

  it('answers 202 and publishes nothing without a broker', async () => {
    const response = await post(batch(EVENT), { publisher: null })

    expect(response.statusCode).toBe(202)
    expect(deps.directory.entry).not.toHaveBeenCalled()
  })

  it('answers 202 when the broker or the directory fails', async () => {
    deps.publisher.publish.mockRejectedValue(new Error('down'))
    expect((await post(batch(EVENT))).statusCode).toBe(202)

    deps.directory.entry.mockRejectedValue(new Error('ldap down'))
    expect((await post(batch(EVENT))).statusCode).toBe(202)
  })

  it('limits the batches of each user, and only theirs', async () => {
    deps.rateLimit = new RateLimit(1, () => NOW)
    expect((await post(batch(EVENT))).statusCode).toBe(202)

    const limited = await post(batch(EVENT))
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBe('60')
    expect(limited.json()).toMatchObject({ errcode: 'M_LIMIT_EXCEEDED' })

    expect(deps.directory.entry).toHaveBeenCalledTimes(1)
    deps.openId.userOf.mockResolvedValue('@bob:example.org')
    expect((await post(batch(EVENT))).statusCode).toBe(202)
    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(2)
    })
  })

  it('counts the dropped events once a minute, though the broker never comes back', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    try {
      const lines: { msg: string; dropped?: number }[] = []
      const server = createServer({
        logger: pino(
          { level: 'warn' },
          {
            write: line =>
              void lines.push(JSON.parse(line) as (typeof lines)[number])
          }
        ),
        isReady: () => Promise.resolve(true)
      })
      // A broker down for good: no publish ever settles
      deps.publisher.publish.mockReturnValue(new Promise<void>(() => undefined))
      registerAnalytics(server, deps)
      const send = (count: number) =>
        server.inject({
          method: 'POST',
          url: '/analytics/events',
          headers: HEADERS,
          payload: batch(...Array.from({ length: count }, () => EVENT))
        })

      for (let i = 0; i < 5; i += 1) await send(200)
      await send(3)
      await send(2)
      await vi.waitFor(() => {
        expect(deps.publisher.publish).toHaveBeenCalledTimes(1000)
      })
      await new Promise(resolve => setImmediate(resolve))
      expect(lines).toEqual([])

      vi.advanceTimersByTime(60_000)
      expect(lines).toMatchObject([{ dropped: 5 }])
      vi.advanceTimersByTime(60_000)
      expect(lines).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers the preflight of the browsers', async () => {
    const server = createServer({
      logger: pino({ level: 'silent' }),
      isReady: () => Promise.resolve(true)
    })
    registerAnalytics(server, deps)
    const response = await server.inject({
      method: 'OPTIONS',
      url: '/analytics/events'
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('*')
  })
})
