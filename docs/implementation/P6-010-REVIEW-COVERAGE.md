# ACBP-P6-010 — independent review coverage

Ticket: **ACBP-P6-010** limits and alerts (NFR-015 cost control, POL-001 spending limits; ADR-010, ADR-013;
CDR-008 interim values; launch gate 5 adjacent). Branch `p6-010-limits-and-alerts`, PR **#70**, CDR-075.

The review pass returned **FAIL** with two HIGH and two MEDIUM. **CI was green for all four**, and fixing them
surfaced a fifth that only the corrected tests could see.

No migration. This ticket adds no table — the ledger it reads is ACBP-P6-009's.

---

## Before the review — two findings the CDR phase produced

Recorded because they changed the ticket's shape before a line was written, and neither came from a test.

### CDR-067 left a landmine pointed at this ticket by name

The dispatcher supplied the policy engine exactly one observation (`risk_class`), so a rule on `spending_limit`
was **unevaluable**, and CDR-066 §3-G9 makes an unevaluable dimension contribute `deny`. CDR-067's own words: a
company whose policy carried a spend cap would have **every tool call refused** — "latent today because no
product path writes rules until P6-010".

**This ticket is that product path.** The naive shape — add a `spending_limit` rule carrying the cap — takes a
tenant offline, and no test of the rule-writing path would show it, because the rule would be stored correctly.
So the ticket's centre of gravity moved from *deciding* the cap to *supplying the observation* (CDR-075 §0/§3-G1).

`policy-enforcement.integration.test.ts` had anticipated this exactly, and said so: *"it will fail the day an
observation for this dimension is supplied — which is the correct moment to revisit §1."* It was updated on its
own instructions, and its original assertions were **moved, not deleted**, onto `working_hours` — still genuinely
unobserved. Supplying one observation must not silently delete the fail-closed coverage for all the others.

### The two open-question registers disagreed about whether the values were ruled

`IOQ-09` said **Resolved (CDR-008)** naming P6-010 as consumer; `AOQ-14` was still open; PROJECT-STATE said the
values "remain unruled and unshipped". Surfaced rather than resolved unilaterally (CDR-075 §2), and the owner
ruled: ship CDR-008's interim values, labelled interim, revisit-bound at first alpha telemetry (§4).

---

## HIGH 1 — the soft alert was the firehose its own gate forbids

CDR-075 §3-G8, written in this ticket's own CDR:

> Emission is once per (scope, period, threshold) crossing — and the mechanism that makes "once" true has to be
> named, not assumed.

**No such mechanism existed.** A company at 76% of its daily cap wrote another `usage.limit_reached` row on
**every model call**, into a trail retained for the billing lifetime — precisely the noise the gate was written
to prevent, making the incident count worthless at the moment it matters. The gate was stated, restated in §4.1,
and never implemented.

### The obvious fix is a trap, and that is the transferable part

`audit_events.idempotency_key` is unique-when-present, so a deterministic key looks like the mechanism. It is not:
`writeAuditEvent` inserts with **no `ON CONFLICT`**, so the second write raises `23505` — and a constraint
violation **aborts the enclosing transaction**. Catching it in JavaScript does not un-abort it; every later
statement fails with `25P02` and the commit fails. **A soft alert would have become a hard outage** — a worse
failure than the noise it was meant to fix.

The mechanism is therefore a read-before-write, named in the code, with its limit stated: once-per-crossing under
ordinary traffic, at most a handful under a concurrent race, **not** exactly-once. That is the right trade when
the alternative is hundreds of rows per period.

Hard blocks are deduped the same way — a retrying job would otherwise write a row per attempt. A per-attempt
*count*, if ever wanted, needs its own counter: CDR-074 §5's lesson that a count and an audit fact are different
artefacts.

## HIGH 2 — the ceiling is reachable and unreached

**Nothing passes `caps`**, because `createModelGateway` has no production composition anywhere — only demo
scripts, journey helpers and integration tests construct one. After this ticket the gateway still enforces no
ceiling on any real path.

This is the **same defect CDR-075 §1 diagnoses in `policyPrecheck`** — an optional seam defaulting to *always
allowed* with no production caller — reproduced one layer up by the fix for it. The review caught it because §1's
wording ("this is the function that fills it") read as though the gap were closed.

