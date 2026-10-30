import { randomUUID } from 'node:crypto'
import { RabbitMQClient } from '@linagora/rabbitmq-client'
import type { Logger } from 'pino'
import { z } from 'zod'
import { type RateLimit, tokenOf } from './assistants.ts'
import type { Directory, DirectoryEntry } from './directory.ts'
import { corsFor, type HttpServer, matrixError, sendFailure } from './http.ts'
import { type OpenId, openIdUser } from './openid.ts'

export const ANALYTICS_PATH = '/analytics/events'

const EXCHANGE = 'user-activity'
const TYPE = 'com.twake.chat.user.active.v1'

/** An event older than this, or further in the future than the skew, is dropped. */
const MAX_AGE_MS = 24 * 3_600_000
const MAX_SKEW_MS = 5 * 60_000

const MAX_STRING = 200
const MAX_EVENTS = 200

/** Lookups kept this long, and no more than this many: a replica's own, unshared. */
const CACHE_TTL_MS = 5 * 60_000
const CACHE_SIZE = 10_000

/** Publishes waiting for the broker: past this, an event is dropped, as losing one is harmless. */
const MAX_PENDING = 1000

/** The dropped events are counted in one warning this often, at most. */
const DROPPED_REPORT_MS = 60_000

/** The accounts that are no person: the rule of Twake Chat. */
const BOT = /^(bot_|hermes_)/

export interface AnalyticsDeps {
  /** The homeserver whose users are served. */
  serverName: string
  openId: Pick<OpenId, 'userOf'>
  directory: Pick<Directory, 'entry'>
  /** None when the deployment publishes no analytics: the route answers 202 and does nothing. */
  publisher: Publisher | null
  /** The batches of each user: a 429 past it drops that user's batch only. */
  rateLimit: Pick<RateLimit, 'take'>
  now?: () => number
}

/** What reaches the `user-activity` exchange of the bridge. */
export interface Publisher {
  publish(
    routingKey: string,
    event: Record<string, unknown>,
    messageId: string
  ): Promise<void>
}

/** The bridge declares the exchange (durable topic); the client declares it the same way. */
export function amqpPublisher(url: string, logger: Logger): Publisher {
  const client = new RabbitMQClient({ url, publishMaxAttempts: 2, logger })
  return {
    publish: (routingKey, event, messageId) =>
      client.publish(EXCHANGE, routingKey, event, { messageId })
  }
}

const body = z.object({
  app: z.string().min(1).max(64),
  version: z.string().min(1).max(64),
  events: z.array(z.unknown()).max(MAX_EVENTS)
})

/** Checked one by one: a bad event is dropped, never the batch it came in. */
const event = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  properties: z.record(z.string(), z.unknown()).catch({}),
  view: z.string().min(1).max(MAX_STRING).optional().catch(undefined),
  at: z.iso.datetime({ offset: true })
})

type Scalar = string | number | boolean | null

/** The flat scalars of the properties: nested values are dropped, long strings cut. */
function scalars(properties: Record<string, unknown>): Record<string, Scalar> {
  const flat: Record<string, Scalar> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'string') flat[key] = value.slice(0, MAX_STRING)
    else if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    ) {
      flat[key] = value
    }
  }
  return flat
}

const cors = corsFor(
  'POST',
  'authorization, content-type, x-matrix-server-name'
)

/**
 * `POST /analytics/events`: the events of Twake Chat of the user of an OpenID token,
 * published as CloudEvents on the exchange of twake-user-activity, which forwards them
 * to PostHog. The browser decides on the consent: the service cannot read the account
 * data. Answers 202 whatever becomes of the events.
 */
