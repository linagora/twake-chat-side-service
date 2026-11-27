import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { RabbitMQClient } from '@linagora/rabbitmq-client'
import type { Logger } from 'pino'
import { z } from 'zod'
import { type RateLimit, tokenOf } from './assistants.ts'
import {
  corsFor,
  type HttpServer,
  matrixError,
  STATS_PATH,
  sendFailure
} from './http.ts'
import { type OpenId, openIdUser } from './openid.ts'

export const ANALYTICS_PATH = '/analytics/events'

const EXCHANGE = 'user-activity'
const TYPE = 'com.twake.chat.user.active.v1'

/** An event older than this, or further in the future than the skew, is dropped. */
const MAX_AGE_MS = 24 * 3_600_000
const MAX_SKEW_MS = 5 * 60_000

const MAX_STRING = 200
const MAX_EVENTS = 200

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
  /** None when the deployment publishes no analytics: the route answers 202 and does nothing. */
  publisher: Publisher | null
  /** The batches of each user: a 429 past it drops that user's batch only. */
  rateLimit: Pick<RateLimit, 'take'>
  /** The secret of the Synapse stats route: none, and the route answers 404. */
  serverStatsToken?: string | null | undefined
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
  /** The random id of a visit: an invalid one is ignored, never a 400. */
  visit: z.uuidv4().optional().catch(undefined),
  /** The app the client runs on: anything else is the web. */
  platform: z.enum(['web', 'desktop', 'mobile']).catch('web'),
  events: z.array(z.unknown()).max(MAX_EVENTS)
})

/** Checked one by one: a bad event is dropped, never the batch it came in. */
const event = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  properties: z.record(z.string(), z.unknown()).catch({}),
  view: z.string().min(1).max(MAX_STRING).optional().catch(undefined),
  at: z.iso.datetime({ offset: true })
})

/** What Synapse reports of its usage (`report_stats`): only these counters are published. */
const STATS_COUNTERS = [
  'total_users',
  'daily_user_type_native',
  'daily_user_type_bridged',
  'daily_user_type_guest',
  'total_room_count',
  'daily_active_users',
  'monthly_active_users',
  'daily_active_e2ee_rooms',
  'daily_e2ee_messages',
  'daily_sent_e2ee_messages',
  'daily_active_rooms',
  'daily_messages',
  'daily_sent_messages',
  'r30v2_users_all',
  'r30v2_users_android',
  'r30v2_users_ios',
  'r30v2_users_electron',
  'r30v2_users_web'
] as const

/** Seconds since the epoch, as Synapse sends them. */
const stats = z.looseObject({
  timestamp: z
    .number()
    .min(0)
    .max(8.64e12 / 1000)
})

/** The numeric counters of the whitelist, nothing else. */
function counters(stats: Record<string, unknown>): Record<string, number> {
  const found: Record<string, number> = {}
  for (const key of STATS_COUNTERS) {
    const value = stats[key]
    if (typeof value === 'number') found[key] = value
  }
  return found
}

/** Compared by digest: the length of the token and the time of the check tell nothing. */
function sameToken(given: string, expected: string): boolean {
  const digest = (text: string) => createHash('sha256').update(text).digest()
  return timingSafeEqual(digest(given), digest(expected))
}

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
 * data. Answers 202 whatever becomes of the events. The CloudEvent carries the optional
 * `visit` of the body (UUID v4) and the `deployment` (the homeserver) among its properties.
 */
export function registerAnalytics(app: HttpServer, deps: AnalyticsDeps): void {
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
  /** Not awaited: the answer never waits for the broker. False when the backlog is full. */
  const enqueue = (
    publisher: Publisher,
    log: Logger,
    time: string,
    data: Record<string, unknown>
  ): boolean => {
    if (pending >= MAX_PENDING) return false
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
          time,
          data
        },
        id
      )
      .catch((err: unknown) => {
        log.warn({ err, id }, 'analytics event lost')
      })
      .finally(() => {
        pending -= 1
      })
    return true
  }
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
    // Anonymous: the event carries nothing of the user.
    for (const [index, event] of events.entries()) {
      const sent = enqueue(publisher, request.log, event.at, {
        ...(parsed.data.visit && { visit: parsed.data.visit }),
        category: 'foreground',
        action: event.name,
        platform: parsed.data.platform,
        properties: {
          ...scalars(event.properties),
          ...(event.view && { view: event.view }),
          appVersion: parsed.data.version,
          // After the client properties: the server wins.
          deployment: deps.serverName
        }
      })
      if (!sent) {
        lost += events.length - index
        break
      }
    }
    return reply.code(202).send()
  })
  const { serverStatsToken } = deps
  if (!serverStatsToken) return
  // Synapse sends no authorization: the secret is in the path, and a wrong one looks absent.
  app.post<{ Params: { token: string } }>(
    `${STATS_PATH}/:token`,
    async (request, reply) => {
      if (!sameToken(request.params.token, serverStatsToken))
        return reply.code(404).send()
      const parsed = stats.safeParse(request.body)
      if (!parsed.success)
        return reply
          .code(400)
          .send(matrixError('M_INVALID_PARAM', 'Invalid timestamp'))
      if (parsed.data.homeserver !== deps.serverName)
        return reply
          .code(403)
          .send(matrixError('M_FORBIDDEN', 'Not the stats of this homeserver'))
      if (deps.publisher)
        enqueue(
          deps.publisher,
          request.log,
          new Date(parsed.data.timestamp * 1000).toISOString(),
          {
            category: 'background',
            action: 'server_stats_reported',
            properties: {
              ...counters(parsed.data),
              deployment: deps.serverName
            }
          }
        )
      return reply.code(202).send()
    }
  )
}
