# Slice 6 — The live audit trail viewer

You are working on **Latch**, at `/Users/pranavd2905/Documents/projects/Latch`.

Latch exposes an Indian dermatology clinic to any third-party AI agent over MCP. Razorpay AI
Buildathon 2026, Track 01.

**Slices 0–5 are complete**: all seven MCP tools work against real Razorpay test mode, the
merchant-decline failure path works, mandates carry real ceilings, and background workers run.

## What this slice is for

Razorpay's bar (**B5**) says *"Show the audit trail."* Not log it — **show** it. The docs are explicit
that the trail must be *"a first-class demo artifact, rendered legibly, not a log file."*

**This is a product surface, not a debug page.** It is one of exactly two things a judge looks at (the
other is the agent transacting). Treat it accordingly.

## Read before writing any code

- `docs/03-domain-model.md` §4 (the four mandatory fields) and §6 (the worked trace — **this is what
  the viewer must render beautifully**)
- `docs/01-architecture.md` §1 Idea 2
- `docs/02-tech-stack.md` §10 (why SSE, not WebSocket), §11
- **The most recent `dev-logs/` entry**

## Build this

**1. SSE endpoint** streaming events as they are appended.

Server-Sent Events, not WebSocket — data flows one way and the browser's `EventSource` reconnects
automatically. Reasoning in `docs/02-tech-stack.md` §10.

Must support: replaying existing events on connect, then streaming new ones live. The demo needs to
open the page mid-flow and see history plus everything that follows.

**2. React + Vite + Tailwind viewer**

The trail as a live list, newest activity visible without scrolling. Each event expands to show its
four fields.

**3. ⭐ Make `bound.enforced_by` visually different**

This is the most important design decision in the UI. The enum has three values of genuinely different
strength:

```
latch_policy      — our own code. A bug could defeat it.
db_constraint     — a Postgres unique index. Cannot be raced.
razorpay_mandate  — enforced at the rail. Cannot be defeated even by a compromised Latch server.
```

A judge should be able to see *at a glance* which bounds we merely assert and which are structurally
enforced outside our trust boundary. That distinction is the project's strongest claim and it must be
legible in a five-minute video watched at speed — probably compressed, possibly on a phone.

Do not make this a subtle grey badge. Make it obvious.

**4. Render money actions so a rupee can be traced**

Direction (in/out), amount, and instrument. Someone should be able to read the trail top to bottom and
account for every rupee without opening the database — that is the literal test the docs set.

**5. Running totals**
- net customer cost
- net merchant retention
- mandate headroom remaining

For the failure path these must land on **customer cost ₹0**, which is the punchline of the demo.

**6. Make refusals prominent**

`ACTION_REFUSED` events are how bounds get *demonstrated* rather than claimed. When the Slice 4
over-ceiling charge is refused by Razorpay, that refusal appearing in the trail is the 2:00–2:45 beat
of the video. It should be impossible to miss.

## Design guidance

- Dense and legible beats sparse and pretty. This is an audit trail; it should feel like one.
- Monospace for ids, amounts, and timestamps.
- The failure path is the money shot. Screenshot `docs/03-domain-model.md` §6 mentally and ask whether
  your rendering is clearer than that plain-text trace. **If it is not, the plain text is better and
  you should reconsider the design.**
- Do not add filtering, search, or pagination this slice. `docs/04-features-and-limitations.md` §3
  lists viewer polish as the third thing to cut.

## Done when

- Opening the viewer and driving an agent through a booking shows events appearing **live**
- The full failure path renders legibly end to end
- `enforced_by: razorpay_mandate` is unmistakably distinct from `latch_policy`
- Refusals are visually prominent
- Running totals show ₹0 customer cost after a merchant decline
- Reconnecting after a dropped connection replays correctly
- It looks good enough to put on screen for two minutes without apologising for it

## Out of scope

Merchant policy editing UI (cut list, item 1 — seed policy in SQL), filtering, search, auth beyond a
simple token, deployment.

## Before you finish

Write the next `dev-logs/` entry. Take screenshots — you will want them for the submission.