Recorded as §4.3 rather than worked around: wiring `caps` into the demo scripts would make the ceiling *look*
enforced in the one place it does not matter and leave the real gap untouched. Same treatment CDR-074 §5.4 gave
the usage idempotency key. It becomes live the moment a production composition passes one already-typed argument.

## MEDIUM 1 — the test could not have caught HIGH 1

```
expect(events.filter(e => e.payload['threshold'] === 'soft').length).toBeGreaterThanOrEqual(1)
```

Passes with one row or fifty. **An assertion that cannot fail for the bug directly beneath it is not coverage.**
Replaced with exact counts plus three cases: five calls → one soft row; four blocked calls → one hard row; and a
**new day records again**, which is the failure on the other side of the gate, where a dedupe that never reset
would show one incident for an account hitting its ceiling daily.

## MEDIUM 2 — a header comment claimed the seam was filled

Corrected to "can fill it; nothing fills it yet".

---

## The fifth finding, which only the corrected tests could see

**The dedupe silently did not work.** `alreadyRecorded` filtered on `company_id`, but `usage.limit_reached` is
written under an **account** scope, and `writeAuditEvent` documents that an account scope leaves `company_id`
NULL. The filter matched nothing; five calls still wrote five rows.

Account-scoped is correct and was not the thing to change: the account-spanning read happens there, and after
`readSpendTotals` the company GUC points at whichever company the loop visited **last**, so a company-scoped
write would stamp an arbitrary one. The row identifies its company through `subject_id`, so that is what the
dedupe matches.

**Caught only because MEDIUM 1's replacement asserts an exact count.** The `>= 1` assertion would have passed on
all five rows. That is the second time on this ticket that a loose assertion hid the defect underneath it — the
first being the membership-independence case below.

---

## Findings from the real-PG suite itself

**The account ceiling can only bind at four or more companies** (CDR-075 §4.2). It is 3× the company cap, so
three companies each just under their own ceiling still total under the account ceiling. The first version of the
integration suite split the account cap across two companies, asserted an account block, and got a **company**
block — the system was right and the test was wrong. Recorded because it is invisible from the numbers and will
read as a broken account cap to whoever next tests it with two companies.

**A test was passing for the wrong reason.** "The totals do not depend on the caller having COMPANY membership"
asserted a *company-scoped* block — a figure that needs no cross-company loop at all, and would have stayed green
with the account loop entirely broken. It now uses the account-spanning fixture.

**Three wrong column names.** `audit_events` is `payload` / `occurred_at` / `event_id`. I guessed instead of
reading the schema, and the query threw only inside cases that inspect a *record* — five failed, five passed. The
five that passed were the ones checking only the decision. A suite can look half-working when the failing half is
the half doing the verification.

---

## Guards mutation-tested

| Guard | Mutation | Result |
|---|---|---|
| `spent >= limit` (NFR-015's one-increment bound) | relaxed to `>` | **3 failed** |
| soft threshold floors rather than rounds | `floor` → `round` | **1 failed** |
| nonsensical cap halts | config check → `return true` | **1 failed** |
| unreadable wins over blocking, order-independently | merged into the main loop | **1 failed** |
| unreadable spend must not read as zero | `?? 0` | **1 failed** |
| `caps` + `policyPrecheck` together throws | guard disabled | **1 failed** |
| block and halt are different error categories | halt collapsed into `budget_exceeded` | **1 failed** |

Not mutation-tested, with the reason: `recordSuppression`-style level choices (`info` vs `warn`) are judgements
recorded in code, not controls; and the once-per-period dedupe is covered by exact-count integration cases rather
than a mutation, because deleting it fails those cases by construction.

---

## Deliberately not actioned

- **No production caller passes `caps`** (§4.3) — disclosed, not papered over.
- **The dedupe is not exactly-once** under concurrency — stated at the mechanism.
- **`readSpendTotals` catches unconditionally.** Fail-closed by design; its blast radius is platform-wide, and
  that is now written down rather than discovered later.
- **Alert *thresholds* beyond CDR-008's 75%** are not invented here; the values remain the owner's.

## Evidence

Exact-head CI `30770810296` on `32d872f`: **246 files / 3502 tests, zero skips** — checked for `N skipped` lines
directly, of which there are none. `internal` confirmed absent from `RETRYABLE_MODEL_ERRORS`, so a halt cannot
trigger retry storms against a database that is already unreadable.
