import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ActivityDeps,
  activityEvents,
  activityId,
  ChatActivity,
  mentionedUsers,
  MESSAGE_CREATED,
  MESSAGE_MENTIONED
} from './activity.ts'
import type { DirectoryEntry } from './directory.ts'
import { UpstreamError } from './upstream.ts'

const ALICE = '@alice:example.org'
const BOB = '@bob:example.org'
const CAROL = '@carol:example.org'
const REMOTE = '@dave:elsewhere.org'
const ROOM = '!room:example.org'
const EVENT_ID = '$event'
const SENT_AT = Date.parse('2026-11-26T10:00:00Z')
const NOW = Date.parse('2026-11-26T10:00:05Z')

const UUIDS: Record<string, string> = {
  alice: '11111111-1111-4111-8111-111111111111',
  bob: '22222222-2222-4222-8222-222222222222',
  carol: '33333333-3333-4333-8333-333333333333'
}

const entry = (overrides: Partial<DirectoryEntry> = {}): DirectoryEntry => ({
  email: null,
  twakeInstance: null,
  actorId: null,
  org: null,
  ...overrides
})

let now = NOW
let members: Record<string, string[]> = {}
let direct: Record<string, string[]> = {}
let orgs: Record<string, string | null> = {}

function fakes() {
  return {
    serverName: 'example.org',
    homeserver: {
      joinedMembers: vi.fn<
        (roomId: string, userId: string) => Promise<string[] | null>
      >(roomId =>
        // As Synapse answers an application service: the members, whoever asks
        Promise.resolve(members[roomId] ?? null)
      ),
      directRooms: vi.fn<(userId: string) => Promise<Set<string>>>(userId =>
        Promise.resolve(new Set(direct[userId] ?? []))
      )
    },
    directory: {
      entry: vi.fn<(uid: string) => Promise<DirectoryEntry>>(uid =>
        Promise.resolve(
          entry({ actorId: UUIDS[uid] ?? null, org: orgs[uid] ?? null })
        )
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
    now: () => now
  } satisfies ActivityDeps
}

let deps = fakes()
let activity = new ChatActivity(deps)

const text = (overrides: Record<string, unknown> = {}) => ({
  type: 'm.room.message',
  event_id: EVENT_ID,
  room_id: ROOM,
  sender: ALICE,
  origin_server_ts: SENT_AT,
  content: { msgtype: 'm.text', body: 'never published', 'm.mentions': {} },
  ...overrides
})

const mentioning = (...userIds: unknown[]) =>
  text({
    content: {
      msgtype: 'm.text',
      body: 'x',
      'm.mentions': { user_ids: userIds }
    }
  })

const published = () =>
  deps.publisher.publish.mock.calls.map(([routingKey, event, messageId]) => ({
    routingKey,
    event,
    messageId
  }))

beforeEach(() => {
  now = NOW
  members = { [ROOM]: [ALICE, BOB] }
  direct = { [ALICE]: [ROOM] }
  orgs = {}
  deps = fakes()
  activity = new ChatActivity(deps)
})

describe('activityId', () => {
  it('gives the same UUID for the same event, type and organization', () => {
    const id = activityId(EVENT_ID, MESSAGE_CREATED, 'acme')

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(activityId(EVENT_ID, MESSAGE_CREATED, 'acme')).toBe(id)
    expect(activityId(EVENT_ID, MESSAGE_MENTIONED, 'acme')).not.toBe(id)
    expect(activityId(EVENT_ID, MESSAGE_CREATED, null)).not.toBe(id)
    expect(activityId('$other', MESSAGE_CREATED, 'acme')).not.toBe(id)
  })
})

describe('mentionedUsers', () => {
  const ROOM_MEMBERS = [ALICE, BOB, CAROL]
  const mentioned = (value: unknown) =>
    mentionedUsers({ 'm.mentions': value }, ALICE, ROOM_MEMBERS)

  it('reads the members of m.mentions once each, the sender apart', () => {
    expect(mentioned({ user_ids: [BOB, ALICE, BOB, 3, REMOTE] })).toEqual([BOB])
  })

  it('mentions no one without m.mentions, or for the whole room', () => {
    expect(
      mentionedUsers({ body: `hello ${BOB}` }, ALICE, ROOM_MEMBERS)
    ).toEqual([])
    expect(mentioned({ room: true })).toEqual([])
    expect(mentioned({ user_ids: BOB })).toEqual([])
  })

  it('tells the first 50 members only, whoever else is named before them', () => {
    const users = Array.from(
      { length: 60 },
      (_, index) => `@user${String(index)}:example.org`
    )
    const strangers = users.map(user => user.replace('@user', '@other'))

    expect(
      mentionedUsers({ 'm.mentions': { user_ids: users } }, ALICE, users)
    ).toHaveLength(50)
    expect(
      mentionedUsers(
        { 'm.mentions': { user_ids: [...strangers, BOB] } },
        ALICE,
        ROOM_MEMBERS
      )
    ).toEqual([BOB])
  })
})

describe('activityEvents', () => {
  const shared = {
    eventId: EVENT_ID,
    roomId: ROOM,
    kind: 'direct',
    time: '2026-11-26T10:00:00.000Z'
  } as const

  it('makes one event per organization, each with its own people', () => {
    const events = activityEvents({
      ...shared,
      type: MESSAGE_CREATED,
      reason: 'direct',
      actor: { uuid: 'actor', org: 'acme' },
      recipients: [{ uuid: 'other', org: 'globex' }]
    })

    expect(events).toEqual([
      expect.objectContaining({
        id: activityId(EVENT_ID, MESSAGE_CREATED, 'acme'),
        twakeorg: 'acme',
        twakeactorid: 'actor',
        data: expect.objectContaining({ recipients: [] }) as unknown
      }),
      expect.objectContaining({
        id: activityId(EVENT_ID, MESSAGE_CREATED, 'globex'),
        twakeorg: 'globex',
        twakeactorid: 'actor',
        data: expect.objectContaining({
          recipients: [{ uuid: 'other', reason: 'direct' }]
        }) as unknown
      })
    ])
  })

  it('tells the organization of the actor of a direct message, not of a mention', () => {
    const mention = {
      ...shared,
      type: MESSAGE_MENTIONED,
      reason: 'mentioned',
      actor: { uuid: 'actor', org: 'acme' }
    } as const

    expect(activityEvents({ ...mention, recipients: [] })).toEqual([])
    expect(
      activityEvents({
        ...mention,
        recipients: [{ uuid: 'other', org: 'globex' }]
      }).map(event => event.twakeorg)
    ).toEqual(['globex'])
  })
})

describe('ChatActivity', () => {
  it('publishes a message of a direct conversation, with ids only', async () => {
    expect(await activity.publish(text())).toBe(1)

    const id = activityId(EVENT_ID, MESSAGE_CREATED, null)
    expect(published()).toEqual([
      {
        routingKey: MESSAGE_CREATED,
        messageId: id,
        event: {
          specversion: '1.0',
          id,
          source: 'twake://chat',
          type: MESSAGE_CREATED,
          time: '2026-11-26T10:00:00.000Z',
          twakeactorid: UUIDS.alice,
          data: {
            object: {
              type: 'message',
              id: EVENT_ID,
              container: { kind: 'direct', id: ROOM }
            },
            recipients: [{ uuid: UUIDS.bob, reason: 'direct' }]
          }
        }
      }
    ])
  })

  it('takes the room for direct when the other person holds it so', async () => {
    direct = { [BOB]: [ROOM] }

    expect(await activity.publish(text())).toBe(1)
  })

  it('publishes nothing for a room no one holds as direct, or of three people', async () => {
    direct = {}
    expect(await activity.publish(text())).toBe(0)

    direct = { [ALICE]: [ROOM] }
    members = { [ROOM]: [ALICE, BOB, CAROL] }
    activity = new ChatActivity(deps)
    expect(await activity.publish(text())).toBe(0)
    expect(deps.publisher.publish).not.toHaveBeenCalled()
  })

  it('publishes a mention to the mentioned members of the room', async () => {
    direct = {}
    members = { [ROOM]: [ALICE, BOB, CAROL] }

    // Dave is in another homeserver, Erin is not in the room
    expect(
      await activity.publish(
        mentioning(BOB, REMOTE, '@erin:example.org', CAROL)
      )
    ).toBe(1)
    expect(published()).toEqual([
      {
        routingKey: MESSAGE_MENTIONED,
        messageId: activityId(EVENT_ID, MESSAGE_MENTIONED, null),
        event: expect.objectContaining({
          type: MESSAGE_MENTIONED,
          twakeactorid: UUIDS.alice,
          data: {
            object: {
              type: 'message',
              id: EVENT_ID,
              container: { kind: 'room', id: ROOM }
            },
            recipients: [
              { uuid: UUIDS.bob, reason: 'mentioned' },
              { uuid: UUIDS.carol, reason: 'mentioned' }
            ]
          }
        }) as unknown
      }
    ])
  })

  it('publishes both events for a mention in a direct conversation', async () => {
    expect(await activity.publish(mentioning(BOB))).toBe(2)
    expect(published().map(({ routingKey }) => routingKey)).toEqual([
      MESSAGE_CREATED,
      MESSAGE_MENTIONED
    ])
  })

  it('publishes one event per organization', async () => {
    orgs = { alice: 'acme', bob: 'globex' }

    expect(await activity.publish(text())).toBe(2)
    expect(published().map(({ event }) => event.twakeorg)).toEqual([
      'acme',
      'globex'
    ])
  })

  it('skips a person the directory does not know', async () => {
    members = { [ROOM]: [ALICE, '@bot_alice:example.org'] }

    expect(await activity.publish(text())).toBe(1)
    expect(published()[0]?.event).toMatchObject({
      twakeactorid: UUIDS.alice,
      data: { recipients: [] }
    })
  })

  it.each([
    ['another type', text({ type: 'm.room.encrypted' })],
    ['a state event', text({ state_key: '' })],
    ['a sender of another homeserver', text({ sender: REMOTE })],
    ['a sender who left the room', text({ sender: CAROL })],
    [
      'an edit',
      text({
        content: {
          'm.mentions': { user_ids: [BOB] },
          'm.relates_to': { rel_type: 'm.replace', event_id: '$first' }
        }
      })
    ],
    [
      'a device verification',
      text({ content: { msgtype: 'm.key.verification.request', body: 'x' } })
    ],
    ['a room the homeserver refuses to read', text({ room_id: '!gone:x' })],
    ['an event without an id', text({ event_id: undefined })],
    ['no event', 'm.room.message']
  ])('publishes nothing for %s', async (_name, event) => {
    expect(await activity.publish(event)).toBe(0)
    expect(deps.publisher.publish).not.toHaveBeenCalled()
  })

  it.each([['yesterday'], [-1], [8.7e15], [Date.UTC(10000, 0, 1)]])(
    'dates an event whose time is %s at its reception',
    async time => {
      expect(await activity.publish(text({ origin_server_ts: time }))).toBe(1)
      expect(published()[0]?.event.time).toBe('2026-11-26T10:00:05.000Z')
    }
  )

  it('asks the homeserver and the directory once for several messages', async () => {
    await activity.publish(text())
    await activity.publish(text({ event_id: '$second', sender: BOB }))

    expect(deps.homeserver.joinedMembers).toHaveBeenCalledTimes(1)
    expect(deps.homeserver.directRooms).toHaveBeenCalledTimes(1)
    expect(deps.directory.entry).toHaveBeenCalledTimes(2)
  })

  it('reads the members again once a membership of the room changed', async () => {
    await activity.publish(text())
    members = { [ROOM]: [ALICE, BOB, CAROL] }
    await activity.publish({
      type: 'm.room.member',
      room_id: ROOM,
      state_key: CAROL
    })

    expect(await activity.publish(text({ event_id: '$second' }))).toBe(0)
    expect(deps.homeserver.joinedMembers).toHaveBeenCalledTimes(2)
  })

  it('reads m.direct again once one of the two made or joined a room', async () => {
    direct = {}
    expect(await activity.publish(text())).toBe(0)

    direct = { [BOB]: [ROOM] }
    await activity.publish({
      type: 'm.room.member',
      room_id: '!other:example.org',
      sender: ALICE,
      state_key: BOB
    })
    expect(await activity.publish(text())).toBe(1)
  })

  it('reads the members again after a minute, without a membership', async () => {
    await activity.publish(text())
    members = { [ROOM]: [ALICE, BOB, CAROL] }

    now += 59_000
    expect(await activity.publish(text({ event_id: '$second' }))).toBe(1)
    now += 1000
    expect(await activity.publish(text({ event_id: '$third' }))).toBe(0)
  })

  it('tells the actor of a mention to people of their organization', async () => {
    direct = {}
    orgs = { alice: 'acme', bob: 'acme', carol: 'globex' }
    members = { [ROOM]: [ALICE, BOB, CAROL] }

    await activity.publish(mentioning(BOB, CAROL))

    expect(
      published().map(({ event }) => [event.twakeorg, event.twakeactorid])
    ).toEqual([
      ['acme', UUIDS.alice],
      ['globex', UUIDS.alice]
    ])
  })

  it('reads m.direct again after a minute', async () => {
    direct = {}
    expect(await activity.publish(text())).toBe(0)

    direct = { [BOB]: [ROOM] }
    now += 59_000
    expect(await activity.publish(text())).toBe(0)
    now += 1000
    expect(await activity.publish(text())).toBe(1)
  })

  it('fails when the broker or the homeserver fails, so that the event comes again', async () => {
    deps.publisher.publish.mockRejectedValueOnce(new Error('connection lost'))
    await expect(activity.publish(text())).rejects.toThrow(
      new UpstreamError('broker', 'connection lost')
    )

    deps.homeserver.directRooms.mockRejectedValueOnce(
      new UpstreamError('homeserver', 'down')
    )
    activity = new ChatActivity(deps)
    await expect(activity.publish(text())).rejects.toBeInstanceOf(UpstreamError)
  })
})
