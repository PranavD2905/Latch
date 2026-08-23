/**
 * Fixed demo IDs, shared between `seed.ts` (which writes them) and anything
 * that needs a default to point at (e.g. `stdio.ts`'s default merchant).
 * Split into its own module with no side effects — `seed.ts` itself runs a
 * top-level `await` that writes to the database, so nothing should import
 * *that* file just to read a constant.
 */
export const SEED_MERCHANT_ID = 'mer_clinic'
export const SEED_PRACTITIONER_ID = 'prac_dr_rao'
export const SEED_SERVICE_ID = 'svc_derm_consult'
