# AGENTS.md — Standing Operating Rules

Read this in full before touching anything. This file is **process**, not
status. For what's actually true right now, read `PROJECT-STATE.md`,
`docs/agent/AUTONOMOUS-RUN-LOG.md`, and `BACKLOG.csv` — those are the
living record. This file doesn't get rewritten every session; it gets
rewritten when a rule genuinely changes.

The owner's product plan and context live at: `[owner: fill in path]`.
Read that before your first ticket. It is not repeated here.

---

## 1. Hard gates — never attempt, never work around, never simulate

- Any paid account, API key, or billing change (model providers,
  infrastructure, external services)
- Live infrastructure / production deployment
- All frontend/UI work — the owner sets design direction personally,
  no scaffolding "to iterate on later," no picking a component library,
  palette, or layout unprompted
- Entering payment details, creating accounts, or authenticating as the
  owner anywhere
- Anything listed in `OWNER-ACTION-PACK.md`
- Widening any permission, scope, or default beyond an existing
  **recorded** ruling — a past ruling only covers what it actually
  decided, never a similar-looking new situation

If the next Ready item needs one of these, **stop**. Don't substitute
easier work silently, don't lower scope to dodge it, don't guess a
default that sounds reasonable. Name it plainly and move to the next
item that doesn't depend on it.

## 2. Engineering discipline — every ticket, no exceptions

- A CDR (design doc) before any ticket that makes a real decision. Pure
  mechanical exposure of already-tested logic doesn't need one — say
  which kind a ticket is before starting.
- TDD: the test is written and watched to fail before the
  implementation exists.
- Real-database proof via CI, not local-only. If local Postgres is
  unreachable, say so explicitly rather than letting a local pass stand
  in for it.
- Mutation-test every guard: break it, **verify the break actually
  landed in the file** (diff it, don't trust the runner's word), confirm
  the test goes red, restore, confirm the file is byte-identical to
  before. A mutation that never applied and still "passed" is not
  evidence of anything — it's a false survival or a false kill.
- Two independent review passes before any completion claim. Brief the
  reviewer to attack a specific risk — never hand them your own
  conclusion first.
- Exact-head CI green with zero skips before merge. Exact-main CI green
  with zero skips before deleting a branch.
- Before deleting any branch: verify **tree-identity** against its
  squash commit, never ancestry. Ancestry can never pass against a
  squash merge — it is not evidence either way.

## 3. The rule that matters most

**Before treating any result as evidence, ask: could a wrong
implementation have produced this exact same result?** If yes, the
check proves nothing, no matter how confident it looks.

This project has been burned by exactly this five separate times:

- A suite skipped by a broken precondition, read as "nothing broke"
- The wrong build command run twice and treated as corroboration,
  because running it wrong a second time isn't a second data point
- A mutation that never actually applied to the file, reported as a
  kill because the test suite happened to pass
- A name-grep against a barrel file using `export *` — a check that
  could only ever return "not found," regardless of the truth
- A service with zero unit test coverage, where a fail-closed guard had
  nothing in the suite that could kill it if the logic were inverted

Every one of these looked like evidence at the time. None of them were.
Apply this question to search results, "I confirmed X," measurements,
and completion claims — not just to test runs.

## 4. Money paths always get the full bar

Anything touching credits, billing, spend, or a paid external call gets
full discipline with no shortcuts, regardless of how small the change
looks. This codebase has already shipped and caught a real double-charge
bug from exactly this kind of "small" change. If a slice would touch
money and doesn't have room to do it properly, split the money part into
its own ticket rather than folding it in under time pressure.

## 5. Multi-session safety

More than one session — scheduled, manual, or a second agent — may run
against this repo at once. Before starting any work:

- `git fetch` and re-read `PROJECT-STATE.md` and current `origin/main`.
  Your own last-known state is not evidence of the current state.
- If the tree is dirty, a commit landed recently, or the checked-out
  branch has changed since you last looked, **stand down**. Don't assume
  you're alone.
- If you discover a collision mid-session, untangle it from git evidence
  — don't guess a story that fits and don't overstate what you find.
  Verify, then report plainly.

## 6. When you hit a real, undecided judgment call

Don't extrapolate a past ruling to a new situation it didn't actually
decide, even when it looks similar. Name the decision plainly, give 2–3
real options with honest tradeoffs, state a recommendation if you have
one, and record it as an open item rather than picking silently. Then
move to the next Ready item that doesn't depend on it — don't stall an
entire session on one open question if other real work exists.

## 7. True stop conditions

Stop entirely and write a clearly marked **"STOPPED — NEEDS OWNER"**
entry to `AUTONOMOUS-RUN-LOG.md` when:

- every Ready, non-gated item is genuinely exhausted
- a real judgment call (§6) blocks everything remaining and can't be
  answered from existing rulings or canon
- only hard gates (§1) are left
- tooling, auth, or environment is actually broken — not just slow

Do not manufacture scope to look busy. Do not lower §2–4 to produce more
completed tickets. An honest stop report is worth more than fake
progress, and it is the expected outcome once the backlog is mostly
owner-gated — not a failure.

## 8. Reporting

Every session appends to `AUTONOMOUS-RUN-LOG.md`: what shipped (with
commit SHAs and CI run IDs, not just "done"), what's blocked and on
what specifically, and what the owner needs to do next, ranked by how
much it unblocks. Timestamps come from an actual clock check, never an
estimate of elapsed effort.
