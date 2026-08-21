/**
 * The relay's transport identity.
 *
 * Three postures, and which one is right depends on who is connecting:
 *
 * - `files` is the browser answer. A certificate a browser already trusts
 *   (mkcert on the LAN, an ACME certificate on a forwarded name) is the only
 *   way a phone browser reaches the relay without an interstitial warning.
 * - `self-signed` is the pinning answer. The relay mints its own certificate
 *   and publishes the SHA-256 of its SubjectPublicKeyInfo; a client that pins
 *   that value gets real transport security with no certificate authority
 *   involved. Browsers will still warn.
 * - `off` serves plaintext. DSH Mobile 0.5.0 hardcodes `http://` for both its
 *   RPC calls and its two WebSocket downlinks, so this is the only posture it
 *   can reach — hence the separate plain-HTTP compatibility listener rather
 *   than making the whole relay give up TLS for one client.
 * @module dsh-relay/tls
 */

import { X509Certificate, createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { localAddresses } from './fence.ts'
import type { CertificateRecord } from './state.ts'

/** Owner-only permissions. A no-op on Windows — see {@link loadCertificate}. */
const SECRET_MODE = 0o600

/** File name of the generated certificate. */
const CERT_FILE = 'relay-cert.pem'

/** File name of the generated private key. */
const KEY_FILE = 'relay-key.pem'

/** How long a generated certificate stays valid. */
const VALIDITY_DAYS = 825

/** subjectAltName type codes from RFC 5280, as `selfsigned` spells them. */
const SAN_DNS = 2
const SAN_IP = 7

/** A loaded key pair plus the identity a pinning client compares. */
export interface TlsMaterial {
  readonly cert: string
  readonly key: string
  readonly record: CertificateRecord
}

/** The `selfsigned` surface this module uses. */
interface SelfSigned {
  generate(
    attrs: readonly { name: string, value: string }[],
    options: Record<string, unknown>,
  ): Promise<{ cert: string, private: string }>
}

/**
 * SHA-256 of a certificate's DER SubjectPublicKeyInfo, base64.
 *
 * This is the value a pinning client compares, and it is deliberately the
 * public key rather than the whole certificate: renewing with the same key
 * then leaves every paired device working.
 * @param certPem - the certificate, PEM encoded.
 * @returns the base64 digest.
 */
export function spkiFingerprint(certPem: string): string {
  const spki = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(spki).digest('base64')
}

/**
 * The names a generated certificate must cover.
 * @param publicHostnames - names a forwarded deployment is reached by.
 * @returns DNS names and IP literals, deduplicated.
 */
export function certificateSans(publicHostnames: readonly string[]): string[] {
  return [...new Set(['localhost', '127.0.0.1', ...localAddresses(), ...publicHostnames])]
}

/**
 * Generate a certificate and write it beside the state file.
 * @param dir - the relay state directory.
 * @param sans - subject alternative names to cover.
 * @returns the generated material.
 */
async function generate(dir: string, sans: readonly string[]): Promise<TlsMaterial> {
  const { default: selfsigned } = await import('selfsigned') as unknown as { default: SelfSigned }
  const notBefore = new Date()
  const notAfter = new Date(notBefore.getTime() + VALIDITY_DAYS * 86_400_000)
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'dsh-relay' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: sans.map(value => (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)
          ? { type: SAN_IP, ip: value }
          : { type: SAN_DNS, value })),
      },
    ],
  })
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, CERT_FILE), pems.cert, { mode: SECRET_MODE })
  await writeFile(join(dir, KEY_FILE), pems.private, { mode: SECRET_MODE })
  return {
    cert: pems.cert,
    key: pems.private,
    record: {
      fingerprint: spkiFingerprint(pems.cert),
      sans: [...sans],
      generatedAt: notBefore.getTime(),
      expiresAt: notAfter.getTime(),
    },
  }
}

/**
 * Load the certificate for the configured posture, generating one if needed.
 *
 * A generated certificate is regenerated when it has expired or when the set
 * of addresses it covers has changed — a laptop that moved networks would
 * otherwise present a certificate naming an address it no longer has.
 *
 * The private key is written mode 0600. **That is a no-op on Windows**, where
 * the file inherits the ACL of the harness home directory; a deployment that
 * shares that directory should restrict it with `icacls` or point `tls` at
 * files it manages itself.
 * @param options.mode - the configured posture; `off` returns undefined.
 * @param options.dir - the relay state directory.
 * @param options.certPath - operator-supplied certificate, for `files`.
 * @param options.keyPath - operator-supplied key, for `files`.
 * @param options.sans - names a generated certificate must cover.
 * @param options.existing - the certificate record from durable state, if any.
 * @returns the material to hand `https.createServer`, or undefined for plaintext.
 */
export async function loadCertificate(options: {
  readonly mode: 'self-signed' | 'files' | 'off'
  readonly dir: string
  readonly certPath: string
  readonly keyPath: string
  readonly sans: readonly string[]
  readonly existing?: CertificateRecord | undefined
}): Promise<TlsMaterial | undefined> {
  if (options.mode === 'off') return undefined
  if (options.mode === 'files') {
    const [cert, key] = await Promise.all([
      readFile(options.certPath, 'utf8'),
      readFile(options.keyPath, 'utf8'),
    ])
    const parsed = new X509Certificate(cert)
    return {
      cert,
      key,
      record: {
        fingerprint: spkiFingerprint(cert),
        sans: [...options.sans],
        generatedAt: Date.parse(parsed.validFrom),
        expiresAt: Date.parse(parsed.validTo),
      },
    }
  }

  const wanted = [...options.sans].toSorted().join(',')
  const covered = options.existing !== undefined && [...options.existing.sans].toSorted().join(',') === wanted
  if (options.existing !== undefined && covered && Date.now() < options.existing.expiresAt) {
    try {
      const [cert, key] = await Promise.all([
        readFile(join(options.dir, CERT_FILE), 'utf8'),
        readFile(join(options.dir, KEY_FILE), 'utf8'),
      ])
      await chmod(join(options.dir, KEY_FILE), SECRET_MODE).catch(() => undefined)
      return { cert, key, record: options.existing }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return generate(options.dir, options.sans)
}
