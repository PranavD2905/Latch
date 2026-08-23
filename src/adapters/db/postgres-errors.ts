/**
 * postgres.js's `PostgresError` shape, matched structurally rather than by
 * `instanceof` — shared by every call site that needs to translate a
 * unique-violation on the partial index (`one_live_booking_per_slot`) into a
 * domain refusal (`hold_slot`'s `SLOT_TAKEN`, `reschedule`'s target-slot
 * check). Extracted in Slice 5 once a second call site needed it — see
 * dev-logs/010.
 */
export function isUniqueViolation(err: unknown, constraintName: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505' &&
    'constraint_name' in err &&
    (err as { constraint_name?: unknown }).constraint_name === constraintName
  )
}
