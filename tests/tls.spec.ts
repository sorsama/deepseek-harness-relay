/**
 * The relay's transport identity: the self-signed certificate lifecycle.
 *
 * Paired devices pin the SHA-256 of the key's SubjectPublicKeyInfo
 * (`spkiFingerprint`), not the certificate. Every rotation test here
 * therefore asserts on that fingerprint: a re-issue must preserve it, or
 * every paired device's pin dies. That is exactly what the 2026-10-19
 * outage violated — a shrunken address set at start minted a new key and
 * orphaned the phone until re-pairing (issue #114).
 */
import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCertificate, spkiFingerprint, type TlsMaterial } from '../src/tls.ts'

const BASE_SANS = ['localhost', '127.0.0.1', '10.0.0.5']

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-relay-tls-'))
}

async function firstBoot(dir: string, sans: readonly string[]): Promise<TlsMaterial> {
  const material = await loadCertificate({
    mode: 'self-signed',
    dir,
    certPath: '',
    keyPath: '',
    sans,
    existing: undefined,
  })
  if (material === undefined) throw new Error('first boot must mint a certificate')
  return material
}

describe('loadCertificate (self-signed)', () => {
  it('mints a key pair and certificate on first boot', async () => {
    const dir = await freshDir()
    try {
      const material = await firstBoot(dir, BASE_SANS)
      expect(material.record.fingerprint).toMatch(/^[A-Za-z0-9+/]{43}=$/)
      expect([...material.record.sans].toSorted()).toEqual([...BASE_SANS].toSorted())
      expect(material.record.expiresAt).toBeGreaterThan(material.record.generatedAt)
      expect(await readFile(join(dir, 'relay-cert.pem'), 'utf8')).toContain('BEGIN CERTIFICATE')
      expect(await readFile(join(dir, 'relay-key.pem'), 'utf8')).toContain('PRIVATE KEY')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the stored certificate when the address set is unchanged', async () => {
    const dir = await freshDir()
    try {
      const first = await firstBoot(dir, BASE_SANS)
      const second = await loadCertificate({
        mode: 'self-signed',
        dir,
        certPath: '',
        keyPath: '',
        sans: BASE_SANS,
        existing: first.record,
      })
      expect(second?.record).toEqual(first.record)
      // The stored certificate still carries the stored identity.
      const certPem = await readFile(join(dir, 'relay-cert.pem'), 'utf8')
      expect(spkiFingerprint(certPem)).toBe(first.record.fingerprint)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('re-issues on the same key when the address set changes (issue #114)', async () => {
    const dir = await freshDir()
    try {
      const first = await firstBoot(dir, BASE_SANS)
      // A laptop moved networks: the old address is gone, a new one arrived.
      const moved = await loadCertificate({
        mode: 'self-signed',
        dir,
        certPath: '',
        keyPath: '',
        sans: ['localhost', '127.0.0.1', '10.0.0.9'],
        existing: first.record,
      })
      if (moved === undefined) throw new Error('a changed address set must still serve a certificate')
      // The pin is over the key. A paired device keeps working only if the
      // re-issue preserved the key.
      expect(moved.record.fingerprint).toBe(first.record.fingerprint)
      expect([...moved.record.sans].toSorted()).toEqual(['10.0.0.9', '127.0.0.1', 'localhost'])
      // The on-disk certificate now names the new address, signed by the same key.
      const certPem = await readFile(join(dir, 'relay-cert.pem'), 'utf8')
      expect(spkiFingerprint(certPem)).toBe(first.record.fingerprint)
      expect(new X509Certificate(certPem).subjectAltName).toContain('IP Address:10.0.0.9')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('re-issues on the same key when the cert file is missing but the key remains (issue #114)', async () => {
    const dir = await freshDir()
    try {
      const first = await firstBoot(dir, BASE_SANS)
      await rm(join(dir, 'relay-cert.pem'))
      const rebuilt = await loadCertificate({
        mode: 'self-signed',
        dir,
        certPath: '',
        keyPath: '',
        sans: BASE_SANS,
        existing: first.record,
      })
      if (rebuilt === undefined) throw new Error('a missing cert file must still serve a certificate')
      expect(rebuilt.record.fingerprint).toBe(first.record.fingerprint)
      expect(await readFile(join(dir, 'relay-cert.pem'), 'utf8')).toContain('BEGIN CERTIFICATE')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
