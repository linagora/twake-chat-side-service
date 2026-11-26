import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Homeserver } from './homeserver.ts'
import { startFake } from './testing.ts'
import { UpstreamError } from './upstream.ts'

const ALICE = '@alice:example.org'
const ROOM = '!room:example.org'
const IS_JOINED = `/_matrix/client/unstable/io.element.msc4502/rooms/${ROOM}/is_joined`
const CREATE = `/_matrix/client/v3/rooms/${ROOM}/state/m.room.create/`
const POWER_LEVELS = `/_matrix/client/v3/rooms/${ROOM}/state/m.room.power_levels/`
const DISPLAY_NAME = `/_matrix/client/v3/profile/${ALICE}/displayname`
const DIRECT = `/_matrix/client/v3/user/${ALICE}/account_data/m.direct`
const JOINED_MEMBERS = `/_matrix/client/v3/rooms/${ROOM}/joined_members`

let answers: Record<string, () => { status: number; body: unknown }> = {}
const seen: {
  path: string
  query: Record<string, string>
  authorization: string | undefined
}[] = []
let fake: Awaited<ReturnType<typeof startFake>>
let homeserver: Homeserver

beforeAll(async () => {
  fake = await startFake(app => {
    app.get('/*', (request, reply) => {
      const url = new URL(request.url, 'http://fake')
      const path = decodeURIComponent(url.pathname)
      seen.push({
        path,
        query: Object.fromEntries(url.searchParams),
        authorization: request.headers.authorization
      })
      const answer = answers[path]?.() ?? {
        status: 404,
        body: { errcode: 'M_NOT_FOUND' }
      }
      return reply.code(answer.status).send(answer.body)
    })
  })
  homeserver = new Homeserver(fake.url, 'as-secret')
})

afterAll(() => fake.close())

beforeEach(() => {
  answers = {}
  seen.length = 0
})

const ok = (body: unknown) => () => ({ status: 200, body })

function room(
  version: string,
  sender: string,
  powerLevels: Record<string, unknown>,
  additionalCreators: string[] = []
) {
  answers[CREATE] = ok({
    type: 'm.room.create',
    sender,
    content: { room_version: version, additional_creators: additionalCreators }
  })
  answers[POWER_LEVELS] = ok({
    type: 'm.room.power_levels',
    content: powerLevels
  })
}

