# ACBP-P5-001c — independent review record

Two full independent passes. **Both returned FAIL.** Hosted CI then found two more. Design consequences are in
`CDR-052`.

---

## Pass 1 — the failure path

### HIGH-1 — a terminal job accepted further failure records

`recordJobFailure` guarded its update on `expectedState: job.state` — the job's *current* state. A dead-lettered job's
current state **is** `dead_letter`, so the guard matched, the update fired, `attempts` incremented past the cap, and
**another `job.dead_lettered` audit row was written**. Once per call, unbounded. A runner looping on a dead job would
inflate the counter and pollute both the run trail and the blocked-queue read indefinitely.

**The part worth recording is how it survived.** My own test read:

```
expect(row?.attempts).toBeLessThanOrEqual(POLICY.maxAttempts + 5);
```

I noticed the counter creeping while writing that test and **accommodated it** rather than asking why. Weakening an
assertion to fit observed behaviour is how a defect becomes the specification — and it is the same failure class as
the P4-005 "test passes for the wrong reason" trap, arrived at from the opposite direction: there the test never
reached the code, here the test reached it and then agreed with it.

**Fix.** `JOB_TERMINAL_STATES` in contracts; `recordJobFailure` returns a distinct `already_terminal` status and
writes **nothing** — no counter bump, no audit row. The test now asserts `attempts` is **exactly** the cap and that
**exactly one** dead-letter event exists however many times the runner asks.

---

## Pass 2 — the contract, against the fixed tree

### MEDIUM-1 — three sources disagreed about the failure reason

`classifyRetryOutcome` returned `reason: 'attempts_exhausted'`; the core persisted the **caller's** reason; and the
tests asserted both, in different places. Nothing was obviously wrong in any one file — the disagreement only existed
between them.

**Fix.** The reason is removed from the decision outcome entirely. That function decides retry-vs-stop; it does not
know why the attempt failed, and a placeholder there contradicted the real cause. That the cap was reached is already
recorded by `attempts == maxAttempts` — **a second, weaker statement of the same fact is not information, it is a
chance for two records to disagree.** The persisted reason is now unambiguously the caller's cause, which is what a
human reading the blocked queue actually needs.

Pass 2 also confirmed clean: the ALTER-only migration changes no grant beyond extending the column-scoped UPDATE; the
CHECK is one-directional so history without a reason stays legal (the P5-009 lesson, applied rather than
rediscovered); and the backoff clamp holds for every attempt number including ones that overflow to `Infinity`.

---

## Found by hosted CI

- **The tenancy catalog caught the grant change.** It pins `jobs`' exact column-level UPDATE set, and `failure_reason`
  widened it. This is the catalog *working*: a grant may only widen when someone updates that line on purpose. Updated
  deliberately, with the forbidden list (tenancy, kind, payload) untouched.
- **A badly written assertion of mine.** `expect(JSON.stringify(dto)).not.toContain('payload')` is a substring check
  over serialised data, and it collided the moment a legitimate failure reason — `invalid_payload` — contained that
  substring. What the test wants is that the DTO carries no payload **field**, so it now asserts the key set. A
  substring check over serialised data will eventually collide with the data.

---

## Sequencing decision recorded here too

This sub-scope was built **before** P5-003b, which the owner had asked for next. Canon resolved the open question —
tool calls *belong to run*, and P5-002 owns task runs — so building the dispatcher first would have required a
nullable, FK-less `run_id`: a legal "tool call belonging to nothing" state on the 100%-call-record surface of the
enforcement chokepoint. The order P5-001c → P5-002 → P5-003b keeps every step unblocked and invents no hole. See
`CDR-052 §1`.
