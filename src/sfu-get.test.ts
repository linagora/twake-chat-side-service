import { pino } from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectoryEntry } from './directory.ts'
import { createServer } from './http.ts'
import type { CallToken, Participant } from './meet.ts'
import { registerSfuGet, type SfuDeps } from './sfu-get.ts'
import { RefusedError, UpstreamError } from './upstream.ts'

const ALICE = '@alice:example.org'
const ROOM = '!room:example.org'
const OPENID = {
  access_token: 'openid',
  token_type: 'Bearer',
  matrix_server_name: 'example.org',
  expires_in: 3600
}
const BODY = { room: ROOM, openid_token: OPENID, device_id: 'DEVICE' }
const TOKEN: CallToken = { url: 'wss://livekit.example.org', token: 'the-jwt' }

function fakes() {
  const links = new Map<string, string>()
  let rooms = 0
  return {
    serverName: 'example.org',
    openId: {
      userOf: vi.fn<(token: string) => Promise<string | null>>(() =>
        Promise.resolve(ALICE)
      )
    },
    homeserver: {
      isJoined: vi.fn<(room: string, user: string) => Promise<boolean>>(() =>
        Promise.resolve(true)
      ),
      isModerator: vi.fn<(room: string, user: string) => Promise<boolean>>(() =>
        Promise.resolve(false)
      ),
      displayName: vi.fn<(user: string) => Promise<string | null>>(() =>
        Promise.resolve('Alice')
      )
    },
    directory: {
      entry: vi.fn<(uid: string) => Promise<DirectoryEntry>>(() =>
        Promise.resolve({
          email: 'alice@example.org',
          twakeInstance: 'https://alice.example.org',
          actorId: null,
          org: null
        })
      )
    },
    meet: {
      createRoom: vi.fn(() => Promise.resolve(`meet-${String(++rooms)}`)),
      livekitToken: vi.fn<
        (
          room: string,
          email: string,
          participant: Participant
        ) => Promise<CallToken | null>
      >(() => Promise.resolve(TOKEN))
    },
    callRooms: {
      ensure: vi.fn(async (roomId: string, create: () => Promise<string>) => {
        const known = links.get(roomId) ?? (await create())
        links.set(roomId, known)
        return known
      }),
      forget: vi.fn((roomId: string, meetRoomId: string) => {
        if (links.get(roomId) === meetRoomId) links.delete(roomId)
        return Promise.resolve()
      })
    }
  } satisfies SfuDeps
}

let deps = fakes()

function app(deadlineMs?: number, logger = pino({ level: 'silent' })) {
  const server = createServer({
    logger,
    isReady: () => Promise.resolve(true)
  })
  registerSfuGet(server, deps, deadlineMs === undefined ? {} : { deadlineMs })
  return server
}

