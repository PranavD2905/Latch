/**
 * `.env` only exists on a local dev machine. A real deployment (Railway,
 * or anywhere else) injects environment variables directly into
 * `process.env` — there is no `.env` file on disk, since it's gitignored
 * and never part of the deployed image.
 *
 * `process.loadEnvFile()` throws `ENOENT` when the file is missing, with or
 * without an explicit path (verified on Node 22) — the optional-chained
 * `process.loadEnvFile?.('.env')` used everywhere pre-Slice-7 only guards
 * against the *function* not existing on older Node, not against the file
 * not existing. Every entrypoint that might run deployed needs this instead.
 */
export function loadEnvFile(): void {
  try {
    process.loadEnvFile?.('.env')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
