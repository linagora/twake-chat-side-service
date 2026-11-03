import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Meet, type Participant } from './meet.ts'
import { startFake } from './testing.ts'
import { RefusedError, UpstreamError } from './upstream.ts'

const PARTICIPANT: Participant = {
  identity: '@alice:example.org:DEVICE',
  username: 'Alice',
  role: 'member'
}
const LIVEKIT_TOKEN = {
  status: 200,
  type: 'application/json',
  body: JSON.stringify({
    url: 'wss://livekit',
    room: 'meet-1',
    token: 'the-jwt'
  })
}

let livekitAnswer = LIVEKIT_TOKEN
let tokenStatus = 200
const seen: {
  path: string
  body: unknown
  authorization: string | undefined
}[] = []
let fake: Awaited<ReturnType<typeof startFake>>
let meet: Meet

beforeAll(async () => {
  fake = await startFake(app => {
    app.post('/*', (request, reply) => {
      const body = request.body as Record<string, string>
      seen.push({
        path: request.url,
        body,
        authorization: request.headers.authorization
      })
      if (request.url === '/external-api/v1.0/application/token/') {
        return tokenStatus === 200
          ? reply.send({ access_token: `token-of-${body.scope ?? ''}` })
          : reply.code(tokenStatus).send({ error: 'no' })
      }
      if (request.url === '/external-api/v1.0/rooms/') {
        return reply.code(201).send({ id: 'meet-1', slug: 'abc-defg-hij' })
      }
      return reply
        .code(livekitAnswer.status)
        .type(livekitAnswer.type)
        .send(livekitAnswer.body)
    })
  })
  meet = new Meet({
    url: fake.url,
    clientId: 'chat',
    clientSecret: 'meet-secret',
    serviceAccountEmail: 'calls@example.org'
  })
})

afterAll(() => fake.close())

beforeEach(() => {
  seen.length = 0
  livekitAnswer = LIVEKIT_TOKEN
  tokenStatus = 200
})

describe('Meet', () => {
  it('creates a restricted room as the service account, which any participant records', async () => {
    expect(await meet.createRoom()).toBe('meet-1')
    expect(seen).toEqual([
      {
        path: '/external-api/v1.0/application/token/',
        body: {
          client_id: 'chat',
          client_secret: 'meet-secret',
          grant_type: 'client_credentials',
          scope: 'calls@example.org'
        },
        authorization: undefined
      },
      {
        path: '/external-api/v1.0/rooms/',
        body: {
          access_level: 'restricted',
          configuration: { screen_recording_permission: 'authenticated' }
        },
        authorization: 'Bearer token-of-calls@example.org'
      }
    ])
  })

  it('asks the LiveKit token as the user', async () => {
    expect(
      await meet.livekitToken('meet-1', 'alice@example.org', PARTICIPANT)
    ).toEqual({ url: 'wss://livekit', token: 'the-jwt' })
    expect(seen[1]).toEqual({
      path: '/external-api/v1.0/rooms/meet-1/livekit-token/',
      body: PARTICIPANT,
      authorization: 'Bearer token-of-alice@example.org'
    })
  })

  it('tells a room Meet no longer has from a Meet without the route', async () => {
    livekitAnswer = {
      status: 404,
      type: 'application/json',
      body: '{"detail":"Not found."}'
    }
    expect(
      await meet.livekitToken('meet-1', 'alice@example.org', PARTICIPANT)
    ).toBeNull()

    // A room Meet deleted (suitenumerique/meet#1796)
    livekitAnswer = {
      status: 410,
      type: 'application/json',
      body: '{"detail":"This room has been deleted."}'
    }
    expect(
      await meet.livekitToken('meet-1', 'alice@example.org', PARTICIPANT)
    ).toBeNull()

    livekitAnswer = {
      status: 404,
      type: 'text/html',
      body: '<h1>Not Found</h1>'
    }
    await expect(
      meet.livekitToken('meet-1', 'alice@example.org', PARTICIPANT)
    ).rejects.toBeInstanceOf(UpstreamError)
  })

  it('fails on a refusal of Meet', async () => {
    livekitAnswer = {
      status: 400,
      type: 'application/json',
      body: '{"identity":["invalid"]}'
    }

    await expect(
      meet.livekitToken('meet-1', 'alice@example.org', PARTICIPANT)
    ).rejects.toBeInstanceOf(UpstreamError)
  })

  it('tells a user Meet will not act for from a failure of Meet', async () => {
    for (const status of [403, 404]) {
      tokenStatus = status
      await expect(
        meet.livekitToken('meet-1', 'alice@example.org', PARTICIPANT)
      ).rejects.toBeInstanceOf(RefusedError)
      // The service account refused is a misconfiguration, not the fault of the user
      await expect(meet.createRoom()).rejects.toBeInstanceOf(UpstreamError)
    }
    tokenStatus = 500
    await expect(
      meet.livekitToken('meet-1', 'alice@example.org', PARTICIPANT)
    ).rejects.toBeInstanceOf(UpstreamError)
  })
})