async function ask(body: unknown) {
  return app().inject({
    method: 'POST',
    url: '/sfu/get',
    headers: { 'content-type': 'application/json' },
    payload: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

async function refusal(body: unknown) {
  const response = await ask(body)
  return [response.statusCode, response.json<{ errcode: string }>().errcode]
}

const participants = () =>
  deps.meet.livekitToken.mock.calls.map(([, , participant]) => participant)

beforeEach(() => {
  deps = fakes()
})

describe('POST /sfu/get', () => {
  it('answers the LiveKit server and the token Meet minted for the device', async () => {
    const response = await ask(BODY)

    expect([response.statusCode, response.json()]).toEqual([
      200,
      { url: 'wss://livekit.example.org', jwt: 'the-jwt' }
    ])
    expect(response.headers['access-control-allow-origin']).toBe('*')
    expect(deps.openId.userOf).toHaveBeenCalledWith('openid')
    expect(deps.homeserver.isJoined).toHaveBeenCalledWith(ROOM, ALICE)
    expect(deps.directory.entry).toHaveBeenCalledWith('alice')
    expect(deps.meet.livekitToken).toHaveBeenCalledWith(
      'meet-1',
      'alice@example.org',
      {
        identity: '@alice:example.org:DEVICE',
        username: 'Alice',
        role: 'member',
        twake_instance: 'https://alice.example.org'
      }
    )
  })

  it('answers the preflight of the browsers', async () => {
    const response = await app().inject({ method: 'OPTIONS', url: '/sfu/get' })

    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-headers']).toBe(
      'content-type'
    )
  })

  it('keeps one Meet room per Matrix room', async () => {
    await ask(BODY)
    await ask({ ...BODY, device_id: 'OTHER' })
    await ask({ ...BODY, room: '!other:example.org' })

    expect(deps.meet.createRoom).toHaveBeenCalledTimes(2)
    expect(deps.meet.livekitToken.mock.calls.map(([room]) => room)).toEqual([
      'meet-1',
      'meet-1',
      'meet-2'
    ])
  })

  it('makes a moderator an administrator, and a member when the role cannot be read', async () => {
    deps.homeserver.isModerator.mockResolvedValueOnce(true)
    await ask(BODY)
    deps.homeserver.isModerator.mockRejectedValueOnce(
      new UpstreamError('homeserver', 'down')
    )
    expect((await ask(BODY)).statusCode).toBe(200)

    expect(participants().map(({ role }) => role)).toEqual([
      'administrator',
      'member'
    ])
  })

  it('names the participant by the localpart without a display name, at most 255 characters', async () => {
    deps.homeserver.displayName.mockResolvedValueOnce(null)
    await ask(BODY)
    deps.homeserver.displayName.mockResolvedValueOnce('   ')
    await ask(BODY)
    deps.homeserver.displayName.mockResolvedValueOnce('é'.repeat(300))
    await ask(BODY)

    expect(participants().map(({ username }) => username)).toEqual([
      'alice',
      'alice',
      'é'.repeat(255)
    ])
  })

  it('leaves the Twake instance out when the directory has none', async () => {
    deps.directory.entry.mockResolvedValueOnce({
      email: 'alice@example.org',
      twakeInstance: null,
      actorId: null,
      org: null
    })
    await ask(BODY)

    expect(participants()[0]).not.toHaveProperty('twake_instance')
  })

  it('replaces a Meet room that Meet no longer has, once', async () => {
    deps.meet.livekitToken.mockResolvedValueOnce(null)
    const response = await ask(BODY)

    expect(response.json()).toEqual({
      url: 'wss://livekit.example.org',
      jwt: 'the-jwt'
    })
    expect(deps.callRooms.forget).toHaveBeenCalledWith(ROOM, 'meet-1')
    expect(deps.meet.livekitToken.mock.calls.map(([room]) => room)).toEqual([
      'meet-1',
      'meet-2'
    ])
  })

  it('refuses a request of the wrong shape, before asking anyone', async () => {
    const bodies = [
      '[]',
      { ...BODY, room: undefined },
      { ...BODY, room: '#alias:example.org' },
      { ...BODY, openid_token: undefined },
      { ...BODY, openid_token: { ...OPENID, access_token: '' } },
      { ...BODY, openid_token: { ...OPENID, matrix_server_name: 1 } },
      { ...BODY, device_id: undefined },
      { ...BODY, device_id: 'A:B' },
      { ...BODY, device_id: 'DEV ICE' },
      { ...BODY, device_id: 'D'.repeat(129) },
      { ...BODY, room: `!${'r'.repeat(255)}` },
      { ...BODY, openid_token: { ...OPENID, access_token: 't'.repeat(256) } }
    ]
    for (const body of bodies) {
      expect(await refusal(body)).toEqual([400, 'M_INVALID_PARAM'])
    }
    const notJson = await ask('{')
    expect([
      notJson.statusCode,
      notJson.json<{ errcode: string }>().errcode,
      notJson.headers['access-control-allow-origin']
    ]).toEqual([400, 'M_NOT_JSON', '*'])
    expect(deps.openId.userOf).not.toHaveBeenCalled()
  })

  it('logs who asked for which room, never the OpenID token', async () => {
    const lines: Record<string, unknown>[] = []
    const logger = pino(
      { level: 'info' },
      {
        write: (line: string) => {
          lines.push(JSON.parse(line) as Record<string, unknown>)
        }
      }
    )
    deps.homeserver.isJoined.mockResolvedValueOnce(false)
    await app(undefined, logger).inject({
      method: 'POST',
      url: '/sfu/get',
      payload: BODY
    })

    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: 'token refused',
        user: ALICE,
        room: ROOM,
        reason: 'Not joined to the room'
      })
    )
    expect(JSON.stringify(lines)).not.toContain(OPENID.access_token + '"')
  })

  it('names the body when it is not an object', async () => {
    expect((await ask('[]')).json()).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'Invalid body'
    })
  })

  it('refuses the users of another homeserver, before asking it anything', async () => {
    expect(
      await refusal({
        ...BODY,
        openid_token: { ...OPENID, matrix_server_name: 'other.org' }
      })
    ).toEqual([403, 'M_FORBIDDEN'])
    expect(deps.openId.userOf).not.toHaveBeenCalled()
  })

  it('refuses a token the homeserver rejects, or one of a user of another homeserver', async () => {
    deps.openId.userOf.mockResolvedValueOnce(null)
    expect(await refusal(BODY)).toEqual([401, 'M_UNKNOWN_TOKEN'])

    deps.openId.userOf.mockResolvedValueOnce('@alice:other.org')
    expect(await refusal(BODY)).toEqual([403, 'M_FORBIDDEN'])
    expect(deps.homeserver.isJoined).not.toHaveBeenCalled()
  })

  it('refuses an identity longer than Meet takes', async () => {
    deps.openId.userOf.mockResolvedValueOnce(`@${'a'.repeat(200)}:example.org`)

    expect(await refusal({ ...BODY, device_id: 'D'.repeat(60) })).toEqual([
      400,
      'M_INVALID_PARAM'
    ])
  })

  it('refuses a user who is not joined to the room, before asking Meet', async () => {
    deps.homeserver.isJoined.mockResolvedValueOnce(false)

    expect(await refusal(BODY)).toEqual([403, 'M_FORBIDDEN'])
    expect(deps.meet.createRoom).not.toHaveBeenCalled()
    expect(deps.meet.livekitToken).not.toHaveBeenCalled()
  })

  it('refuses a user without a single email in the directory, or one Meet will not act for', async () => {
    deps.directory.entry.mockResolvedValueOnce({
      email: null,
      twakeInstance: null,
      actorId: null,
      org: null
    })
    expect(await refusal(BODY)).toEqual([403, 'M_FORBIDDEN'])
    expect(deps.meet.livekitToken).not.toHaveBeenCalled()

    deps.meet.livekitToken.mockRejectedValueOnce(
      new RefusedError('Meet refuses to act for this user (403)')
    )
    expect(await refusal(BODY)).toEqual([403, 'M_FORBIDDEN'])
  })

  it('answers 502 when the homeserver, the directory, the database or Meet fails', async () => {
    deps.openId.userOf.mockRejectedValueOnce(
      new UpstreamError('homeserver', 'down')
    )
    expect(await refusal(BODY)).toEqual([502, 'M_UNKNOWN'])

    deps.directory.entry.mockRejectedValueOnce(
      new UpstreamError('directory', 'down')
    )
    expect(await refusal(BODY)).toEqual([502, 'M_UNKNOWN'])

    deps.meet.livekitToken.mockResolvedValue(null)
    expect(await refusal(BODY)).toEqual([502, 'M_UNKNOWN'])
  })

  it('answers 502 before the client gives up', async () => {
    deps.openId.userOf.mockReturnValueOnce(new Promise(() => undefined))
    const response = await app(20).inject({
      method: 'POST',
      url: '/sfu/get',
      payload: BODY
    })

    expect(response.statusCode).toBe(502)
    expect(response.headers['access-control-allow-origin']).toBe('*')
  })

  it('answers a bug with a bare 500, still to any origin', async () => {
    deps.homeserver.isJoined.mockRejectedValueOnce(new TypeError('bug'))
    const response = await ask(BODY)

    expect([response.statusCode, response.json()]).toEqual([
      500,
      { errcode: 'M_UNKNOWN', error: 'Internal error' }
    ])
    expect(response.headers['access-control-allow-origin']).toBe('*')
  })
})
