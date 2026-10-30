import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const REQUIRED = {
  AS_TOKEN: 'as',
  MATRIX_HOMESERVER_URL: 'http://synapse:8008',
  MATRIX_SERVER_NAME: 'example.org',
  DATABASE_URL: 'postgres://db/visio',
  MEET_URL: 'https://meet.example.org',
  MEET_CLIENT_ID: 'chat',
  MEET_CLIENT_SECRET: 'meet-secret',
  MEET_SERVICE_ACCOUNT_EMAIL: 'calls@example.org',
  LDAP_URL: 'ldap://ldap',
  LDAP_BASE: 'ou=users,dc=example,dc=org'
}

describe('loadConfig', () => {
  it('reads the environment, with its defaults', () => {
    expect(loadConfig(REQUIRED)).toEqual({
      ...REQUIRED,
      LDAP_UID_ATTRIBUTE: 'uid',
      ASSISTANTS_SCOPE: 'openid',
      ASSISTANTS_REQUESTS_PER_MINUTE: 60,
      ANALYTICS_BATCHES_PER_MINUTE: 60,
      HTTP_HOST: '0.0.0.0',
      HTTP_PORT: 8080,
      LOG_LEVEL: 'info'
    })
  })

  it('reads the broker and the organization attribute, both optional', () => {
    expect(loadConfig(REQUIRED)).not.toHaveProperty('AMQP_URL')
    expect(
      loadConfig({
        ...REQUIRED,
        AMQP_URL: 'amqp://rabbitmq:5672',
        LDAP_ORG_ATTRIBUTE: 'twakeOrganization'
      })
    ).toMatchObject({
      AMQP_URL: 'amqp://rabbitmq:5672',
      LDAP_ORG_ATTRIBUTE: 'twakeOrganization'
    })
    expect(() => loadConfig({ ...REQUIRED, AMQP_URL: 'http://x' })).toThrow(
      'AMQP_URL'
    )
  })

  it('takes an empty variable as unset', () => {
    expect(loadConfig({ ...REQUIRED, HTTP_PORT: '' }).HTTP_PORT).toBe(8080)
  })

  it('names every missing or invalid variable', () => {
    expect(() =>
      loadConfig({ ...REQUIRED, AS_TOKEN: '', DATABASE_URL: 'mysql://db' })
    ).toThrow(/AS_TOKEN.*DATABASE_URL|DATABASE_URL.*AS_TOKEN/)
  })

  it('wants the password of a bind DN', () => {
    expect(() =>
      loadConfig({ ...REQUIRED, LDAP_BIND_DN: 'cn=admin,dc=example,dc=org' })
    ).toThrow('LDAP_BIND_PASSWORD: required with LDAP_BIND_DN')
  })

  it('serves the assistants with the whole harness only', () => {
    const harness = {
      ASSISTANTS_URL: 'http://apisix/b2b/agents',
      ASSISTANTS_TOKEN_URL: 'https://auth.example.org/oauth2/token',
      ASSISTANTS_CLIENT_ID: 'chat-side-service',
      ASSISTANTS_CLIENT_SECRET: 'secret'
    }

    expect(loadConfig({ ...REQUIRED, ...harness })).toMatchObject(harness)
    expect(() =>
      loadConfig({ ...REQUIRED, ASSISTANTS_URL: harness.ASSISTANTS_URL })
    ).toThrow('ASSISTANTS_TOKEN_URL: required with the others')
  })

  it('serves the public pages with their address and the one of Chat only', () => {
    expect(() =>
      loadConfig({ ...REQUIRED, PUBLIC_PAGES_URL: 'https://pages.example.org' })
    ).toThrow('CHAT_URL: required with the others')
  })
})
