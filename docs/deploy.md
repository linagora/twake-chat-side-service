# Deploying

The service is the side service of Twake Chat: the MatrixRTC token service of
its calls, the relay of its assistants to twake-harness (see
[Assistants](#assistants)), and the public web pages of its rooms open to all
(see [Public pages](#public-pages)). The client finds it in the client well-known and
calls `POST /sfu/get` on it directly, with an OpenID token of its homeserver.
The service checks the token and the membership with the homeserver, then asks
Meet for the LiveKit token, in the Meet room of the Matrix room.

```mermaid
sequenceDiagram
    participant C as Twake Chat
    participant V as Twake Chat side service
    participant S as Synapse
    participant L as LDAP
    participant M as Meet
    C->>V: POST /sfu/get {room, openid_token, device_id}
    V->>S: openid/userinfo (who the token stands for)
    V->>S: is_joined, power levels, display name (as_token)
    V->>L: email and Twake instance of the user
    V->>M: Meet room of the Matrix room (created once), then its livekit-token
    V-->>C: {url, jwt}
```

The service refuses, before it asks Meet:

- a user of another homeserver (403 `M_FORBIDDEN`);
- an OpenID token the homeserver rejects (401 `M_UNKNOWN_TOKEN`);
- a user who is not joined to the room (403 `M_FORBIDDEN`);
- a user without a single email in the directory (403 `M_FORBIDDEN`).

Meet refusing to act for the user (domain not allowed, no account) answers 403
`M_FORBIDDEN`. A failure of the homeserver, the directory, Postgres or Meet
answers 502, and so does a request still pending after 14 seconds (Twake Chat
gives up after 15). Moderators of the room (power level 50 or more, or a
creator from room version 12) join as `administrator` of the Meet room, the
others as `member`. The LiveKit identity is `@user:server:device`.

## Image

`ghcr.io/linagora/twake-chat-side-service`, tagged `latest` from `main`
and `X.Y.Z` from each release tag `vX.Y.Z`. Node 24; it runs as uid 1000 and
works on a read-only root filesystem, and listens on port 8080. It logs JSON
lines with
[`@linagora/twake-node-telemetry`](https://github.com/linagora/twake-libs/tree/%40linagora/twake-node-telemetry%401.1.0/packages/twake-node-telemetry):
`service`, the level as text and an ISO `time` on every line, secrets and the
`email` key masked. It logs one line per refused token and per failure. It
starts with `node --import ./dist/instrument.js dist/main.js`: a command
override must keep the `--import`, or Sentry gets nothing.

## Routes

- `POST /sfu/get`: public, reached by browsers of any origin (CORS `*`; the
  credentials are in the body). Expose it over HTTPS. It has no rate limit of
  its own: set one at the ingress if needed.
- `GET`/`PUT /assistants/me`, `PUT /assistants/me/home`,
  `POST /assistants/me/recover`, `GET`/`PUT /assistants/me/suggestions`:
  public as well, with a rate limit per user and replica (see
  [Assistants](#assistants)). The service checks the token with Synapse before
  that limit: set a limit per IP at the ingress too.
- `GET /b/<ref>`, `GET /b/<ref>/media/<server>/<id>`, `GET /sitemap.xml`,
  `GET /robots.txt`: the public pages, for visitors and crawlers without any
  credential (see [Public pages](#public-pages)). They have no rate limit of
  their own and a request may cost several reads of Synapse: a limit per IP at
  the ingress is required before they are exposed.
- `POST /analytics/events`: the product analytics of Twake Chat (see
  [Analytics](#analytics)), with the OpenID token like the routes above.
- `PUT /_matrix/app/v1/transactions/<txnId>`: the events of the rooms, sent by
  Synapse alone with the `hs_token` (see [Activity](#activity)). Served with
  `HS_TOKEN` only. It shares the port of the public routes: the ingress must
  not route `/_matrix/app/` to the service.
- Liveness: `GET /health/live`.
- Readiness: `GET /health/ready`, 503 while Postgres does not answer within
  2 seconds.

## Environment

All required unless a default is given.

- `AS_TOKEN`: the `as_token` of the registration.
- `MATRIX_HOMESERVER_URL`: a listener of Synapse with the `client` resource and
  the `federation` or `openid` one (for `/_matrix/federation/v1/openid/userinfo`),
  for example `http://synapse:8008`.
- `MATRIX_SERVER_NAME`: the server name of the homeserver, whose users only
  are served.
- `DATABASE_URL`: the Postgres database, for example
  `postgres://chat_side_service:secret@postgresql:5432/chat_side_service`.
- `MEET_URL`: Meet, for example `https://meet.example.com`.
- `MEET_CLIENT_ID`, `MEET_CLIENT_SECRET`: the application of the service in
  Meet.
- `MEET_SERVICE_ACCOUNT_EMAIL`: the owner of the Meet rooms of the calls.
- `LDAP_URL`, `LDAP_BASE`: the directory, and where its users are.
- `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`: a bind that may read `mail`,
  `twakeWorkspaceUrl` and `workspaceUrl`, and for the
  [activity](#activity) `entryUUID` and the organization attribute, anonymous
  when unset. The password is required with a DN.
- `LDAP_ORG_ATTRIBUTE` (optional): the attribute that holds the id of the
  organization of the user, read with the directory entry. It becomes the
  `twakeorg` of the [activity](#activity), which needs it wherever people
  belong to an organization; the analytics no longer use it.
- `LDAP_UID_ATTRIBUTE`: the attribute that holds the Matrix localpart, `uid`
  by default.
- `AMQP_URL` (optional, secret): the RabbitMQ of the platform, for
  example `amqp://user:secret@rabbitmq:5672`. Without it, the analytics route
  answers 202 and publishes nothing.
- `HS_TOKEN` (optional, secret): the `hs_token` of the registration, to receive
  the events of Synapse and publish the [activity](#activity). It needs
  `AMQP_URL`. Without it, the transactions route answers 404.
- `ACTIVITY_EXCHANGE`: the exchange of the activity, `activity` by default.
- `ASSISTANTS_URL`, `ASSISTANTS_TOKEN_URL`, `ASSISTANTS_CLIENT_ID`,
  `ASSISTANTS_CLIENT_SECRET`: all four or none, to serve the assistants (see
  [Assistants](#assistants)). Without them, the assistant routes answer 404.
- `ASSISTANTS_SCOPE`: the scope of the client credentials request, `openid` by
  default (LemonLDAP-NG refuses a request without one).
- `ASSISTANTS_REQUESTS_PER_MINUTE`: the assistant calls a user may make per
  minute and replica, 60 by default.
- `ANALYTICS_BATCHES_PER_MINUTE`: the analytics batches a user may send per
  minute and replica, 60 by default. Twake Chat sends at most one every 5 seconds per
  open tab, and one when a tab is hidden.
- `PUBLIC_PAGES_URL`, `CHAT_URL`: both or none, to serve the public pages: the
  public address of this service, for the links of the pages and the sitemap,
  and the address of Twake Chat, where « React in Twake Chat » opens the room.
  Without them, those routes answer 404.
- `HTTP_HOST`, `HTTP_PORT`: `0.0.0.0` and 8080 by default.
- `LOG_LEVEL`: `info` by default.
- `SENTRY_DSN` (optional, secret) and `SENTRY_ENVIRONMENT` (optional): every
  `error` and `fatal` line becomes a Sentry event, with the release
  `twake-chat-side-service@<version>` and the tag `service`, and without request
  data (headers, bodies, query strings, database parameters). On an unhandled
  promise rejection, Sentry reports it and the process exits with code 1.
  Without `SENTRY_DSN`, nothing is sent.

Each request to Synapse or Meet gives up after 5 seconds, and so does each step
with the directory (connection, bind, search). The token request as a whole
answers within 14 seconds.

## Well-known

The client well-known (`/.well-known/matrix/client`) names the service under
three keys, with the same URL:

- `livekit_base_url`: the one Twake Chat reads for the calls (the Flutter
  client reads only this one, the React client reads both);
- `livekit_service_url`: the one of the MatrixRTC clients of Element;
- `side_service.base_url` of the `app.twake.chat` object: the one Twake Chat
  reads for the assistants and the analytics (it falls back to the former
  `assistants.base_url`). Without either, Twake Chat shows no assistant and
  sends no analytics.

```json
{
  "org.matrix.msc4143.rtc_foci": [
    {
      "type": "livekit",
      "livekit_base_url": "https://chat-side.example.com",
      "livekit_service_url": "https://chat-side.example.com"
    }
  ],
  "app.twake.chat": {
    "side_service": { "base_url": "https://chat-side.example.com" }
  }
}
```

## Meet

- The external API on (`EXTERNAL_API_ENABLED`, `APPLICATION_ENABLED`), with
  the `livekit-token/` route of the rooms
  ([linto-ai/meet#6](https://github.com/linto-ai/meet/pull/6)).
- An application with the scopes `rooms:create` and `rooms:livekit_token`.
  When it has allowed domains, they must hold the domain of every user and of
  the service account.
- `APPLICATION_ALLOW_USER_CREATION`, so that a user who never signed in to
  Meet gets an account from their email.
- The route of linto-ai/meet#6 at `e1502eb9` ignores `twake_instance`. Until
  Meet stores it, Meet knows no Drive for a user who never signed in to it,
  so their recordings and transcripts are not delivered there.
- Meet hands the LiveKit tokens of a room to the application that created it
  only. Changing `MEET_CLIENT_ID` makes each Matrix room get a new Meet room at
  its next call.

## Assistants

The service relays the assistant of the user to the provisioning API of
twake-harness, which owns the assistants as its application service. It reaches
the harness through APISIX inside the cluster, never the browser, with a token
of its own OIDC client.

```mermaid
sequenceDiagram
    participant C as Twake Chat
    participant V as Twake Chat side service
    participant S as Synapse
    participant O as LemonLDAP
    participant A as APISIX (in cluster)
    participant H as twake-harness
    C->>V: PUT /assistants/me (Bearer OpenID token, x-matrix-server-name)
    V->>S: openid/userinfo (who the token stands for)
    V->>O: client credentials token (kept until it nearly expires)
    V->>A: PUT /b2b/agents/v1/provisioning/assistants/{user}
    A->>H: same request
    H-->>V: {userId, deviceId, masterKey}
    V-->>C: {userId, deviceId, masterKey}
```

- The client sends its OpenID token in `Authorization: Bearer` and the server
  that issued it in `x-matrix-server-name`. The owner is always the user of the
  token; the routes take no other.
- The service answers what the harness answers, `Retry-After` included: a 503
  while the assistant is not ready, which the client asks again. A refusal
  keeps the `error` of the harness and gains an `errcode`:
  `APP.TWAKE.BOT_NOT_FOUND` for `no assistant`, `APP.TWAKE.BOT_RECOVERY_NEEDED`
  for `recovery_needed`, `M_UNKNOWN` for the other failures of its API. The
  `M_` prefix belongs to the Matrix spec: a code of our own is namespaced. Any other answer, such as a route missing
  at APISIX, is logged and answers 502.
- A 401 or a 403 of the harness concerns the token of the service, never the
  user's: the service asks a new token once on a 401, then answers 502. Its own
  401 means the homeserver rejected the OpenID token.
- More than `ASSISTANTS_REQUESTS_PER_MINUTE` calls of a user in a minute answer
  429 `M_LIMIT_EXCEEDED` with a `Retry-After`. The count and the token are kept
  by each replica, unshared.
- A failure of the homeserver, LemonLDAP or the harness answers 502. The
  harness gets 12 seconds per call, since `/home` waits for the assistant to
  join the room. A request still pending after 14 seconds answers 503 with
  `Retry-After: 5`, which the client asks again.

To serve them:

- `ASSISTANTS_URL`: the harness through APISIX, before its `/v1` routes, for
  example `http://apisix-gateway.apisix.svc.cluster.local/b2b/agents`. On its
  route `b2b-agents-api` (`/b2b/agents/v1/*`, the prefix stripped), APISIX
  adds the shared secret of the harness itself, checks the token with the JWKS
  of LemonLDAP-NG, and admits the pods of the cluster only: the service runs in
  one.
- An OIDC client of the service in LemonLDAP-NG, confidential, with the client
  credentials grant, as the tenant ToM's client `tom-<tenant>` that the harness
  already admits. Its access tokens must carry the issuer and the audience the
  harness expects (`AUTH_ISSUER`, `AUTH_AUDIENCE`). `ASSISTANTS_TOKEN_URL` is
  the token endpoint of LemonLDAP-NG, for example
  `https://auth.example.com/oauth2/token`.
- Its client id in `PROVISIONER_CLIENT_IDS` of the harness, which admits the
  provisioners by the subject of their token.
- The network: the service reaches APISIX and the token endpoint.

## Analytics

`POST /analytics/events` takes the batches of events that Twake Chat collects
(`{ app, version, visit?, events: [{ name, properties, view?, at }] }`, at most 200
events) and publishes each as a CloudEvent `com.twake.chat.user.active.v1` on
the `user-activity` exchange, where twake-user-activity forwards it to PostHog.

- The browser decides on the consent: the service cannot read the account data
  and publishes whatever an authenticated user sends. Twake Chat sends nothing
  without the consent of the user.
- The user is the one of the OpenID token (`Authorization: Bearer` and
  `x-matrix-server-name`, a 401 otherwise). A body that is no object with an `events` array of 200 at most answers 400; a
  bad event (name, date) is dropped alone and the others published, with one
  warning that counts them.
  Otherwise the answer is 202 at once: the broker is never
  waited for, and a failed publish is logged and lost, as the bridge allows.
- More than `ANALYTICS_BATCHES_PER_MINUTE` batches of a user in a minute answer
  429 with `Retry-After`; Twake Chat drops that batch.
- While the broker lags, at most 1000 events wait per replica; the others are
  dropped and counted in one warning a minute (`dropped`), even if the broker
  never comes back.
- The events are anonymous: the OpenID token only proves the caller and sets
  the rate limit. The CloudEvent carries no `twakeactor`, `twakeactorid`,
  `twakeorg` nor any value derived from the user, and no LDAP lookup is made.
  The `bot_` and `hermes_` accounts publish nothing.
- Properties keep the flat values (text cut to 200 characters, number, boolean,
  null) and drop the nested ones; `view` and the version of the app join them as
  `view` and `appVersion`, then `deployment`, the homeserver name, set by the
  service last so that it wins. An event older than 24 hours or more than 5
  minutes ahead is dropped.
- `visit`, a random UUID v4 of the body, the same in every tab of one browser
  visit, goes to `data.visit`: twake-user-activity uses it as the PostHog
  `distinct_id`, so funnels hold within a visit and nothing links two visits.
  Another value is ignored, never a 400.
- twake-user-activity 0.2.0 forwards `data.properties` to PostHog; an older
  bridge drops them.
- The exchange is declared as a durable topic exchange, as the bridge does, at
  the first publish. The bridge must have started once, or the exchange routes
  to no queue. Readiness does not depend on the broker.

## Activity

With `HS_TOKEN`, `AMQP_URL` and a `url` in the registration, Synapse sends the
service the events of every room a user of the homeserver is in, and the
service tells the platform about them: CloudEvents on the `activity` exchange,
which twake-webhook-gateway forwards to the webhooks people subscribed, such
as the triggers of n8n.

- `com.twake.chat.message.created.v1`: a message (`m.room.message`) in a direct
  conversation. The room counts two joined members, and one of them, on this
  homeserver, holds it in `m.direct`, as Twake Chat does for a direct
  conversation. The recipient is the other person.
- `com.twake.chat.message.mentioned.v1`: a message that mentions people in
  `m.mentions.user_ids`, in any room. The recipients are the mentioned members
  of the room, the first 50. « @room » tells no one, and neither does a client
  that fills no `m.mentions`: the text of a message is never read.
- An event carries ids only: the Matrix event as `data.object` (`type`
  `message`), its room as the `container` (`kind` `direct` or `room`), the
  sender as `twakeactorid` and the recipients, each with its `uuid` and its
  `reason` (`direct` or `mentioned`). Never the text, a name or an address. A
  subscriber reads the message from Synapse with its own token.
- People are named by the `entryUUID` of their directory entry. A user of
  another homeserver, or one without an entry or whose `entryUUID` the bind
  cannot read, is no recipient: without any, nothing is published, and no
  error says so.
- An event belongs to one organization (`LDAP_ORG_ATTRIBUTE`, none for the
  people without one): people of several organizations get one event each
  organization, as the gateway only matches a subscription of the organization
  of the event. The attribute must hold, in a single value, what the SSO puts
  in the `org_id` claim the gateway reads. Otherwise the events match no
  subscription, and no error says so.
- The gateway also delivers an event to its sender: a subscriber tells a
  mention it made by `twakeactorid`.
- Not published: an encrypted message (the service cannot tell a message from
  an edit or a mention), an edit, a request of device verification, a message
  sent from another homeserver, a message sent to a direct conversation before
  the other person joined it, and anything else that happens in a room.
- The id of an event is derived from the Matrix event, its type and its
  organization: an event Synapse sends twice is published under the same id,
  which the consumers deduplicate on.
- Synapse sends a transaction again until it is answered 200, later each time
  and for as long as it takes, and sends nothing else meanwhile. The service
  answers 502 for what ends by itself only: a failure of the homeserver (an
  error, no answer, its `as_token` refused), of the directory or of the
  broker. No event is lost then, and Synapse keeps them while the service is
  down. A request the homeserver refuses (a room or a user it does not know)
  and an event the service fails on for any other reason are skipped, the
  latter with an `event skipped` error in the logs.
- With a `url` in the registration and no `HS_TOKEN`, the service answers 404
  to every transaction, which Synapse keeps and sends again without end: set
  both or none.
- Each replica remembers the members of a room, `m.direct` of a user for a
  minute, and a directory entry for 10 minutes. The replica that receives a
  membership forgets the members of the room and the `m.direct` of its people
  at once; the others only after the minute. So for up to a minute, a room
  just made direct may not count, and someone who just left a room may still
  be told of a mention.
- The broker user must be allowed to publish on the exchange, which is
  declared as a durable topic exchange at the first publish. The gateway must
  have started once, or the exchange routes to no queue and the events are
  lost. The gateway needs `"chat":{"source":"twake://chat"}` in its
  `PUBLISHERS`.

## Public pages

A room has a read-only web page at `/b/<slug>` (its local alias) or
`/b/<room id>` when anyone may read its history (`world_readable`) and join
it (`public`), it is not encrypted, not a space, its owner turned the page on
(`app.twake.chat.public_page`), and it is in the room directory. Any other
answers 404. Decided in D388 and D398 of the decision log of Twake Chat.

- The service reads the rooms as its own account (`sender_localpart`), never on
  behalf of a user. The registration has no `rooms` namespace, so Synapse
  serves it only what it serves anyone outside the room, event by event.
- A page shows the 30 latest posts with the reactions of members, and the media
  it shows only, up to 50 MiB each. It sends no script and keeps no state: each
  replica keeps a page a minute and the sitemap five minutes.
- The colours of the pages are the Twake palette of `@linagora/twake-css`,
  light or dark as the visitor's system asks, and the colour the owner chose
  for the room. Their stylesheet is `/b/assets/page.css?v=<version>`, kept a
  year by caches: a CDN in front must keep the query string in its cache key.
- Pages and media answer with `cache-control: public, max-age=60`. A page
  turned off is still served for up to a minute by each replica, and a shared
  cache (a CDN) may keep it the `max-age` more.
- Each page names its one address in `<link rel="canonical">`. A link to it
  encoded twice (`%253A` for `:`) is redirected there (301); a proxy in front
  may hand the path on decoded or not, both answer.
- The sitemap lists the rooms of the directory that pass the same checks.
- Twake Chat links to the pages with its own `PUBLIC_PAGES_URL`, set to the
  same address. D388 has it publish a room in the directory as its owner turns
  the page on: the `room_list_publication_rules` of Synapse must let users
  publish.

## LDAP

One entry per Matrix user, found under `LDAP_BASE` by
`LDAP_UID_ATTRIBUTE=<localpart>`, with a single `mail`. `twakeWorkspaceUrl`
(or the older `workspaceUrl`) goes to Meet as `twake_instance` when present.

## Postgres

A database of its own. The service creates its single table, `call_rooms`
(the Meet room of each Matrix room), at startup, so its user needs the right
to create tables. It exits when the database cannot be reached at startup.
Several replicas can share the database.

## Synapse

Synapse 1.160 or later. Copy
[`registration.example.yaml`](../registration.example.yaml), fill in the
`as_token` and any secret as `hs_token`, and list the file in
`app_service_config_files`. Then, in `homeserver.yaml`:

```yaml
experimental_features:
  msc4502_enabled: true # is_joined for application services
```

- Synapse reads the registration at startup only: restart it after any
  change.
- For the [activity](#activity), set `url` to the address of the service as
  Synapse reaches it and give the service the same `hs_token` as `HS_TOKEN`.
  Synapse then sends it every event of the rooms its local users are in, the
  encrypted ones as they are, and asks it about the local users it does not
  know, which the service answers 404. With `url: null`, Synapse sends nothing.
- Only Synapse reads `id` and `sender_localpart`: a registration made with
  other values, such as `twake-chat-visio`, keeps working. To rename it, edit
  the file Synapse loads and restart it. Never list the old and the new file
  together: Synapse refuses two registrations with the same `id` or
  `as_token`.
- The registration lets the `as_token` act as any local user (the `users`
  namespace is `@.*`). Keep it as secret as an admin token.
