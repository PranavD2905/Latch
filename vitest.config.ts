import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Slice 5's background workers (hold-expiry, no-show-eligibility) scan
    // the whole `bookings` table by design — a real background worker has
    // no way to scope itself to "only rows this test file created." Vitest's
    // default file parallelism runs every integration test file against the
    // same real Postgres database concurrently, in separate worker threads;
    // a worker-sweep test in one file can and did expire a HELD booking a
    // different file created moments earlier, whose absolute clock position
    // (each suite freezes its own `Clock` near the same August/September
    // 2026 range) happened to already look past-TTL from the sweeping file's
    // point of view. Every prior suite avoided the *slot*-uniqueness version
    // of this problem by using a distinct calendar day per file; a
    // table-wide scan isn't scoped by day at all, so that trick doesn't
    // reach it. Running files sequentially removes the cross-file race
    // entirely — correctness over wall-clock speed, same call the project
    // already makes for real-Postgres/real-Razorpay tests everywhere else.
    fileParallelism: false,
  },
})
