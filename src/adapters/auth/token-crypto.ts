import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createHash } from 'node:crypto'

/**
 * Migration 0011 — the token shape a `merchant_credentials` row is issued
 * and verified against. Same idea as Stripe's `sk_live_...`: the prefix is
 * safe to put in an indexed database column (or a log line) because on its
 * own it grants nothing; the full token is the actual secret, and only its
 * hash — never the plaintext — is ever persisted.
 */
const TOKEN_BYTE_LENGTH = 24 // 24 random bytes -> 48 hex chars of secret material
const PREFIX_HEX_LENGTH = 12 // indexed lookup key, taken off the front of that hex string

export interface GeneratedToken {
  /** Shown to the caller exactly once, at issuance. Never stored. */
  token: string
  /** Stored, indexed — the fast lookup key for `verifyToken`. */
  prefix: string
  /** Stored — SHA-256 of the full token, hex-encoded. */
  hash: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** `sk_merchant_<48 hex chars>` — the `sk_merchant_` marker only helps a human/log reader recognise the shape; it carries no security weight of its own. */
export function generateMerchantToken(): GeneratedToken {
  const secret = randomBytes(TOKEN_BYTE_LENGTH).toString('hex')
  const token = `sk_merchant_${secret}`
  return { token, prefix: secret.slice(0, PREFIX_HEX_LENGTH), hash: hashToken(token) }
}

export function prefixOf(token: string): string | undefined {
  const marker = 'sk_merchant_'
  if (!token.startsWith(marker)) return undefined
  return token.slice(marker.length, marker.length + PREFIX_HEX_LENGTH)
}

/**
 * Constant-time comparison against the stored hash — a presented token is
 * attacker-controlled input, so string `===` (which short-circuits on the
 * first mismatched byte) would leak timing information about how much of
 * the hash matched. The prefix-indexed lookup that gets us to one candidate
 * row first doesn't need this treatment (it's not comparing secret material
 * byte-for-byte against a guess), but the hash comparison itself does.
 */
export function hashesMatch(candidateToken: string, storedHash: string): boolean {
  const candidateHash = Buffer.from(hashToken(candidateToken), 'hex')
  const stored = Buffer.from(storedHash, 'hex')
  if (candidateHash.length !== stored.length) return false
  return timingSafeEqual(candidateHash, stored)
}
