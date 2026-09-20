/**
 * The relay reads its harness session from a store that may not exist yet when
 * the plugin applies — the credential service can activate later, and a harness
 * home that never served the web profile has no record until the Connection
 * mints one. The cases here pin the late arrival: a session that appears after
 * startup must authenticate the next request without a reload.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessSessionProvider } from '../src/harness-session.ts'

const AUTHORITY = '127.0.0.1:3080'
const RECORD = {
  kind: 'grant',
  payload: {
    version: 1,
    secret: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url'),
  },
}

function contextWith(credentials: () => unknown): Context {
  return {
    get: (name: string) => name === 'credentials' ? credentials() : undefined,
  } as unknown as Context
}

describe('HarnessSessionProvider', () => {
  it('mints an authority-bound cookie once the secret appears after startup', async () => {
    let credentials: unknown
    const provider = new HarnessSessionProvider(contextWith(() => credentials))
    expect(await provider.refresh()).toBe(false)
    expect(await provider.cookieFor(AUTHORITY)).toBeUndefined()

    credentials = { readRecord: () => Promise.resolve(RECORD) }
    await expect(provider.cookieFor(AUTHORITY)).resolves.toMatch(/^dsh-auth-[\w-]+=v1\.[\w-]+\.[\w-]+$/)
  })

  it('loads the secret from the request path instead of waiting for a reload', async () => {
    const provider = new HarnessSessionProvider(contextWith(() => ({ readRecord: () => Promise.resolve(RECORD) })))
    expect(provider.available).toBe(false)
    await expect(provider.cookieFor(AUTHORITY)).resolves.toContain('dsh-auth-')
    expect(provider.available).toBe(true)
  })
})
