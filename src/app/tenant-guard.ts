/**
 * Migration 0011 — real multi-tenant auth. Every booking/practitioner/service
 * row now carries the `merchantId` that owns it (see `postgres-event-store.ts`,
 * `postgres-catalog-repo.ts`); this is the one place that check happens, so
 * every command handler enforces it the same way instead of each reimplementing
 * an equality check that's easy to forget on one call site and not another.
 *
 * A `bookingId`/`practitionerId`/`serviceId` is a ULID — not guessable — so
 * this is defense in depth, not the only thing standing between merchant A
 * and merchant B's data. But "real" multi-tenant auth means the boundary is
 * enforced at every read, not just trusted to hold because IDs are long
 * random strings. A mismatch is treated identically to "doesn't exist" —
 * never a distinguishable error — so a caller learns nothing about whether
 * the id belongs to someone else.
 */
export function ownedByMerchant<T extends { merchantId: string }>(record: T | undefined, merchantId: string): T | undefined {
  if (!record || record.merchantId !== merchantId) return undefined
  return record
}
