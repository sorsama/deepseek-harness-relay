/**
 * The sign-in password, stored as a salted scrypt hash.
 *
 * Verification is deliberately kept off the request hot path: it costs tens of
 * milliseconds by design, and the mobile client opens two WebSockets inside a
 * 3-second budget. Only `POST /relay/login` verifies a password; everything
 * after it presents a signed cookie that verifies with one HMAC.
 * @module dsh-relay/auth/password
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { PasswordRecord } from '../state.ts'

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number, r: number, p: number, maxmem: number },
) => Promise<Buffer>

/**
 * scrypt work factor. Raising it later stays verifiable because each record
 * carries the cost it was written with.
 */
const DEFAULT_COST = 16384

/** scrypt block size. */
const BLOCK_SIZE = 8

/** scrypt parallelization. */
const PARALLELISM = 1

/** Derived key length in bytes. */
const KEY_LENGTH = 64

/** Bytes of salt per record. */
const SALT_BYTES = 16

/**
 * Node's default maxmem (32 MiB) is below what N=16384, r=8 needs; state the
 * requirement rather than lowering the work factor to fit the default.
 * @param cost - the scrypt N parameter.
 * @returns the memory ceiling to pass to scrypt.
 */
function maxmemFor(cost: number): number {
  return 256 * cost * BLOCK_SIZE * 2
}

/**
 * Hash a password for storage.
 * @param password - the plaintext, as typed.
 * @returns the record to persist; the plaintext is never retained.
 */
export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(SALT_BYTES)
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: DEFAULT_COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: maxmemFor(DEFAULT_COST),
  })
  return {
    salt: salt.toString('hex'),
    hash: derived.toString('hex'),
    cost: DEFAULT_COST,
    updatedAt: Date.now(),
  }
}

/**
 * Verify a candidate password against a stored record.
 * @param record - the stored credential.
 * @param candidate - the plaintext to check.
 * @returns true on a match; comparison is constant time in the hash length.
 */
export async function verifyPassword(record: PasswordRecord, candidate: string): Promise<boolean> {
  const expected = Buffer.from(record.hash, 'hex')
  const derived = await scryptAsync(candidate.normalize('NFKC'), Buffer.from(record.salt, 'hex'), expected.length, {
    N: record.cost,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: maxmemFor(record.cost),
  })
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}
