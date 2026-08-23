# Slice 7 — Deploy and connect a remote agent

You are working on **Latch**, at `/Users/pranavd2905/Documents/projects/Latch`.

Latch exposes an Indian dermatology clinic to any third-party AI agent over MCP. Razorpay AI
Buildathon 2026, Track 01.

**Slices 0–6 are complete**: all seven tools, real Razorpay test mode, the failure path, mandates, and
a live audit trail viewer. Everything currently runs locally over stdio.

## Why this slice matters more than it looks

Latch's entire claim is that **any third-party agent can transact with a merchant without a partnership
or an integration deal.**

An MCP server over stdio does not demonstrate that. stdio means the agent spawns our server as a
subprocess on the same machine — that demos as a local script, not as a merchant reachable over the
internet. `docs/02-tech-stack.md` §3 is explicit: *"the transport should embody the claim."*

**Do not leave this to the end.** A demo that only runs locally quietly undercuts the thesis, and a
judge will notice.

## Read before writing any code

- `docs/02-tech-stack.md` §3 (transport), §14 (hosting)
- `docs/05-cost-model.md` Part 3, Tier 0 — what this should cost
- **The most recent `dev-logs/` entry**

## Build this

**1. Switch MCP to Streamable HTTP**

Keep stdio wired up for local iteration — it stays useful. But HTTP is the deployed path.

**2. Deploy to Railway** — app + managed Postgres, per `docs/02-tech-stack.md` §14.

Rejected alternatives are recorded there: Vercel cannot host a long-lived SSE stream or an in-process
background worker; AWS is correct at scale and wrong for a two-week build.

Needed:
- Migrations run on deploy
- `DATABASE_URL` and Razorpay **test-mode** keys as environment variables — never committed
- Public HTTPS (the transport requires it)
- The background worker running in the deployed process

**3. Seed script** — one command to a demo-ready state: clinic, Dr. Rao, services, policy v4, working
hours. You will run this repeatedly while rehearsing the video; make it idempotent and fast.

**4. Connect a remote agent to the deployed endpoint**

This is the actual deliverable. A real agent, running somewhere else, transacting with a merchant over
the public internet.

**5. Verify the viewer works deployed** — SSE through Railway's proxy can behave differently from
localhost. Watch for buffering and idle-connection timeouts. If the stream stalls, check proxy
buffering settings before rewriting anything.

## Watch for

- **Timezone.** The server must reason in IST for a clinic in India. Verify ladder tiers compute
  correctly against a deployed server whose system clock is UTC — this is a classic place for an
  off-by-five-and-a-half-hours bug, and it would corrupt money decisions.
- **Connection pooling.** Managed Postgres has connection limits; a pool sized for localhost may
  exhaust them.
- **Cold starts** must not break the background worker.

## Done when

- A public HTTPS MCP endpoint is live
- A **remote** agent completes a full booking against it
- The full failure path works deployed, verified against the Razorpay test dashboard
- The viewer streams live from the deployed server
- The seed script resets to demo state in one command
- Ladder boundaries are correct on a UTC server for an IST clinic
- Cost is in line with `docs/05-cost-model.md` Tier 0 (≈$6–12/mo) — if it is materially more, record why

## Out of scope

Hardening tests (Slice 8), the video (Slice 9), custom domains, HA, multi-region.

## Before you finish

Write the next `dev-logs/` entry, including the live endpoint URL and anything that behaved differently
deployed than locally.
