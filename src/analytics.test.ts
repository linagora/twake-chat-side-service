import { pino } from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type AnalyticsDeps, registerAnalytics } from './analytics.ts'
import { RateLimit } from './assistants.ts'
import type { DirectoryEntry } from './directory.ts'
import { createServer } from './http.ts'

const ALICE = '@alice:example.org'
const NOW = Date.parse('2026-10-27T10:00:00Z')
/** One visit of a browser: a random UUID (v4). */
const VISIT = '3f2b8c1e-7d4a-4e9b-a6c2-1b5d9e0f7a83'
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

/** The directory must stay untouched: injected whether or not the dependency still exists. */
const directory = {
  entry: vi.fn<(uid: string) => Promise<DirectoryEntry>>(() =>
    Promise.resolve(entry())
  )
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
  registerAnalytics(server, {
    ...deps,
    directory,
    ...overrides
  } as AnalyticsDeps)
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

/** One service kept across several batches, with the warnings it logs. */
function service() {
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
  registerAnalytics(server, { ...deps, directory } as AnalyticsDeps)
  const send = (count: number) =>
    server.inject({
      method: 'POST',
      url: '/analytics/events',
      headers: HEADERS,
      payload: batch(...Array.from({ length: count }, () => EVENT))
    })
  return { lines, send, server }
}

beforeEach(() => {
  deps = fakes()
  directory.entry.mockReset()
  directory.entry.mockImplementation(() => Promise.resolve(entry()))
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
      data: {
        category: 'foreground',
        action: 'message_sent',
        platform: 'web',
        properties: {
          room_kind: 'direct',
          count: 2,
          view: 'room',
          appVersion: '1.2.3',
          deployment: 'example.org'
        }
      }
    })
    expect(deps.publisher.publish.mock.calls[1]?.[1]).toMatchObject({
      data: {
        properties: { long: 'x'.repeat(200), ok: null, appVersion: '1.2.3' }
      }
    })
  })

  it('publishes no actor, actor id, organization nor user id: the event alone', async () => {
    await post({ ...batch(EVENT), visit: VISIT })

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalled()
    })
    const event = deps.publisher.publish.mock.calls[0]?.[1] ?? {}
    for (const key of ['twakeactor', 'twakeactorid', 'twakeorg']) {
      expect(event).not.toHaveProperty(key)
    }
    // The homeserver is the deployment, said once; nothing else of the user
    const text = JSON.stringify(event).replace('"deployment":"example.org"', '')
    for (const trace of ['alice', 'example.org', 'uuid-alice', 'acme123']) {
      expect(text).not.toContain(trace)
    }
  })

  it('tells the deployment on every event: the homeserver the service serves', async () => {
    deps.openId.userOf.mockResolvedValue('@alice:tenant.example.org')
    await post(
      batch(EVENT, { ...EVENT, name: 'app_opened', properties: {} }),
      { serverName: 'tenant.example.org' },
      { ...HEADERS, 'x-matrix-server-name': 'tenant.example.org' }
    )

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(2)
    })
    for (const [, event] of deps.publisher.publish.mock.calls) {
      expect(event).toMatchObject({
        data: { properties: { deployment: 'tenant.example.org' } }
      })
    }
  })

  it('keeps the deployment of the server over a client property of that name', async () => {
    await post(
      batch({ ...EVENT, properties: { ...EVENT.properties, deployment: 'x' } })
    )

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
    })
    expect(deps.publisher.publish.mock.calls[0]?.[1]).toMatchObject({
      data: { properties: { deployment: 'example.org' } }
    })
  })

  it('puts the visit of the browser on every event of the batch', async () => {
    const response = await post({
      ...batch(EVENT, { ...EVENT, name: 'app_opened' }),
      visit: VISIT
    })

    expect(response.statusCode).toBe(202)
    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(2)
    })
    for (const [, event] of deps.publisher.publish.mock.calls) {
      expect(event).toMatchObject({ data: { visit: VISIT } })
    }
  })

  it('publishes without a visit when the batch has none', async () => {
    expect((await post(batch(EVENT))).statusCode).toBe(202)

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
    })
    expect(deps.publisher.publish.mock.calls[0]?.[1]).not.toHaveProperty(
      'data.visit'
    )
  })

  it('accepts a batch with an invalid visit and publishes it without one', async () => {
    const invalid = [
      'not-a-uuid',
      '',
      42,
      null,
      { id: VISIT },
      // A UUID, but not a random one (v1)
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      `${VISIT}x`
    ]
    for (const visit of invalid) {
      deps.publisher.publish.mockClear()
      const response = await post({ ...batch(EVENT), visit })

      expect(response.statusCode, JSON.stringify(visit)).toBe(202)
      await vi.waitFor(() => {
        expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
      })
      const event = deps.publisher.publish.mock.calls[0]?.[1]
      expect(event, JSON.stringify(visit)).not.toHaveProperty('data.visit')
      expect(event, JSON.stringify(visit)).toMatchObject({
        data: { action: 'message_sent' }
      })
    }
  })

  it('looks nobody up in the directory', async () => {
    await post(batch(EVENT))

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalled()
    })
    expect(directory.entry).not.toHaveBeenCalled()
  })

  it('publishes an event for a user the directory has no mail for', async () => {
    directory.entry.mockResolvedValue(entry({ email: null }))

    expect((await post(batch(EVENT))).statusCode).toBe(202)
    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
    })
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

  it('still publishes an event exactly a day old, or exactly five minutes ahead', async () => {
    await post(
      batch(
        { ...EVENT, name: 'day_old', at: '2026-10-26T10:00:00Z' },
        { ...EVENT, name: 'ahead', at: '2026-10-27T10:05:00Z' }
      )
    )

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(2)
    })
    expect(
      deps.publisher.publish.mock.calls.map(([, event]) => event)
    ).toMatchObject([
      { data: { action: 'day_old' } },
      { data: { action: 'ahead' } }
    ])
  })

  it('warns of a single dropped event, with its count', async () => {
    const { lines, server } = service()
    await server.inject({
      method: 'POST',
      url: '/analytics/events',
      headers: HEADERS,
      payload: batch('nope', EVENT)
    })

    expect(lines).toMatchObject([
      { msg: 'analytics events dropped', dropped: 1 }
    ])
  })

  it('publishes again once the backlog of the broker has drained', async () => {
    const { send } = service()
    for (let i = 0; i < 5; i += 1) await send(200)
    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1000)
    })
    await new Promise(resolve => setImmediate(resolve))

    await send(1)

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1001)
    })
  })

  it('counts only the events of a batch cut by a full backlog', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    try {
      deps.publisher.publish.mockReturnValue(new Promise<void>(() => undefined))
      const { lines, send } = service()
      for (let i = 0; i < 4; i += 1) await send(200)
      await send(199)
      await send(3)
      await vi.waitFor(() => {
        expect(deps.publisher.publish).toHaveBeenCalledTimes(1000)
      })

      vi.advanceTimersByTime(60_000)
      expect(lines).toMatchObject([{ dropped: 2 }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes nothing for a bot', async () => {
    for (const bot of ['@bot_alice:example.org', '@hermes_demo:example.org']) {
      deps.openId.userOf.mockResolvedValue(bot)
      expect((await post(batch(EVENT))).statusCode).toBe(202)
    }

    expect(directory.entry).not.toHaveBeenCalled()
    expect(deps.publisher.publish).not.toHaveBeenCalled()
  })

  it('answers 202 and publishes nothing without a broker', async () => {
    const response = await post(batch(EVENT), { publisher: null })

    expect(response.statusCode).toBe(202)
    expect(directory.entry).not.toHaveBeenCalled()
  })

  it('answers 202 when the broker fails', async () => {
    deps.publisher.publish.mockRejectedValue(new Error('down'))
    expect((await post(batch(EVENT))).statusCode).toBe(202)
  })

  it('answers 202 and publishes when the directory is down', async () => {
    directory.entry.mockRejectedValue(new Error('ldap down'))
    expect((await post(batch(EVENT))).statusCode).toBe(202)
    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
    })
  })

  it('limits the batches of each user, and only theirs', async () => {
    deps.rateLimit = new RateLimit(1, () => NOW)
    expect((await post(batch(EVENT))).statusCode).toBe(202)

    const limited = await post(batch(EVENT))
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBe('60')
    expect(limited.json()).toMatchObject({ errcode: 'M_LIMIT_EXCEEDED' })

    deps.openId.userOf.mockResolvedValue('@bob:example.org')
    expect((await post(batch(EVENT))).statusCode).toBe(202)
    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(2)
    })
  })

  it('counts the dropped events once a minute, though the broker never comes back', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    try {
      // A broker down for good: no publish ever settles
      deps.publisher.publish.mockReturnValue(new Promise<void>(() => undefined))
      const { lines, send } = service()

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

  it('publishes the platform the client says it runs on: desktop or mobile', async () => {
    for (const platform of ['desktop', 'mobile', 'web']) {
      deps.publisher.publish.mockClear()
      const response = await post({ ...batch(EVENT), platform })

      expect(response.statusCode, platform).toBe(202)
      await vi.waitFor(() => {
        expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
      })
      expect(deps.publisher.publish.mock.calls[0]?.[1], platform).toMatchObject(
        { data: { platform } }
      )
    }
  })

  it('puts the platform on every event of the batch', async () => {
    await post({
      ...batch(EVENT, { ...EVENT, name: 'app_opened' }),
      platform: 'mobile'
    })

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(2)
    })
    for (const [, event] of deps.publisher.publish.mock.calls) {
      expect(event).toMatchObject({ data: { platform: 'mobile' } })
    }
  })

  it('accepts a batch with an invalid platform and publishes it as web', async () => {
    const invalid = ['ios', 'android', 'WEB', 'Mobile', '', 42, null, {}]
    for (const platform of invalid) {
      deps.publisher.publish.mockClear()
      const response = await post({ ...batch(EVENT), platform })

      expect(response.statusCode, JSON.stringify(platform)).toBe(202)
      await vi.waitFor(() => {
        expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
      })
      expect(
        deps.publisher.publish.mock.calls[0]?.[1],
        JSON.stringify(platform)
      ).toMatchObject({ data: { action: 'message_sent', platform: 'web' } })
    }
  })

  it('answers the preflight of the browsers', async () => {
    const server = createServer({
      logger: pino({ level: 'silent' }),
      isReady: () => Promise.resolve(true)
    })
    registerAnalytics(server, { ...deps, directory } as AnalyticsDeps)
    const response = await server.inject({
      method: 'OPTIONS',
      url: '/analytics/events'
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('*')
  })
})

