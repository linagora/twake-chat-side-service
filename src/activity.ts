import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Publisher } from './broker.ts'
import type { Directory } from './directory.ts'
import type { Homeserver } from './homeserver.ts'
import { TtlCache } from './ttl-cache.ts'
import { UpstreamError } from './upstream.ts'

export const MESSAGE_CREATED = 'com.twake.chat.message.created.v1'
export const MESSAGE_MENTIONED = 'com.twake.chat.message.mentioned.v1'

const SOURCE = 'twake://chat'

/** A message that mentions more members of its room than this tells the first ones only. */
const MAX_MENTIONS = 50

/**
 * The members of a room. The replica that receives a membership forgets them at once;
 * the others, which Synapse did not tell, only when this time is over.
 */
const MEMBERS_TTL_MS = 60_000
/** `m.direct` is account data, which Synapse sends to no application service: asked again this often. */
const DIRECT_TTL_MS = 60_000
const PEOPLE_TTL_MS = 10 * 60_000
const MAX_CACHED = 10_000

/** The namespace of the ids of the events (UUID v5): a redelivered Matrix event gives the same ids. */
const ID_NAMESPACE = Buffer.from('2b0c1a7e5d3f4e7a9c41d8f06b2a9e15', 'hex')

/** The last millisecond of the year 9999: a later time is no ISO 8601 date the consumers read. */
const MAX_TIME_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

/** The requests of a device verification are sent as messages: they are none. */
const VERIFICATION_MSGTYPE = 'm.key.verification.'

/** Who is told of an event: `direct`, the other person of the conversation. */
export type RecipientReason = 'direct' | 'mentioned'

/** Whether the room is a direct conversation of two people, or any other room. */
export type RoomKind = 'direct' | 'room'

/** A CloudEvent of the `activity` exchange (ADR 067): ids only, never the text of a message. */
export interface ActivityEvent extends Record<string, unknown> {
  specversion: '1.0'
  id: string
  source: string
  type: string
  time: string
  /** Absent for the people without an organization. */
  twakeorg?: string
  twakeactorid?: string
  data: {
    object: {
      type: 'message'
      id: string
      container: { kind: RoomKind; id: string }
    }
    recipients: { uuid: string; reason: RecipientReason }[]
  }
}

/** A person of the directory, as the platform names them. */
export interface Person {
  /** The `entryUUID` of the directory. */
  uuid: string
  org: string | null
}

export interface ActivityDeps {
  /** The homeserver whose users are told. */
  serverName: string
  homeserver: Pick<Homeserver, 'directRooms' | 'joinedMembers'>
  directory: Pick<Directory, 'entry'>
  /** The `activity` exchange. */
  publisher: Publisher
  now?: () => number
}

const message = z.looseObject({
  type: z.literal('m.room.message'),
  event_id: z.string().min(1).max(255),
  room_id: z.string().min(1).max(255),
  sender: z.string().min(1).max(255),
  // Any client sets it through another application service: out of range, it is ignored
  origin_server_ts: z
    .number()
    .int()
    .min(0)
    .max(MAX_TIME_MS)
    .optional()
    .catch(undefined),
  content: z.record(z.string(), z.unknown())
})

const mentions = z.looseObject({ user_ids: z.array(z.unknown()) })

const relation = z.looseObject({ rel_type: z.string() })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The same id for the same Matrix event, type and organization, in the shape of a UUID (v5). */
export function activityId(
  eventId: string,
  type: string,
  org: string | null
): string {
  const hash = createHash('sha1')
    .update(ID_NAMESPACE)
    .update(JSON.stringify([eventId, type, org]))
    .digest()
    .subarray(0, 16)
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6)
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = hash.toString('hex')

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}

/**
 * The members of the room a message mentions by name (`m.mentions.user_ids`, spec v1.7),
 * its sender apart. « @room » (`m.mentions.room`) names no one. A client that fills no
 * `m.mentions` mentions no one here: the text is never read.
 */
