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

Model selection and reasoning-level routing are not covered here; they
live in `.cursor/rules/model-routing.mdc`, which Cursor loads into every
session automatically.

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
- **Every live, paid model call — one at a time, every time.** Once
  `ANTHROPIC_API_KEY` exists in the environment, that is a credential,
  not a permission. No live call may happen without the owner present
  and saying "run it" for **that specific call** — not the first one,
  every one. This holds regardless of automation level, and holds until
  the credit-reservation ledger is actually wired to the generate routes
  (ACBP-API-009; see CDR-096 for why it cannot ship as written).
  **Enforced in code, not only here.**
  `packages/adapters/src/model/owner-presence.ts` refuses by default and
  consumes a single-use grant per call, so an agent that read past this
  paragraph is still stopped by a throw. The composed runtime
  (`clerk-identity.ts`) supplies no grant, so a deployed application
  refuses live calls; `tools/demo/live-generation.mjs`, which a human runs
  deliberately, grants exactly one. It is a tripwire against an unattended
  call, NOT a defence against code that grants itself permission — the
  module says so itself rather than implying more than it delivers.

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

**And for every guard, ask the second question: does it actually RUN on
the path that matters?** A guard's existence is not its reachability.
Verify the caller, not the definition — open the script that invokes it,
the CI job that runs that script, and the code path the defect would
actually take. Four separate guards in one week were green while the
defect they were written for was live:

- a metered-route checker blind to two paid routes, because its
  directory list predated them
- a vocabulary guard that passed against a badge still rendering on
  screen
- an undefined CSS token reported as defined, because `--danger` is a
  suffix of `--c-danger`
- a dataset well-formedness assertion the scorer never called, so one
  argument bypassed it

None of these were broken. Each was correct code that nothing reached
with the input that mattered. A guard you have not watched go RED
against the real defect is a hypothesis, not a control.

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
  the owner authorizes otherwise — **or until §25's standing
  authorization applies**, which is such an authorization, given once
  and in advance rather than per PR.
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
  deleting a branch after merge — **except where §25's standing
  authorization covers it**, which pre-authorizes exactly this sequence
  for branches built under an existing ruling or ticket, under stated
  conditions. Marking an **owner-gated backlog row** Done is never
  covered, and neither is deleting a branch whose content differs from
  `main`.
- Starting a different ticket — except continuing to the next Ready,
  non-gated item, which §25 requires rather than merely permits
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

## 18. Specification protection

An approved product or architecture document is a controlled artifact,
not a draft to reinterpret while implementing. Never:

- change intended behavior without authorization
- drop an acceptance criterion because it turned out to be difficult
- weaken an approval or a security requirement
- replace a server-side control with a frontend-only check, or show a
  control in the UI that nothing enforces on the server
- create a fake metric, integration, or success state, or mark
  placeholder behavior production-ready
- alter pricing, credit, billing, or usage semantics without an approved
  decision
- add an autonomous permission without explicit authorization

When implementation reveals that a requirement is impossible, unsafe,
contradictory, or disproportionately expensive, report it and propose
options (§6) rather than quietly reshaping it. The same goes for scope:
never reduce what was requested without saying so.

## 19. External side effects

Before anything leaves the system, answer all seven: is approval
required; is the action reversible; does it need an idempotency key;
could a retry duplicate it; must usage or billing be recorded; is an
audit event required; must the user be told. A question you can't answer
is a reason to stop, not a reason to proceed carefully.

These hold throughout implementation, not just at review time: tenant
isolation, least privilege, server-authoritative authorization,
payload-bound authorization, auditability, idempotency, approval gates,
secret redaction, evidence provenance, data ownership, usage accounting,
safe retries, explicit failure states, and external-action limits.

## 20. Change discipline

- The smallest coherent set of files. Look for an existing pattern or
  reusable component before adding one.
- Read the relevant tests before changing behavior.
- Preserve backward compatibility unless the ticket requires otherwise.
- No unrelated cleanup, no reformatting files you didn't need to touch,
  no broad dependency upgrades, and no infrastructure for scale nobody
  has asked for.
- A database change ships with a migration, defined rollback or
  forward-recovery behavior, preserved tenant ownership, the constraints
  and indexes it needs, and a test against existing data. Destructive
  changes need explicit approval (§16).
