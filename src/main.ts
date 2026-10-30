import { setTimeout as delay } from 'node:timers/promises'
import { createLogger } from '@linagora/twake-node-telemetry'
import * as Sentry from '@sentry/node'
import postgres from 'postgres'
import { amqpPublisher, registerAnalytics } from './analytics.ts'
import { RateLimit, registerAssistants } from './assistants.ts'
import { CallRooms } from './call-rooms.ts'
import { loadConfig } from './config.ts'
import { Directory } from './directory.ts'
import { Harness } from './harness.ts'
import { Homeserver } from './homeserver.ts'
import { createServer } from './http.ts'
import { handleSignals } from './lifecycle.ts'
import { Meet } from './meet.ts'
import { OpenId } from './openid.ts'
import { registerPublicPages } from './public-pages.ts'
import { RoomReader } from './room-reader.ts'
import { registerSfuGet } from './sfu-get.ts'

// Readiness answers 503 this long before the server closes, so the load
// balancer stops routing here first. Both fit the default 30 s grace period.
const DRAIN_MS = 5000
const SHUTDOWN_DEADLINE_MS = 25_000

const config = loadConfig()
const logger = createLogger({
  service: 'twake-chat-side-service',
  level: config.LOG_LEVEL
})
const lifecycle = handleSignals({
  log: logger,
  deadlineMs: SHUTDOWN_DEADLINE_MS,
  // process.exit drops what Sentry has not sent yet.
  exit: code => void Sentry.close(2000).then(() => process.exit(code))
})

const connect = (max?: number) =>
  postgres(config.DATABASE_URL, {
    connect_timeout: 5,
    onnotice: () => undefined,
    ...(max && { max })
  })
const sql = connect()
// Its own connection: calls waiting for a Meet room may hold every one of the pool
const probe = connect(1)
const callRooms = new CallRooms(sql)
await callRooms.migrate()

let accepting = false
const server = createServer({
  logger,
  // A database that holds the connection without answering is not ready either
  isReady: () =>
    Promise.race([
      probe`select 1`.then(() => accepting),
      delay(2000).then(() => false)
    ])
})
const openId = new OpenId(config.MATRIX_HOMESERVER_URL)
const directory = new Directory({
  url: config.LDAP_URL,
  base: config.LDAP_BASE,
  bindDn: config.LDAP_BIND_DN ?? null,
  bindPassword: config.LDAP_BIND_PASSWORD ?? '',
  uidAttribute: config.LDAP_UID_ATTRIBUTE,
  ...(config.LDAP_ORG_ATTRIBUTE && { orgAttribute: config.LDAP_ORG_ATTRIBUTE })
})
registerSfuGet(server, {
  serverName: config.MATRIX_SERVER_NAME,
  openId,
  homeserver: new Homeserver(config.MATRIX_HOMESERVER_URL, config.AS_TOKEN),
  directory,
  meet: new Meet({
    url: config.MEET_URL,
    clientId: config.MEET_CLIENT_ID,
    clientSecret: config.MEET_CLIENT_SECRET,
    serviceAccountEmail: config.MEET_SERVICE_ACCOUNT_EMAIL
  }),
  callRooms
})
registerAnalytics(server, {
  serverName: config.MATRIX_SERVER_NAME,
  openId,
  directory,
  publisher: config.AMQP_URL
    ? // The client logs each publish at info and its payload, mail included
      // as twakeactor, at debug (linagora/rabbitmq-client#25): its warnings
      // only. twakeactor is redacted by twake-node-telemetry (1.2.0).
      amqpPublisher(
        config.AMQP_URL,
        logger.child(
          {},
          { level: logger.levelVal > 40 ? logger.level : 'warn' }
        )
      )
    : null,
  rateLimit: new RateLimit(config.ANALYTICS_BATCHES_PER_MINUTE)
})
const {
  ASSISTANTS_URL: url,
  ASSISTANTS_TOKEN_URL: tokenUrl,
  ASSISTANTS_CLIENT_ID: clientId,
  ASSISTANTS_CLIENT_SECRET: clientSecret
} = config
registerAssistants(server, {
  serverName: config.MATRIX_SERVER_NAME,
  openId,
  harness:
    url && tokenUrl && clientId && clientSecret
      ? new Harness({
          url,
          tokenUrl,
          clientId,
          clientSecret,
          scope: config.ASSISTANTS_SCOPE
        })
      : null,
  rateLimit: new RateLimit(config.ASSISTANTS_REQUESTS_PER_MINUTE)
})
const { PUBLIC_PAGES_URL: publicUrl, CHAT_URL: chatUrl } = config
if (publicUrl && chatUrl) {
  registerPublicPages(server, {
    reader: new RoomReader(config.MATRIX_HOMESERVER_URL, config.AS_TOKEN),
    serverName: config.MATRIX_SERVER_NAME,
    publicUrl,
    chatUrl
  })
}
await server.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT })

accepting = true
lifecycle.started(async () => {
  accepting = false
  await delay(DRAIN_MS)
  await server.close()
  await Promise.all([sql.end({ timeout: 5 }), probe.end({ timeout: 5 })])
})