export function mentionedUsers(
  content: Record<string, unknown>,
  sender: string,
  members: readonly string[]
): string[] {
  const parsed = mentions.safeParse(content['m.mentions'])
  if (!parsed.success) return []
  const joined = new Set(members)
  const users = parsed.data.user_ids.filter(
    (user): user is string =>
      typeof user === 'string' && user !== sender && joined.has(user)
  )

  return [...new Set(users)].slice(0, MAX_MENTIONS)
}

function isVerification(content: Record<string, unknown>): boolean {
  const { msgtype } = content

  return typeof msgtype === 'string' && msgtype.startsWith(VERIFICATION_MSGTYPE)
}

/** An edit replaces a message already told: it tells no one again. */
function isEdit(content: Record<string, unknown>): boolean {
  const parsed = relation.safeParse(content['m.relates_to'])

  return parsed.success && parsed.data.rel_type === 'm.replace'
}

/**
 * One event per organization: a subscriber only receives the events of its own
 * organization. A `direct` message also goes to the organization of its actor, who is
 * told of what they sent. A mention goes to the organizations of the mentioned people
 * only; the gateway still tells its actor when they are of one of them, and a subscriber
 * knows a mention it made by `twakeactorid`.
 */
export function activityEvents(input: {
  type: string
  reason: RecipientReason
  eventId: string
  roomId: string
  kind: RoomKind
  time: string
  actor: Person | null
  recipients: readonly Person[]
}): ActivityEvent[] {
  const { type, reason, eventId, roomId, kind, time, actor, recipients } = input
  const orgs = new Set([
    ...(actor !== null && reason === 'direct' ? [actor.org] : []),
    ...recipients.map(recipient => recipient.org)
  ])

  return [...orgs].map(org => ({
    specversion: '1.0',
    id: activityId(eventId, type, org),
    source: SOURCE,
    type,
    time,
    ...(org !== null && { twakeorg: org }),
    ...(actor !== null && { twakeactorid: actor.uuid }),
    data: {
      object: {
        type: 'message',
        id: eventId,
        container: { kind, id: roomId }
      },
      recipients: recipients
        .filter(recipient => recipient.org === org)
        .map(recipient => ({ uuid: recipient.uuid, reason }))
    }
  }))
}

/**
 * Tells the platform what happens in Twake Chat: the Matrix events Synapse sends the
 * service become CloudEvents on the `activity` exchange. For now a message of a direct
 * conversation and a mention, in the clear, sent by a user of this homeserver.
 */
export class ChatActivity {
  #deps: ActivityDeps
  #members: TtlCache<string[]>
  #direct: TtlCache<Set<string>>
  #people: TtlCache<Person | null>

  constructor(deps: ActivityDeps) {
    const now = deps.now ?? Date.now
    this.#deps = deps
    this.#members = new TtlCache(MEMBERS_TTL_MS, MAX_CACHED, now)
    this.#direct = new TtlCache(DIRECT_TTL_MS, MAX_CACHED, now)
    this.#people = new TtlCache(PEOPLE_TTL_MS, MAX_CACHED, now)
  }