- An API or event contract change updates producers, consumers, schemas,
  tests, and documentation together, and states the compatibility
  consequences.

## 21. Verification breadth

Run the narrowest relevant check first — targeted unit and integration
tests, typecheck, lint, schema and migration validation, build, browser
or end-to-end — then expand according to risk and blast radius. Record
every command and its result; §3 decides whether that result is
evidence of anything.

Trust-critical work needs negative tests, not only passing ones: another
tenant cannot reach the resource; an unapproved action cannot execute;
editing an approved payload invalidates the authorization; replaying a
webhook does not double-count; retrying a job does not repeat an
external action; revoking an integration stops execution; exceeding a
policy limit blocks the action; an emergency stop prevents newly queued
external actions; and secrets appear in no log, response, or error
message.

When a check cannot be run, name it, say why, state the uncertainty it
leaves behind, and do not describe the work as verified (§23).

## 22. Artifacts

Every substantial task leaves something reusable in the repository: a
specification, an architecture note, a decision record, code, a
migration, a test suite, a validation report, a README update, a
traceability entry, a runbook, or a risk-register entry. Never let the
only important result live in a chat response, and report the exact path
of everything created or materially changed.

Specification artifacts carry version, status, evidence, assumptions,
requirement IDs, open questions, and approval state. Implementation work
references the requirement IDs it implements.

## 23. Status: DONE, PARTIAL, BLOCKED

- **DONE** — all requested scope complete, files created or updated,
  acceptance criteria satisfied, relevant verification passed, nothing
  material hidden, and any remaining risk non-blocking and named.
- **PARTIAL** — useful work landed but some scope or some required
  verification did not. Say precisely which parts are which.
- **BLOCKED** — a decision, access, or resource is missing; continuing
  would be unsafe; or a higher-authority conflict can't be resolved.
  Name the blocker and the smallest action that clears it.

Never DONE when a test failed, verification was skipped without
explanation, requested scope is unfinished, placeholders remain in
requested functionality, a known defect stands, the thing only works
through hardcoded or faked behavior, or a frontend control exists
without the backend enforcement behind it.

## 24. The final handoff

Every task ends with: the status (§23); a summary of what was
accomplished, which requirement IDs it touched, what behavior changed,
and what was decided; the files, with exact repository paths;
verification as command, result, any failure or warning, and whether it
was targeted or repository-wide; risks and assumptions; blockers or
actions genuinely required from the owner; and a recommended next step
only when one is actually necessary.

The handoff has to be enough for another engineer or model to continue
without reconstructing the work. It must not claim unsupported success,
hide a failed test, omit a changed file or a load-bearing assumption,
present partial work as complete, describe planned work as implemented,
describe generated output as an executed action, or expose a secret. It
is part of the deliverable, not optional reporting.

## 25. Standing finalization authorization

Granted by the owner 2026-08-22, in advance and until withdrawn. It
replaces per-PR permission for mechanical finalization **only**. It
widens nothing in §1, and §16 still governs everything not named here.

> **On the number.** The owner's grant called this "§16". §16 was
> already taken by *Owner authorization gates*, is cited 25 times across
> the repository, and is the very section this one defers to — so
> renumbering would have broken those citations and inverted the
> reference. It landed as §25 with §15 and §16 amended to point here.
> The content is the grant as written.

### 25.1 Pre-authorized: the full finalization sequence

For any branch built under an **existing ruling or ticket**, all of the
following proceeds without asking, end to end, in this order:

1. Rebase onto current `main`.
2. Resolve **pure append collisions** — two branches appending to the
   same file. Place entries by their own dates, never blind-append; a
   log that stops being a chronology is a corrupted log. Anything that
   is not a pure append collision is a judgment call (§6).
3. Open the PR.
4. Wait for hosted CI on the **exact head SHA**.
5. Verify green with **zero skips, from the logs, by arithmetic AND by
   name.** Arithmetic: the parenthesized total equals the passed count
   (`Tests 5031 passed (5031)`) — a skip prints its own count and breaks
   that equality. By name: the suites that had to run are present in the
   log by filename. A conclusion of `success` is not this check; a run
   that skipped the suite proving the change would also say `success`.
