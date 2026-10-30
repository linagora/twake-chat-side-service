import { describe, expect, it } from 'vitest'
import { readEntry } from './directory.ts'

describe('readEntry', () => {
  it('reads the email in lower case and the Twake instance', () => {
    expect(
      readEntry(
        {
          dn: 'uid=alice,ou=users,dc=example,dc=org',
          mail: 'Alice@Example.org',
          twakeWorkspaceUrl: 'https://alice.example.org',
          entryUUID: '6f1c1b5e-0000-4000-8000-000000000001',
          twakeOrganization: 'acme123'
        },
        'twakeOrganization'
      )
    ).toEqual({
      email: 'alice@example.org',
      twakeInstance: 'https://alice.example.org',
      actorId: '6f1c1b5e-0000-4000-8000-000000000001',
      org: 'acme123'
    })
  })

  it('falls back on the older attribute, whatever case the server writes it in', () => {
    expect(
      readEntry({ mail: 'bob@example.org', workspaceUrl: 'https://bob.org' })
        .twakeInstance
    ).toBe('https://bob.org')
    expect(
      readEntry({ mail: 'bob@example.org', WORKSPACEURL: 'https://bob.org' })
        .twakeInstance
    ).toBe('https://bob.org')
  })

  it('knows no email when the entry has none, or several', () => {
    expect(readEntry(undefined)).toEqual({
      email: null,
      twakeInstance: null,
      actorId: null,
      org: null
    })
    expect(readEntry({ mail: ['a@example.org', 'b@example.org'] }).email).toBe(
      null
    )
    expect(readEntry({ mail: ['a@example.org'] }).email).toBe('a@example.org')
  })
})
