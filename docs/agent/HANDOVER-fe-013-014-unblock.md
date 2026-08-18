# Handover — what it takes to finish ACBP-FE-013 and ACBP-FE-014

Written 2026-08-18 with `main` at `f4fa754`. The frontend backlog is **15 Done / 4 Blocked-API / 0 Planned**;
every row that could be built without a new backend route has been built. This note exists because the last
frontend gap is **one merge away, and that merge is not the one it looks like.**

---

## 1. The one-line summary

FE-013's *generate options* / *ask for a recommendation* and FE-014's *generate the roadmap* are the only
frontend features still missing, and the four routes they need **already exist, on an unmerged branch**.

| Route | Method | Unblocks |
|---|---|---|
| `POST /api/companies/{companyId}/strategy/generate` | POST | FE-013 "generate options" |
| `POST /api/companies/{companyId}/strategy/recommend` | POST | FE-013 "ask for a recommendation" |
| `POST /api/companies/{companyId}/roadmap/generate` | POST | FE-014 "generate the roadmap" |
| `POST /api/companies/{companyId}/tasks/generate` | POST | (task planning; no FE row wired to it yet) |

They live on branch **`p8-api-008-slice3b`**, head **`2046c69`** ("fix(api): debit the company generate ceiling
only after owner-only authz"), which is **PR #111** — *ACBP-API-008 slice 3b: the four metered generate routes,
behind a company ceiling*.

## 2. Why merging PR #111 does NOT unblock anything

**PR #111's base is `p8-api-006-model-gateway`, not `main`.** Merging it as it stands puts the four routes on
that branch and `main` gains nothing, so the frontend still has nowhere to POST. This is the trap: the PR
number is right, the merge button does the wrong thing.

Four more facts, all verified against the repository on 2026-08-18:

1. **It is a DRAFT**, last updated 2026-08-17, i.e. it is the sibling session's work in flight.
2. **The branch is 21 commits ahead of `main` and 30 behind it.** `main` is not an ancestor. None of the day's
   thirteen frontend merges are in it.
3. **It will conflict.** Six files are touched on both sides of the merge base (`0d57144`):
   - `apps/web/src/server/companies/companies-request.ts` ← **and this one matters**
   - `apps/web/src/server/companies/companies-request.test.ts`
   - `apps/web/src/server/companies/companies-http.test.ts`
   - `package.json`, `pnpm-lock.yaml` (ACBP-FE-019 added `jsdom` + `@testing-library/react`)
   - `AUTONOMOUS-RUN-LOG.md`
4. **The stack carries the live Anthropic model gateway** (ACBP-API-006). PR #107 proposes a hard gate
   requiring owner presence for every live model call, so merging this chain is a decision with a standing
   owner gate attached, not a routine integration.

### The specific conflict to expect in `companies-request.ts`

ACBP-FE-016 added two fields to the approvals wire allowlist and a total date helper:

- `ApprovalInboxItem` gained `expiresAt` and `createdAt` (both ISO strings).
- `listApprovalInboxForRequest` maps them through `toIsoOrRaw`, which **never throws** — `new Date(x).toISOString()`
  raises `RangeError`, and it runs inside a `.map` over the whole inbox, so one unreadable row would have turned
  the entire screen into a 500 instead of one bad card.
- The allowlist assertion in `companies-request.test.ts` pins the exact 13 keys, so it fails loudly if the
  resolution drops either field.

**Keep both sides.** The FE-016 change is additive to a different function than the generate routes touch.

## 3. The actual sequence to unblock the frontend

1. `git rebase origin/main` on `p8-api-008-slice3b` (or merge `main` into it — the sibling's call).
2. Resolve the six files above. `pnpm install` after taking both `package.json` sides; do not hand-merge the
   lockfile.
3. **Retarget PR #111's base from `p8-api-006-model-gateway` to `main`**, or open a fresh PR to `main`.
   This is the step that is easy to miss and is the whole reason the merge appeared to do nothing.
4. Mark it ready, run the full gate, and require exact-head CI green **at zero skips**.
5. Decide the model-gateway owner gate (see §2.4) before merging — it is not the frontend's to decide.

## 4. What to build the moment those routes are on `main`

Both screens were written so this is additive, and both currently say in their own copy that generation is
unreachable — **that copy has to be removed in the same commit as the button, or the screen contradicts
itself.**

**ACBP-FE-013** — `apps/web/src/app/console/companies/[companyId]/strategy/`
- `page.tsx` and `strategy-view.ts` headers both state that `generateStrategyOptions` and `recommendStrategy`
  reach no route. Delete those paragraphs.
- `strategy-panel.tsx` `nothing_generated` branch says generation "cannot start yet"; replace with a real
  control.
- Reuse `decision-outcome.ts`: both routes are metered and sit behind a **company generate ceiling**, so expect
  a `429` with `Retry-After` — `parseRetryAfter` already handles it, and `rate_limited` already has a CSS rule.
- The ceiling is debited **after** owner-only authz (that is what head `2046c69` fixes), so a non-owner's
  refusal must not read as "you used your quota".

**ACBP-FE-014** — `apps/web/src/app/console/companies/[companyId]/roadmap/`
- `page.tsx` header and `roadmap-screen.tsx`'s `nothing_planned` branch both state that generation is
  unreachable. Same removal.
- Generation is gated on a recorded **non-reject** decision (CDR-038 §6-G1). The screen must not offer it as
  though it always works — and note `strategy-view.ts` deliberately does **not** claim to know the company-level
  planning gate, because this read carries only the displayed generation's decision.

**Both screens are currently server components with no writes.** Adding a POST makes them need a client
component, which means:
- `run-view.ts` imports `MAX_REVISIONS_RETURNED` from `@acbp/core` and is **server-only for that reason** — do
  not pull it into a `'use client'` module. Mirror the constant and assert it in a test instead. This is the
  ACBP-FE-010 BLOCKER, which `check:boundaries` did **not** catch.

## 5. Standing rules this work will meet head-on

- **Import the vocabulary, never restate it.** ACBP-FE-016 invented four risk values the CHECK constraint
  forbids; every real row rendered as "unknown" and it passed green because the tests fed impossible values.
  Drive fixtures from the contract's own arrays.
- **A control that cannot act must not ship.** That is why there is no generate button today, and it is why the
  button and the "you cannot generate" copy must land together.
- **A red run is not automatically evidence.** ACBP-FE-019's first mutation reddened the suite with a
  `TypeError` that proved only a null check stops a crash. Pick the mutation that isolates the claim.