export function registerAnalytics(app: HttpServer, deps: AnalyticsDeps): void {
  const lookups = new Lookups(deps.directory, deps.now)
  let pending = 0
  /** Dropped since the last warning: a broker down for good never lets the backlog drain. */
  let lost = 0
  const reportLost = () => {
    if (lost === 0) return
    app.log.warn(
      { dropped: lost },
      'analytics events dropped: broker backlog full'
    )
    lost = 0
  }
  const report = setInterval(reportLost, DROPPED_REPORT_MS)
  report.unref()
  app.addHook('onClose', (_instance, done) => {
    clearInterval(report)
    reportLost()
    done()
  })
  app.options(ANALYTICS_PATH, { onSend: cors }, (_request, reply) =>
    reply.code(204).send()
  )
  app.post(ANALYTICS_PATH, { onSend: cors }, async (request, reply) => {
    let user: string
    try {
      user = await openIdUser(deps.openId, deps.serverName, tokenOf(request))
    } catch (err) {
      return sendFailure(reply, err, {
        refused: 'analytics refused',
        fields: {}
      })
    }
    const waitMs = deps.rateLimit.take(user)
    if (waitMs !== null) {
      request.log.debug({ user }, 'analytics batch limited')
      return reply
        .code(429)
        .header('retry-after', String(Math.ceil(waitMs / 1000)))
        .send({
          ...matrixError('M_LIMIT_EXCEEDED', 'Too many requests'),
          retry_after_ms: waitMs
        })
    }
    const parsed = body.safeParse(request.body)
    if (!parsed.success) {
      const fields = parsed.error.issues.map(
        issue => issue.path.join('.') || 'body'
      )
      return reply
        .code(400)
        .send(matrixError('M_INVALID_PARAM', `Invalid ${fields.join(', ')}`))
    }
    const { publisher } = deps
    const localpart = user.slice(1, user.indexOf(':'))
    if (!publisher || BOT.test(localpart)) return reply.code(202).send()

    const now = (deps.now ?? Date.now)()
    const events = parsed.data.events.flatMap(raw => {
      const checked = event.safeParse(raw)
      if (!checked.success) return []
      const age = now - Date.parse(checked.data.at)
      return age <= MAX_AGE_MS && age >= -MAX_SKEW_MS ? [checked.data] : []
    })
    const dropped = parsed.data.events.length - events.length
    if (dropped > 0)
      request.log.warn({ user, dropped }, 'analytics events dropped')
    // Not awaited: the answer never waits for the directory or the broker.
    void (async () => {
      const entry = await lookups.of(localpart)
      if (!entry.email) {
        request.log.debug({ user }, 'analytics skipped: no mail')
        return
      }
      for (const [index, event] of events.entries()) {
        if (pending >= MAX_PENDING) {
          lost += events.length - index
          return
        }
        const id = randomUUID()
        pending += 1
        publisher
          .publish(
            TYPE,
            {
              specversion: '1.0',
              id,
              source: 'twake://chat',
              type: TYPE,
              time: event.at,
              twakeactor: entry.email,
              ...(entry.actorId && { twakeactorid: entry.actorId }),
              ...(entry.org && { twakeorg: entry.org }),
              data: {
                category: 'foreground',
                action: event.name,
                platform: 'web',
                properties: {
                  ...scalars(event.properties),
                  ...(event.view && { view: event.view }),
                  appVersion: parsed.data.version
                }
              }
            },
            id
          )
          .catch((err: unknown) => {
            request.log.warn({ err, id }, 'analytics event lost')
          })
          .finally(() => {
            pending -= 1
          })
      }
    })().catch((err: unknown) => {
      request.log.warn({ err, user }, 'analytics lookup failed')
    })
    return reply.code(202).send()
  })
}

/** The directory entries of the users, kept briefly: events come in bursts. */
class Lookups {
  readonly #directory: Pick<Directory, 'entry'>
  readonly #now: () => number
  readonly #entries = new Map<
    string,
    { at: number; entry: Promise<DirectoryEntry> }
  >()

  constructor(
    directory: Pick<Directory, 'entry'>,
    now: () => number = Date.now
  ) {
    this.#directory = directory
    this.#now = now
  }

  of(localpart: string): Promise<DirectoryEntry> {
    const now = this.#now()
    const kept = this.#entries.get(localpart)
    if (kept && now - kept.at < CACHE_TTL_MS) return kept.entry
    if (this.#entries.size >= CACHE_SIZE) this.#entries.clear()
    const entry = this.#directory.entry(localpart)
    this.#entries.set(localpart, { at: now, entry })
    // A failed lookup is not kept: the next batch asks again.
    entry.catch(() => this.#entries.delete(localpart))
    return entry
  }
}
