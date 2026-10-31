import { call, RefusedError, readJson, UpstreamError } from './upstream.ts'

const TOKEN_PATH = '/external-api/v1.0/application/token/'
const ROOMS_PATH = '/external-api/v1.0/rooms/'

export interface MeetSettings {
  url: string
  clientId: string
  clientSecret: string
  /** The owner of the Meet rooms of the calls: a service account, no human. */
  serviceAccountEmail: string
}

/** What Meet puts in the LiveKit token of a participant. */
export interface Participant {
  /** `@user:server:device`: Meet reads the Matrix ids back from it. */
  identity: string
  username: string
  role: 'administrator' | 'member'
  twake_instance?: string
}

/** Where the media go, and the token for it. */
export interface CallToken {
  url: string
  token: string
}

/** The external API of Meet, as an application acting for its users. */
export class Meet {
  #settings: MeetSettings
  #url: string

  constructor(settings: MeetSettings) {
    this.#settings = settings
    this.#url = settings.url.replace(/\/+$/, '')
  }

  /**
   * A room owned by the service account, restricted: nobody enters it through the interface of Meet.
   * Any participant of the call may record it: the owner is no human, so the default
   * (owners and administrators) would let nobody.
   */
  async createRoom(): Promise<string> {
    const token = await this.#applicationToken(
      this.#settings.serviceAccountEmail
    )
    const body = await readJson(
      'meet',
      ROOMS_PATH,
      await this.#post(
        ROOMS_PATH,
        {
          access_level: 'restricted',
          configuration: { screen_recording_permission: 'authenticated' }
        },
        token
      )
    )
    if (typeof body.id !== 'string' || !body.id) {
      throw new UpstreamError('meet', `${ROOMS_PATH} answered no room id`)
    }

    return body.id
  }

  /** The LiveKit token of the user of `email`, or null when Meet no longer has the room (a JSON 404, or a 410). */
  async livekitToken(
    meetRoomId: string,
    email: string,
    participant: Participant
  ): Promise<CallToken | null> {
    const token = await this.#applicationToken(email, { isUser: true })
    const path = `${ROOMS_PATH}${encodeURIComponent(meetRoomId)}/livekit-token/`
    const response = await this.#post(path, { ...participant }, token)
    // A Meet without the route answers the HTML 404 of Django: the room is not to blame then.
    // The Meet of suitenumerique/meet#1796 answers 410 for a room it deleted.
    if (
      response.status === 410 ||
      (response.status === 404 &&
        response.headers.get('content-type')?.includes('application/json'))
    ) {
      return null
    }
    const body = await readJson('meet', path, response)
    if (
      typeof body.url !== 'string' ||
      !body.url ||
      typeof body.token !== 'string' ||
      !body.token
    ) {
      throw new UpstreamError('meet', `${path} answered no url or no token`)
    }

    return { url: body.url, token: body.token }
  }

  async #applicationToken(
    email: string,
    { isUser = false } = {}
  ): Promise<string> {
    const response = await this.#post(TOKEN_PATH, {
      client_id: this.#settings.clientId,
      client_secret: this.#settings.clientSecret,
      grant_type: 'client_credentials',
      scope: email
    })
    // A domain the application may not act for (403), or no account and no creation (404)
    if (isUser && (response.status === 403 || response.status === 404)) {
      throw new RefusedError(
        `Meet refuses to act for this user (${String(response.status)})`
      )
    }
    const body = await readJson('meet', TOKEN_PATH, response)
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new UpstreamError('meet', `${TOKEN_PATH} answered no access token`)
    }

    return body.access_token
  }

  #post(
    path: string,
    body: Record<string, unknown>,
    token?: string
  ): Promise<Response> {
    return call('meet', `${this.#url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token && { authorization: `Bearer ${token}` })
      },
      body: JSON.stringify(body)
    })
  }
}