/**
 * The phone-home stats of Synapse (`report_stats_endpoint`): a POST of JSON every
 * 3 hours, without any authentication, so the secret is in the path. The route is
 * `POST /analytics/server-stats/:token`, served only when `SERVER_STATS_TOKEN` is
 * set (dependency `serverStatsToken`).
 */
describe('POST /analytics/server-stats/:token', () => {
  const TOKEN = 's3cr3t-0f-the-phone-home'
  /** 2026-10-27T10:00:00Z, in seconds as Synapse sends it. */
  const TIMESTAMP = NOW / 1000

  /** What Synapse sends (synapse/app/phone_stats_home.py). */
  const STATS = {
    homeserver: 'example.org',
    server_context: 'prod',
    timestamp: TIMESTAMP,
    uptime_seconds: 86_400,
    python_version: '3.12.4',
    total_users: 120,
    total_nonbridged_users: 110,
    daily_user_type_native: 40,
    daily_user_type_bridged: 2,
    daily_user_type_guest: 0,
    total_room_count: 300,
    daily_active_users: 42,
    monthly_active_users: 90,
    daily_active_e2ee_rooms: 12,
    daily_e2ee_messages: 500,
    daily_sent_e2ee_messages: 120,
    daily_active_rooms: 30,
    daily_messages: 800,
    daily_sent_messages: 200,
    r30v2_users_all: 70,
    r30v2_users_android: 10,
    r30v2_users_ios: 15,
    r30v2_users_electron: 5,
    r30v2_users_web: 40,
    cache_factor: 0.5,
    event_cache_size: 10_000,
    database_engine: 'psycopg2',
    database_server_version: '16.2',
    log_level: 'INFO',
    memory_rss: 512_000,
    cpu_average: 3
  }

  /** The usage counters published, with the deployment: nothing technical. */
  const COUNTERS = {
    total_users: 120,
    daily_user_type_native: 40,
    daily_user_type_bridged: 2,
    daily_user_type_guest: 0,
    total_room_count: 300,
    daily_active_users: 42,
    monthly_active_users: 90,
    daily_active_e2ee_rooms: 12,
    daily_e2ee_messages: 500,
    daily_sent_e2ee_messages: 120,
    daily_active_rooms: 30,
    daily_messages: 800,
    daily_sent_messages: 200,
    r30v2_users_all: 70,
    r30v2_users_android: 10,
    r30v2_users_ios: 15,
    r30v2_users_electron: 5,
    r30v2_users_web: 40
  }

  const TECHNICAL = [
    'server_context',
    'uptime_seconds',
    'python_version',
    'cache_factor',
    'event_cache_size',
    'database_engine',
    'database_server_version',
    'log_level',
    'memory_rss',
    'cpu_average',
    'homeserver',
    'timestamp'
  ]

  function report(
    payload: unknown,
    overrides: Record<string, unknown> = {},
    token: string = TOKEN
  ) {
    const server = createServer({
      logger: pino({ level: 'silent' }),
      isReady: () => Promise.resolve(true)
    })
    registerAnalytics(server, {
      ...deps,
      serverStatsToken: TOKEN,
      ...overrides
    })
    // Synapse sends no authorization header
    return server.inject({
      method: 'POST',
      url: `/analytics/server-stats/${token}`,
      payload: payload as Record<string, unknown>
    })
  }

  it('publishes the stats of the homeserver as one CloudEvent, and answers 202', async () => {
    const response = await report(STATS)

    expect(response.statusCode).toBe(202)
    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
    })
    const [type, event, messageId] = deps.publisher.publish.mock.calls[0] ?? []
    expect(type).toBe('com.twake.chat.user.active.v1')
    expect(event).toEqual({
      specversion: '1.0',
      id: messageId,
      source: 'twake://chat',
      type: 'com.twake.chat.user.active.v1',
      time: '2026-10-27T10:00:00.000Z',
      data: {
        category: 'background',
        action: 'server_stats_reported',
        properties: { ...COUNTERS, deployment: 'example.org' }
      }
    })
  })

  it('takes the time of the event from the timestamp of Synapse, in seconds', async () => {
    await report({ ...STATS, timestamp: TIMESTAMP - 3 * 3600 })

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
    })
    const event = deps.publisher.publish.mock.calls[0]?.[1] ?? {}
    expect(Date.parse(String(event.time))).toBe(NOW - 3 * 3_600_000)
  })

  it('publishes neither the technical fields nor any text', async () => {
    await report({
      ...STATS,
      daily_messages: '800',
      total_users: null,
      r30v2_users_web: { count: 40 }
    })

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
    })
    const properties = (deps.publisher.publish.mock.calls[0]?.[1]?.data ??
      {}) as { properties?: Record<string, unknown> }
    for (const key of [
      ...TECHNICAL,
      'daily_messages',
      'total_users',
      'r30v2_users_web'
    ]) {
      expect(properties.properties, key).not.toHaveProperty(key)
    }
    for (const [key, value] of Object.entries(properties.properties ?? {})) {
      if (key === 'deployment') continue
      expect(typeof value, key).toBe('number')
    }
  })

  it('publishes no field it does not know, numeric or not', async () => {
    await report({ ...STATS, daily_secret_counter: 7, admin_email: 'a@b.c' })

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
    })
    const event = deps.publisher.publish.mock.calls[0]?.[1] ?? {}
    expect(event).not.toHaveProperty('data.properties.daily_secret_counter')
    expect(event).not.toHaveProperty('data.properties.admin_email')
  })

  it('keeps the deployment of the service over a field of that name', async () => {
    await report({ ...STATS, deployment: 'elsewhere.org' })

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
    })
    expect(deps.publisher.publish.mock.calls[0]?.[1]).toMatchObject({
      data: { properties: { deployment: 'example.org' } }
    })
  })

  it('publishes no actor, no visit and no platform', async () => {
    await report(STATS)

    await vi.waitFor(() => {
      expect(deps.publisher.publish).toHaveBeenCalledTimes(1)
    })
    const event = deps.publisher.publish.mock.calls[0]?.[1] ?? {}
    for (const key of [
      'twakeactor',
      'twakeactorid',
      'twakeorg',
      'data.visit',
      'data.platform'
    ]) {
      expect(event, key).not.toHaveProperty(key)
    }
  })

  it('needs no OpenID token: Synapse sends none', async () => {
    expect((await report(STATS)).statusCode).toBe(202)
    expect(deps.openId.userOf).not.toHaveBeenCalled()
  })

  it('looks absent with a wrong or a missing token', async () => {
    for (const url of [
      '/analytics/server-stats/wrong',
      `/analytics/server-stats/${TOKEN}x`,
      '/analytics/server-stats/',
      '/analytics/server-stats'
    ]) {
      const server = createServer({
        logger: pino({ level: 'silent' }),
        isReady: () => Promise.resolve(true)
      })
      registerAnalytics(server, {
        ...deps,
        serverStatsToken: TOKEN
      })
      const response = await server.inject({
        method: 'POST',
        url,
        payload: STATS
      })

      expect(response.statusCode, url).toBe(404)
    }
    expect(deps.publisher.publish).not.toHaveBeenCalled()
  })

  it('looks absent when the deployment sets no token', async () => {
    for (const serverStatsToken of [undefined, null, '']) {
      const response = await report(STATS, { serverStatsToken })
      expect(response.statusCode, String(serverStatsToken)).toBe(404)
    }
    // Not even the empty token opens it
    expect((await report(STATS, { serverStatsToken: '' }, '')).statusCode).toBe(
      404
    )
    expect(deps.publisher.publish).not.toHaveBeenCalled()
  })

  it('refuses the stats of another homeserver', async () => {
    for (const homeserver of ['other.org', 'example.org.evil', undefined]) {
      const response = await report({ ...STATS, homeserver })
      expect(response.statusCode, String(homeserver)).toBe(403)
    }
    expect(deps.publisher.publish).not.toHaveBeenCalled()
  })

  it('answers 202 and publishes nothing without a broker', async () => {
    const response = await report(STATS, { publisher: null })

    expect(response.statusCode).toBe(202)
    expect(deps.publisher.publish).not.toHaveBeenCalled()
  })

  it('answers 202 when the broker fails', async () => {
    deps.publisher.publish.mockRejectedValue(new Error('down'))
    expect((await report(STATS)).statusCode).toBe(202)
  })

  /** Every line the service logs while it serves `url`, at every level. */
  async function logsOf(url: string, register = true) {
    const lines: string[] = []
    const server = createServer({
      logger: pino(
        { level: 'trace' },
        { write: (line: string) => lines.push(line) }
      ),
      isReady: () => Promise.resolve(true)
    })
    if (register)
      registerAnalytics(server, { ...deps, serverStatsToken: TOKEN })
    const response = await server.inject({
      method: 'POST',
      url,
      payload: STATS
    })
    return { status: response.statusCode, lines }
  }

  it('never writes the token in its logs', async () => {
    const { status, lines } = await logsOf(`/analytics/server-stats/${TOKEN}`)

    expect(status).toBe(202)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain(TOKEN)
    // The route stays recognisable in the logs
    expect(lines.some(line => line.includes('/analytics/server-stats'))).toBe(
      true
    )
  })

  it('never writes a wrong token in its logs either', async () => {
    const wrong = 'a-guess-that-is-almost-the-secret'
    const { status, lines } = await logsOf(`/analytics/server-stats/${wrong}`)

    expect(status).toBe(404)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain(wrong)
  })

  it('never writes the token when the deployment does not serve the route', async () => {
    const { status, lines } = await logsOf(
      `/analytics/server-stats/${TOKEN}`,
      false
    )

    expect(status).toBe(404)
    for (const line of lines) expect(line).not.toContain(TOKEN)
  })

  it('keeps the full url of the other routes in its logs', async () => {
    const { lines } = await logsOf('/analytics/elsewhere/kept-in-the-logs')

    expect(
      lines.some(line => line.includes('/analytics/elsewhere/kept-in-the-logs'))
    ).toBe(true)
  })
})
