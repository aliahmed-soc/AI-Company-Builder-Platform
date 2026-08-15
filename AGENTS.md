# AGENTS.md — Standing Operating Rules

Read this in full before touching anything. This file is **process**, not
status. For what's actually true right now, read
`docs/agent/PROJECT-STATE.md`, `AUTONOMOUS-RUN-LOG.md`, and
`docs/implementation/BACKLOG.csv` — those are the living record. This file
doesn't get rewritten every session; it gets rewritten when a rule
genuinely changes.

This is the canonical standing-rules document. `CLAUDE.md` is a pointer
to this file and carries no rules of its own — there is exactly one place
to check, so the two can't drift apart.

The owner's product plan and context start at
`product-specification/README.md`. It states what is approved and what is
still draft, and points to `MASTER-PRD-v1.md` (the plan itself) and
`REQUIREMENTS.csv` (the canonical requirement registry, and the
tie-breaker whenever any other presentation of a requirement drifts from
it). Read those before your first ticket. They are not repeated here.

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
- Anything listed in `docs/implementation/OWNER-ACTION-PACK.md`
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

## 9. Repository isolation

- Canonical root: `E:/AI-Company-Builder-Platform`. Verify it with
  `git -C "E:\AI-Company-Builder-Platform" rev-parse --show-toplevel`
  before every material task — a shell hook can reset the working
  directory, so prefer PowerShell plus absolute paths.
- **Never** read, import from, or modify `E:\Halo-Suite`,
  `E:\Halo-Suite-V1`, or `E:\Halo-Suite\halo-suite`. Stop if the root is
  not the canonical one above.
- Names, requirements, architecture, data models, and branding from Halo
  Suite or Systevo are excluded unless the owner explicitly imports them.

## 10. Canonical source priority

When two sources disagree, this is the order: 1. accepted owner
decisions in the repo → 2. accepted ADRs/CDRs → 3. the backlog →
4. PRD acceptance criteria → 5. architecture and boundary docs →
6. existing secure patterns → 7. tests → 8. provider docs.

Never silently invent a requirement. On conflict, prefer the most recent
accepted decision, choose the safer reversible interpretation, document
what you chose, and escalate only when it hits a gate (§1, §16).

## 11. Architectural boundaries

Enforced by `tools/check-boundaries.mjs` — the checker is the authority,
this list is the intent behind it.

- `@acbp/contracts`: zero-dependency, provider- and framework-neutral.
  No Clerk or Next types.
- `@acbp/core`: provider-neutral use cases. It MAY act as the
  composition layer, importing `@acbp/adapters` and `@acbp/database`, but
  never imports a provider SDK (`@clerk/*`) directly.
- `@acbp/database`: provider-neutral; Kysely parameterized queries only,
  never interpolated raw SQL.
- `@acbp/adapters`: the ONLY home for `@clerk/backend`.
- `apps/web`: owns Next.js Request/Response and is the only place
  `@clerk/nextjs` may appear; reaches the domain solely through
  `@acbp/core` plus contracts, config, and observability.
- No dependency cycle between packages.

## 12. Security rules — never violate

- Never log, commit, print, or return: signing secrets, Clerk secret
  keys, session tokens, cookies, authorization or signature header
  values, raw webhook bodies, provider exception text, emails, or
  personal metadata.
- Synthetic test values only. No real Clerk ids or personal emails in
  fixtures, and no `.env*` file carrying a secret.
- Browser-controlled claims never authorize anything — internal database
  state is authoritative, and a read-through never trusts a browser
  identity header.
- No database write before webhook signature verification. Raw payloads
  are never persisted, only their sha256.
- Global identity mappings carry no tenant context. Deleted identities
  never auto-resurrect.
- Every cross-boundary and HTTP error is bounded and sanitized through
  `PublicErrorEnvelope`.

## 13. Database and concurrency

- The receipt insert and the user mutation are atomic — one transaction.
- Scope conflict handling to the exact identity uniqueness constraint
  (`provider, provider_instance_id, provider_user_id`) with
  `ON CONFLICT DO NOTHING`; never a blanket 23505-means-duplicate.
- The internal user id is immutable.
- Last-write-wins ordering is deterministic on
  `(provider_updated_at, last_event_id)`, with the event id only ever a
  tie-breaker.
- Race and transaction behavior is proven against real PostgreSQL. A
  local skip is acceptable only when `ACBP_TEST_DATABASE_URL` is absent;
  hosted CI must run those tests with zero skips.

## 14. The verification gate

Run before every commit, and report the actual exit codes:

```
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm check:secrets && pnpm check:boundaries && pnpm test:boundaries && pnpm test
pnpm run check
pnpm audit --audit-level high
git -C "E:\AI-Company-Builder-Platform" diff --check
```

Focused tests are for during development, not for the gate. Never claim
success without inspecting the exit status and the hosted CI logs — §3
applies to a green checkmark as much as to anything else.

## 15. Git and PR policy

- Never commit to `main`. One ticket, one PR. The PR stays DRAFT until
  the owner authorizes otherwise.
- Conventional commit messages, and **no `Co-authored-by` trailer**. Some
  tooling appends one automatically; check the committed message and
  strip it before pushing rather than assuming the message you passed is
  the message that landed.
- No force-push or history rewrite of commits that have been pushed,
  unless authorized.
- Before committing, inspect `git diff`, the scope of what's staged, and
  `git diff --check`. Before pushing, verify the branch, HEAD, and
  message. After pushing, monitor CI and fix ordinary failures.
- Which ticket and branch are active is status, not process — that lives
  in `docs/agent/PROJECT-STATE.md`, never here.

## 16. Owner authorization gates — stop and ask

Distinct from §1: those are never attempted at all, these need the
owner's word first. Work continues automatically to the next safe item
and stops only at one of these, a §1 hard gate, a §7 stop condition, or
an explicit human "STOP".

- A real secret, credential, signing secret, or login
- A Clerk dashboard change
- Creating, deleting, or modifying a live external resource
- A public tunnel
- A production deploy or anything against a production database
- Any destructive or irreversible operation
- A new architecture decision that changes data ownership,
  authorization, tenant isolation, deletion semantics, the public API, or
  provider strategy
- Setting a ticket Done, marking a PR ready, merging to `main`, or
  deleting a branch after merge
- Starting a different ticket
- An unrecoverable blocker, after reasonable diagnosis and one targeted
  fix attempt
- Anything outside the active ticket's approved scope

Everything else inside the active ticket proceeds without asking:
implementation, tests, refactors, docs, commits, feature-branch pushes,
draft-PR updates, CI diagnosis and fixes, and isolated disposable test
resources.

## 17. Completion standard

A slice is done only when the local gate is green, an independent
security and scope review is clean, the work is committed with a precise
message and pushed, the PR body reflects what actually happened, and
hosted CI is green on the exact head — with zero skips for
trust-critical database work. The §2 bar is part of this, not an
alternative to it.
