# Session prompts

One file per slice from `docs/06-build-sequence.md`. Each is **self-contained** — paste it into a
fresh Claude Code session in this directory and it will have everything it needs.

```bash
cat prompts/slice-0.md | pbcopy     # then paste into a new session
```

## Why one session per slice

Context windows fill. A session that has been running since Slice 0 has burned most of its context on
work that is already committed and no longer relevant. Starting fresh per slice keeps the model
reasoning about the current problem rather than re-reading its own history.

The docs on disk are the shared memory. Every prompt begins by telling the session to read them.

## Rules that make this work

1. **Finish a slice before starting the next.** Each prompt assumes the previous slices are done and
   committed.
2. **Each session writes a dev log before it ends.** That is how the next session learns what
   actually happened, versus what was planned.
3. **If a session discovers something that contradicts the docs, it must update the docs**, not just
   work around it. The docs are the memory — stale docs poison every later session.
4. **Read the last dev log** before starting. The prompts tell each session to do this.

## Order

| Slice | File | Ends with |
|---|---|---|
| 0 | `slice-0.md` | Event store works; a booking folds out of events |
| 1 | `slice-1.md` | Agent books end to end, fake payments |
| 2 | `slice-2.md` | Real Razorpay test-mode deposit captured |
| 3 | `slice-3.md` | ⭐ The failure path works end to end |
| 4 | `slice-4.md` | ⭐ Authorisations + the ceiling refusal demo |
| 5 | `slice-5.md` | Cancel, reschedule, background worker |
| 6 | `slice-6.md` | Live audit trail viewer |
| 7 | `slice-7.md` | Deployed; a remote agent connects |
| 8 | `slice-8.md` | Concurrency, races, idempotency proven |
| 9 | `slice-9.md` | Video + submission |

Slices 3 and 4 are the two that carry the submission. If time runs short, they are the ones that must
be right.
