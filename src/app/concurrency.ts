/**
 * A small worker-pool: runs `fn` over `items` with at most `limit` calls
 * in flight at once, rather than either fully sequential (slow — cost scales
 * linearly with `items.length` even though each call is I/O-bound and
 * mostly waiting) or fully parallel (`Promise.all` over everything — no
 * ceiling on concurrent outbound calls, which for a payment-provider API is
 * how you get rate-limited). No external dependency: this is the entire
 * shape p-limit/p-map provide, sized for what `reconciliation-worker.ts`
 * needs and nothing more.
 *
 * On the first rejection, the shared `nextIndex` counter stops handing out
 * new work but in-flight calls are not cancelled — same "let concurrent work
 * finish, then propagate" semantics `Promise.all` already has, just bounded.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const current = nextIndex++
      if (current >= items.length) return
      results[current] = await fn(items[current] as T, current)
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
