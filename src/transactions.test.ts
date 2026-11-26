import { pino } from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from './http.ts'
import { registerTransactions } from './transactions.ts'
import { UpstreamError } from './upstream.ts'

const HEADERS = { authorization: 'Bearer hs-secret' }

const activity = {
  publish: vi.fn<(event: unknown) => Promise<number>>(() => Promise.resolve(0))
}

let server = createServer({
  logger: pino({ level: 'silent' }),
  isReady: () => Promise.resolve(true)
})

function put(
  txnId: string,
  payload: unknown,
  headers: Record<string, string> = HEADERS
) {
  return server.inject({
    method: 'PUT',
    url: `/_matrix/app/v1/transactions/${txnId}`,
    headers,
    payload: payload as Record<string, unknown>
  })
}

beforeEach(() => {
  activity.publish.mockReset()
  activity.publish.mockImplementation(() => Promise.resolve(0))
  server = createServer({
    logger: pino({ level: 'silent' }),
    isReady: () => Promise.resolve(true)
  })
  registerTransactions(server, { hsToken: 'hs-secret', activity })
})

describe('PUT /_matrix/app/v1/transactions/{txnId}', () => {
  it('refuses a request without the hs_token', async () => {
    const missing = await put('1', { events: [] }, {})
    expect(missing.statusCode).toBe(401)
    expect(missing.json()).toMatchObject({ errcode: 'M_UNAUTHORIZED' })

    for (const authorization of ['Bearer other', 'Bearer hs-secret2']) {
      const wrong = await put('1', { events: [{}] }, { authorization })
      expect(wrong.statusCode).toBe(403)
      expect(wrong.json()).toMatchObject({ errcode: 'M_FORBIDDEN' })
    }
    expect(activity.publish).not.toHaveBeenCalled()
  })

  it('refuses a body without events', async () => {
    const response = await put('1', { pdus: [] })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ errcode: 'M_BAD_JSON' })
  })

  it('hands each event to the activity, in order', async () => {
    const response = await put('1', { events: [{ n: 1 }, 'odd', { n: 2 }] })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({})
    expect(activity.publish.mock.calls).toEqual([
      [{ n: 1 }],
      ['odd'],
      [{ n: 2 }]
    ])
  })

  it('handles a transaction sent again once only', async () => {
    await put('1', { events: [{ n: 1 }] })
    const again = await put('1', { events: [{ n: 1 }] })
    await put('2', { events: [{ n: 2 }] })

    expect(again.statusCode).toBe(200)
    expect(activity.publish).toHaveBeenCalledTimes(2)
  })

  it('answers 502 when a service failed, and handles the transaction again', async () => {
    activity.publish
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new UpstreamError('broker', 'down'))

    const failed = await put('1', { events: [{ n: 1 }, { n: 2 }, { n: 3 }] })
    expect(failed.statusCode).toBe(502)
    expect(activity.publish).toHaveBeenCalledTimes(2)

    const again = await put('1', { events: [{ n: 1 }, { n: 2 }, { n: 3 }] })
    expect(again.statusCode).toBe(200)
    expect(activity.publish).toHaveBeenCalledTimes(5)
  })
})

describe('what must never block the events of the homeserver', () => {
  const raw = (payload: string, headers: Record<string, string> = HEADERS) =>
    server.inject({
      method: 'PUT',
      url: '/_matrix/app/v1/transactions/1',
      headers: { ...headers, 'content-type': 'application/json' },
      payload
    })

  it('takes an event with a __proto__ or constructor key, the key apart', async () => {
    const response = await raw(
      '{"events":[{"content":{"body":"x","__proto__":{"a":1},"constructor":{"prototype":{}}}}]}'
    )

    expect(response.statusCode).toBe(200)
    expect(activity.publish).toHaveBeenCalledTimes(1)
    const [event] = activity.publish.mock.calls[0] ?? []
    expect(JSON.stringify(event)).toBe(
      '{"content":{"body":"x","constructor":{"prototype":{}}}}'
    )
    expect(({} as Record<string, unknown>).a).toBeUndefined()
  })

  it('skips an event that fails for another reason than a service', async () => {
    activity.publish
      .mockRejectedValueOnce(new RangeError('Invalid time value'))
      .mockResolvedValueOnce(1)

    const response = await put('1', { events: [{ n: 1 }, { n: 2 }] })

    expect(response.statusCode).toBe(200)
    expect(activity.publish).toHaveBeenCalledTimes(2)
  })

  it('reads no body before the hs_token is checked', async () => {
    expect((await raw('{"events":', {})).statusCode).toBe(401)
    expect(
      (await raw('{"events":', { authorization: 'Bearer other' })).statusCode
    ).toBe(403)
    expect((await raw('{"events":')).statusCode).toBe(400)
  })
})