6. Mark ready; squash-merge.
7. Verify CI green with zero skips **on the new `main` head**, by the
   same two tests. A merge can produce a head neither parent tested.
8. **Tree-identity check**, then delete the branch — never before.
9. **Then sweep for OTHER branches whose PR has since merged, and delete
   those too.** Not optional, and not "when someone notices": finishing a
   ticket includes leaving the branch list true. This step exists because
   it was skipped for months — a sweep on 2026-08-22 found **nine**
   branches, local and remote, whose PRs had merged as far back as
   2026-08-07 and which nobody had removed. Owner instruction, same date:
   *"do this step every time you finish, every time."*

**How to decide what may be deleted — the tests that are wrong, and the
one that is right.** All three were tried on 2026-08-22 and the first two
produced wrong answers:

- ❌ **Ancestry** (`git merge-base --is-ancestor`). A squash merge makes
  the branch head unreachable from `main` by construction, so this says
  "not merged" about every squash-merged branch. It is not evidence
  either way.
- ❌ **File presence** (does `main` have every path the branch has). This
  called `p8-api-006-model-gateway` deletable when NINE of its files
  differ in content. Presence is not equality, and §25.2 forbids deleting
  a branch whose content differs.
- ✅ **Provenance, then tree-identity.** Did the branch's OWN pull request
  merge? If yes, compare the branch's tree to that PR's squash commit
  (`git rev-parse <branch>^{tree}` vs `<mergeCommit>^{tree}`). Equal trees
  are the content-equality proof step 8 requires.

A branch whose PR was **closed unmerged**, or that has **no PR at all**,
is the only copy of whatever it holds and is never deleted here — even
when its work reached `main` some other way, because the branch still
holds the version that did not. `p1-004-last-owner-race-fix` and
`p3-006-strategy-eval-area` are both kept for exactly that reason: their
work merged from rebased branches, and the originals hold the pre-rebase
text.

⚠️ **A relocation is not divergence.** The first sweep called 24 branches
divergent because each held
`apps/web/src/app/{page.tsx,sign-in,sign-up}`, which `main` "lacks" — they
were MOVED into `app/(site)/` by `c4a714c`. Before treating a missing path
as unique content, look for where it went.

### 25.2 Pre-authorized: closing a PR as superseded

Permitted with a written explanation when **either** is proven:

- its content is **blob-identical** to `main` (`git rev-parse
  branch:path` equals `main:path`), or
- its content is **provably contradicted** by `main` — the disagreement
  named, with the evidence, not asserted.

Compare by `git ls-tree -r --name-only`, never `git diff main...branch`,
which reports every file as added after a squash merge and will tell you
a fully-merged branch is unique.

**A branch whose content differs from `main` is NEVER deleted under this
authorization.** Keep it, and name it in the report. `CDR-090` was cited
by five production files while existing only on a branch no PR tracked;
one routine deletion would have destroyed it with nothing going red.
`tools/check-doc-links.mjs` now fails the build on a citation with no
document, but it protects `main`, not branches.

**Evidence branches are never merged, closed, or deleted** — including
every `DO-NOT-MERGE` mutation probe and every `p7-008-probe-*` branch,
each of which IS a recorded run id's evidence. Label them; leave them.

### 25.3 Cadence

Work the queue to exhaustion every session. Do not stop after one item.
Do not hold mechanical work for permission. Move to the next Ready,
non-gated item without checking in between items.

Stop only at a §7 true stop condition, a §1 hard gate, a §16 owner gate,
or an explicit human "STOP". End every session by writing the **resume
point** — the next actionable item and what it needs — so the next
session continues without owner input.

The owner typing **"continue"** is full re-authorization of this
section.

### 25.4 Explicitly OUTSIDE this authorization

Unchanged, and not softened by anything above:

- Everything in §1, without exception
- Live model calls — owner present, per call (§1)
- Spending, credentials, keys, accounts
- Widening any permission, scope, or authorization action
- New domain logic added under an exposure ticket — routing an existing
  use case is exposure; adding a read or a behaviour that core does not
  have is a domain addition and needs its own gate
- Marking an **owner-gated** backlog row Done
- Deleting a branch whose content differs from `main`

If a step in 25.1 would require one of these, the authorization stops at
that step. It does not extend by proximity.
