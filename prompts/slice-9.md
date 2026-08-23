# Slice 9 — Submission

You are working on **Latch**, at `/Users/pranavd2905/Documents/projects/Latch`.

Razorpay AI Buildathon 2026, Track 01. **Slices 0–8 are complete and deployed.**

This session produces the submission itself. Razorpay requires three things:

1. A public repo
2. A 5-minute pitch video
3. **A story of a failure and the recovery from it during the making of the project**

## Read first

- All of `dev-logs/` **in order** — this is the raw material for the failure story
- `docs/06-build-sequence.md` — the video structure, with timings
- `docs/04-features-and-limitations.md` §2.3 — prepared answers to the three likely judge questions
- `README.md`
- `agentic-services-transactability-brief.md` §7 — the risk table

## 1. ⚠️ Re-verify the competitive landscape — do this first

The brief closes with: *"The agentic commerce landscape is moving on a weekly cadence; re-verify
Razorpay's changelog, the UCP roadmap, and the vertical SaaS agent announcements before relying on any
occupancy claim in this document."*

Check now, before writing any pitch copy:
- **Razorpay changelog and blog** — did they ship a booking or appointment primitive?
- **UCP roadmap / GitHub** — is there an appointments or local-services vertical? It went Shopping →
  Lodging → Food; local services is a plausible fourth.
- **Zenoti and vertical SaaS** — has anyone shipped an agent-facing MCP endpoint?

If any of these has moved, **the pitch must acknowledge it honestly.** A judge who knows their own
product roadmap will notice a stale claim immediately, and it costs more credibility than the gap
itself was worth. Adjust the framing; do not quietly leave the old claim standing.

## 2. Pick the failure-and-recovery story

Candidates are tracked in `dev-logs/002` and accumulated through every later log. Judge them on:

- **Real** — it actually happened, with a dated log entry proving it
- **Architectural** — it changed a decision, not just a line of code
- **The recovery is interesting** — ideally the outcome was *better* than the original plan

The leading candidate from design: the **payment-rail collapse** (`dev-logs/001` then `dev-logs/005`). The brief's whole
money architecture rested on Reserve Pay; it has no public API. The obvious fallback (card
authorise-then-capture) was worse — Razorpay auto-refunds uncaptured authorisations in ~3 days, and
appointments are booked weeks out. The recovery was card manual-capture authorisations, which turned out **stronger
than the original plan**, because authorising at exactly the fee leaves zero headroom — a tighter bound than the ceiling-with-slack the brief assumed, still enforced by the rail rather than by us.

Check the implementation logs for anything better — a real race caught in Slice 8, or test-mode authorisation
behaviour diverging from the docs in Slice 4, could be more compelling because it has more drama.

Write it up as `docs/07-failure-and-recovery.md`: what was planned, what broke, how it was diagnosed,
what changed, and **why the outcome was better**. Link the dated dev logs — they are the evidence that
it is real and not a story constructed afterwards.

## 3. The video — 5 minutes

Structure and timings are in `docs/06-build-sequence.md`. The beats:

| Time | Beat |
|---|---|
| 0:00–0:30 | *"Book me a dermatologist Thursday."* It can find one. It can't book one |
| 0:30–1:00 | Every protocol assumes a SKU. UCP: Shopping, Lodging, Food. No appointments primitive exists |
| 1:00–2:00 | **Live:** real agent holds a slot, reads the ladder, pays a deposit. Trail streaming beside it |
| 2:00–2:45 | **The bound.** Attempt an over-ceiling charge. Razorpay refuses. *"This isn't caught. It's impossible."* |
| 2:45–3:45 | **The failure.** Doctor sick → decline → refund → authorisation released → alternatives. ₹0, no human |
| 3:45–4:30 | Architecture: trail as source of truth; four mandatory fields; bound outside our trust boundary |
| 4:30–5:00 | The money. ₹3L/month evaporating per clinic; no-show revenue 100% incremental to Razorpay |

**The 2:00–2:45 beat is the differentiator.** Every submission will claim bounded money actions. Almost
none will show their own server ask for money and be refused by the rail. Rehearse it until it is
clean.

Two things to protect:
- **Run against the deployed endpoint**, not localhost. The claim is that a remote agent reaches a
  merchant over the internet — show that.
- **Do not narrate the architecture over a static diagram.** Show the system doing the thing, then
  explain why it is shaped that way. Demo first, architecture second.

## 4. Repo tidy

- `README.md` current and accurate — it is the recruiter's first 60 seconds
- No secrets committed. Check git history, not just the working tree.
- `.env.example` complete
- Setup instructions that a stranger can actually follow
- All tests passing; note how to run them
- Dev logs left in place — **they are evidence of how you work**, and given no resume screening, that
  matters more here than usual
- Link `docs/07-failure-and-recovery.md` from the README

## 5. Final check against the bar

Walk `agentic-services-transactability-brief.md` §6.5 clause by clause and confirm each is
demonstrable in the video, not merely true in the code:

- **B1** every money action individually specified — seven tools, four move money
- **B2** explainable — ladder machine-readable and acknowledged before commitment
- **B3** bounded — authorisation ceiling, unique index, server clock
- **B4** gated — no money action fires on agent inference
- **B5** trail shown, and one failure handled gracefully

If a clause is true in code but invisible in the video, **fix the video.** The bar says *show*.

## Done when

- Landscape re-verified and any changes reflected honestly in the pitch
- `docs/07-failure-and-recovery.md` written and linked
- Video recorded, under 5 minutes, running against the deployed endpoint
- Repo public, clean, no secrets, reproducible setup
- Every bar clause visibly demonstrated