  /**
   * Publishes what a Matrix event tells, and answers how many events it published. An
   * event that tells nothing publishes none. Throws an `UpstreamError` when the
   * homeserver, the directory or the broker fails: the caller has Synapse send the event
   * again, and the ids of the events stay the same.
   */
  async publish(raw: unknown): Promise<number> {
    if (!isRecord(raw)) return 0
    if (raw.type === 'm.room.member' && typeof raw.room_id === 'string') {
      this.#members.delete(raw.room_id)
      // A room made or joined is when its people write it in their `m.direct`
      for (const user of [raw.sender, raw.state_key]) {
        if (typeof user === 'string') this.#direct.delete(user)
      }
      return 0
    }
    const parsed = message.safeParse(raw)
    if (!parsed.success || 'state_key' in raw) return 0
    const { event_id: eventId, room_id: roomId, sender, content } = parsed.data
    if (!this.#isLocal(sender) || isEdit(content) || isVerification(content)) {
      return 0
    }

    const members = await this.#membersOf(roomId, sender)
    // The homeserver gives the members whoever asks: a sender who left is not in them
    if (members === null || !members.includes(sender)) return 0
    const isDirect = await this.#isDirect(roomId, members)
    const mentioned = mentionedUsers(content, sender, members)
    if (!isDirect && mentioned.length === 0) return 0

    const shared = {
      eventId,
      roomId,
      kind: isDirect ? 'direct' : 'room',
      time: new Date(
        parsed.data.origin_server_ts ?? (this.#deps.now ?? Date.now)()
      ).toISOString(),
      actor: await this.#personOf(sender)
    } as const
    const events = [
      ...(isDirect
        ? activityEvents({
            ...shared,
            type: MESSAGE_CREATED,
            reason: 'direct',
            recipients: await this.#peopleOf(
              members.filter(member => member !== sender)
            )
          })
        : []),
      ...(mentioned.length > 0
        ? activityEvents({
            ...shared,
            type: MESSAGE_MENTIONED,
            reason: 'mentioned',
            recipients: await this.#peopleOf(mentioned)
          })
        : [])
    ]
    for (const event of events) {
      await this.#send(event)
    }

    return events.length
  }

  #isLocal(userId: string): boolean {
    return (
      userId.startsWith('@') &&
      userId.slice(userId.indexOf(':') + 1) === this.#deps.serverName
    )
  }

  async #membersOf(roomId: string, asUser: string): Promise<string[] | null> {
    const known = this.#members.get(roomId)
    if (known !== undefined) return known
    const members = await this.#deps.homeserver.joinedMembers(roomId, asUser)
    // A refusal is not kept: it may be about this user alone
    if (members !== null) this.#members.set(roomId, members)

    return members
  }

  /**
   * A room of two people that one of them holds as a direct conversation. The one who
   * was invited may not hold it in `m.direct` yet: either of the two is enough.
   */
  async #isDirect(
    roomId: string,
    members: readonly string[]
  ): Promise<boolean> {
    if (members.length !== 2) return false
    for (const member of members.filter(member => this.#isLocal(member))) {
      const rooms = await this.#directRoomsOf(member)
      if (rooms.has(roomId)) return true
    }

    return false
  }

  async #directRoomsOf(userId: string): Promise<Set<string>> {
    const known = this.#direct.get(userId)
    if (known !== undefined) return known
    const rooms = await this.#deps.homeserver.directRooms(userId)
    this.#direct.set(userId, rooms)

    return rooms
  }

  async #peopleOf(userIds: readonly string[]): Promise<Person[]> {
    const people: Person[] = []
    for (const userId of userIds) {
      const person = await this.#personOf(userId)
      if (person !== null) people.push(person)
    }

    return people
  }

  /** Null for a user of another homeserver, or one the directory does not know, such as a bot. */
  async #personOf(userId: string): Promise<Person | null> {
    if (!this.#isLocal(userId)) return null
    const localpart = userId.slice(1, userId.indexOf(':'))
    const known = this.#people.get(localpart)
    if (known !== undefined) return known
    const entry = await this.#deps.directory.entry(localpart)
    const person =
      entry.actorId === null
        ? null
        : { uuid: entry.actorId.toLowerCase(), org: entry.org }
    this.#people.set(localpart, person)

    return person
  }

  async #send(event: ActivityEvent): Promise<void> {
    try {
      await this.#deps.publisher.publish(event.type, event, event.id)
    } catch (err: unknown) {
      throw new UpstreamError(
        'broker',
        err instanceof Error ? err.message : String(err)
      )
    }
  }
}
