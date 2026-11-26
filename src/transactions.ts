import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { ChatActivity } from './activity.ts'
import { type HttpServer, matrixError, sendFailure } from './http.ts'
import { TtlCache } from './ttl-cache.ts'
import { UpstreamError } from './upstream.ts'

export const TRANSACTIONS_PATH = '/_matrix/app/v1/transactions/:txnId'

/** A transaction holds up to 100 events of 65 KiB each. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** A transaction Synapse sends again after an answer it did not receive is not handled twice. */
const HANDLED_TTL_MS = 3_600_000
const MAX_HANDLED = 1000

export interface TransactionsDeps {
  /** The `hs_token` of the registration: what proves a request comes from Synapse. */
  hsToken: string
  activity: Pick<ChatActivity, 'publish'>
  now?: () => number
}

const params = z.object({ txnId: z.string().min(1) })
const body = z.looseObject({ events: z.array(z.unknown()) })

function isSameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)

  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The JSON of a transaction, null when it is none. Anyone in a room writes the content of
 * an event: a `__proto__` key, which the parser of the other routes refuses, is dropped
 * here, as a refused transaction is one Synapse sends again forever.
 */
function parseTransaction(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text, (key, value: unknown): unknown =>
      key === '__proto__' ? undefined : value
    )

    return parsed
  } catch {
    return null
  }
}

/**
 * `PUT /_matrix/app/v1/transactions/{txnId}`: the events of the rooms of the homeserver,
 * as Synapse sends them to an application service whose registration has a `url`, in
 * order and one transaction at a time. Each is handed to the activity, which publishes
 * what it tells.
 *
 * Synapse sends a transaction again until it is answered 200, and sends nothing else
 * meanwhile. So a 502 is for what ends by itself only, a failure of the homeserver, the
 * directory or the broker, which then loses no event. An event that fails for any other
 * reason would fail again: it is logged and skipped.
 */
export function registerTransactions(
  app: HttpServer,
  deps: TransactionsDeps
): void {
  const handled = new TtlCache<true>(HANDLED_TTL_MS, MAX_HANDLED, deps.now)

  // A scope of its own: the check of the token comes before the body is read, and
  // the parser of the body is this route's alone
  void app.register((scoped, _options, done) => {
    scoped.addHook('onRequest', (request, reply, next) => {
      const [scheme, token] = (request.headers.authorization ?? '').split(' ')
      if (scheme !== 'Bearer' || token === undefined || token === '') {
        void reply
          .code(401)
          .send(matrixError('M_UNAUTHORIZED', 'Missing access token'))
        return
      }
      if (!isSameToken(token, deps.hsToken)) {
        void reply
          .code(403)
          .send(matrixError('M_FORBIDDEN', 'Unknown access token'))
        return
      }
      next()
    })
    scoped.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: MAX_BODY_BYTES },
      (_request, text, parsed) => {
        parsed(null, parseTransaction(String(text)))
      }
    )

    scoped.put(TRANSACTIONS_PATH, async (request, reply) => {
      const parsed = body.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send(matrixError('M_BAD_JSON', 'Invalid events'))
      }
      const { txnId } = params.parse(request.params)
      if (handled.get(txnId) === true) return reply.send({})

      let published = 0
      for (const event of parsed.data.events) {
        try {
          published += await deps.activity.publish(event)
        } catch (err: unknown) {
          if (err instanceof UpstreamError) {
            return sendFailure(reply, err, {
              refused: 'transaction refused',
              fields: { txnId }
            })
          }
          request.log.error({ err, txnId }, 'event skipped')
        }
      }
      handled.set(txnId, true)
      if (published > 0) {
        request.log.info({ txnId, published }, 'activity published')
      }

      return reply.send({})
    })
    done()
  })
}