describe('Homeserver', () => {
  it('asks is_joined of MSC4502 with the as_token', async () => {
    answers[IS_JOINED] = ok({ joined: true })

    expect(await homeserver.isJoined(ROOM, ALICE)).toBe(true)
    expect(seen).toEqual([
      {
        path: IS_JOINED,
        query: { mxid: ALICE },
        authorization: 'Bearer as-secret'
      }
    ])
  })

  it('fails when is_joined fails, but takes a room id it refuses for no room', async () => {
    await expect(homeserver.isJoined(ROOM, ALICE)).rejects.toBeInstanceOf(
      UpstreamError
    )

    answers[IS_JOINED] = () => ({
      status: 400,
      body: { errcode: 'M_INVALID_PARAM' }
    })
    expect(await homeserver.isJoined(ROOM, ALICE)).toBe(false)
  })

  it('reads the state as the user, with the sender of the events', async () => {
    room('10', '@bob:example.org', {})
    await homeserver.isModerator(ROOM, ALICE)

    expect(seen.map(({ query }) => query)).toEqual([
      { user_id: ALICE, format: 'event' },
      { user_id: ALICE, format: 'event' }
    ])
  })

  it('makes a moderator of a power level of 50 or more, users_default included', async () => {
    const cases: [Record<string, unknown>, boolean][] = [
      [{ users: { [ALICE]: 50 } }, true],
      [{ users: { [ALICE]: 49 }, users_default: 100 }, false],
      [{ users_default: 50 }, true],
      [{}, false],
      // Rooms before version 10 may hold the level as a string
      [{ users: { [ALICE]: '50' } }, true]
    ]
    for (const [powerLevels, moderator] of cases) {
      room('9', '@bob:example.org', powerLevels)
      expect(await homeserver.isModerator(ROOM, ALICE)).toBe(moderator)
    }
  })

  it('makes a moderator of a creator from room version 12, not before', async () => {
    room('12', ALICE, {})
    expect(await homeserver.isModerator(ROOM, ALICE)).toBe(true)

    room('11', ALICE, {})
    expect(await homeserver.isModerator(ROOM, ALICE)).toBe(false)

    room('12', '@bob:example.org', {}, [ALICE])
    expect(await homeserver.isModerator(ROOM, ALICE)).toBe(true)
  })

  it('makes a moderator of the creator of a room without power levels', async () => {
    room('9', ALICE, {})
    Reflect.deleteProperty(answers, POWER_LEVELS)
    expect(await homeserver.isModerator(ROOM, ALICE)).toBe(true)

    room('9', '@bob:example.org', {})
    Reflect.deleteProperty(answers, POWER_LEVELS)
    expect(await homeserver.isModerator(ROOM, ALICE)).toBe(false)
  })

  it('reads the display name as the user, null without one', async () => {
    answers[DISPLAY_NAME] = ok({ displayname: 'Alice' })
    expect(await homeserver.displayName(ALICE)).toBe('Alice')
    expect(seen[0]?.query).toEqual({ user_id: ALICE })

    answers = {}
    expect(await homeserver.displayName(ALICE)).toBeNull()
  })

  it('reads the direct rooms of m.direct as the user, none without it', async () => {
    answers[DIRECT] = ok({
      '@bob:example.org': [ROOM, '!older:example.org'],
      '@carol:example.org': ['!other:example.org'],
      '@odd:example.org': 'no list'
    })
    expect(await homeserver.directRooms(ALICE)).toEqual(
      new Set([ROOM, '!older:example.org', '!other:example.org'])
    )
    expect(seen[0]?.query).toEqual({ user_id: ALICE })

    answers = {}
    expect(await homeserver.directRooms(ALICE)).toEqual(new Set())
  })

  it('takes a refusal of the homeserver for no room, but not a failure', async () => {
    // A user the homeserver has no account of
    answers[DIRECT] = () => ({ status: 403, body: { errcode: 'M_FORBIDDEN' } })
    expect(await homeserver.directRooms(ALICE)).toEqual(new Set())
    answers[JOINED_MEMBERS] = () => ({ status: 400, body: {} })
    expect(await homeserver.joinedMembers(ROOM, ALICE)).toBeNull()

    // The as_token, a rate limit and an error end without the request changing
    for (const status of [401, 429, 500]) {
      answers[DIRECT] = () => ({ status, body: {} })
      answers[JOINED_MEMBERS] = () => ({ status, body: {} })
      await expect(homeserver.directRooms(ALICE)).rejects.toBeInstanceOf(
        UpstreamError
      )
      await expect(
        homeserver.joinedMembers(ROOM, ALICE)
      ).rejects.toBeInstanceOf(UpstreamError)
    }
  })

  it('reads the joined members as the user, null when the homeserver refuses', async () => {
    answers[JOINED_MEMBERS] = ok({
      joined: { [ALICE]: { display_name: 'Alice' }, '@bob:example.org': {} }
    })
    expect(await homeserver.joinedMembers(ROOM, ALICE)).toEqual([
      ALICE,
      '@bob:example.org'
    ])
    expect(seen[0]?.query).toEqual({ user_id: ALICE })

    answers[JOINED_MEMBERS] = () => ({
      status: 403,
      body: { errcode: 'M_FORBIDDEN' }
    })
    expect(await homeserver.joinedMembers(ROOM, ALICE)).toBeNull()

    answers[JOINED_MEMBERS] = () => ({ status: 500, body: {} })
    await expect(homeserver.joinedMembers(ROOM, ALICE)).rejects.toBeInstanceOf(
      UpstreamError
    )
  })
})
