# ACBP-P5-013 — review ledger

Two independent passes, both FAILED. Both found the same headline independently, which is the strongest signal
either has produced so far.

## The headline: the activity widening was a booby trap, not a missing feature

I added `task.failed` to `ACTIVITY_TYPES` and gave it a summary allowlist. I did not add a migration widening
`activity_events_type_valid`, which still names only the four company events.

Nothing projects `task.failed` today, so the divergence was inert. **The danger was for the next person.**
`projectCompanyActivity` is deliberately fail-closed: the first correct wiring would have inserted a value the CHECK
rejects, thrown, and rolled back the enclosing transaction — which on the failure path carries `failRun`'s terminal
transition and its audit write. A ticket whose entire subject is failure visibility would have caused failures to
stop being recorded at all.

**Reverted, not completed.** Completing it needs a migration plus a projection call inside the audit transaction, and
with hosted CI down neither can be proven against a real database. Reverting also keeps three documents true as
written — pass 2 listed `ACTIVITY.md:43-46`, CDR-016 and two `activity-repository.ts` comments as newly false under
the widening. The deferral follows the `interview.started` precedent (P2-001/CDR-022 §4).

**The guard that matters more than the revert:** `ACTIVITY_TYPES_IN_DATABASE_CHECK` + `activityTypesMatchDatabase()`
pin the contracts taxonomy against the migration's literals. The divergence was silent because *nothing anywhere
tied those two together* — not a test, not a type. That guard is worth keeping whoever finishes ACT-005.

## Pass 1 — adversarial

| # | Sev | Finding | Fix |
| --- | --- | --- | --- |
| H1/H2 | HIGH | The widening above, from two angles: never projected, and the DB CHECK diverged. | Reverted + set-equality guard. |
| M1 | MED | `nextAttempt: 'scheduled'` promised a retry nothing performs — no retry trigger exists and `startRun` has no production caller — and `attemptsAllowed` reported the **job** policy's cap, which governs nothing about a run. | Renamed `retry_eligible`; the borrowed cap is recorded in CDR-059 §6. |
| M2 | MED | **Proven by execution:** a malformed policy made this module fail OPEN while `classifyRetryOutcome` fails CLOSED on the same input. `maxAttempts: 0` → one said "another attempt is possible", the other dead-lettered. | A malformed policy now reports `exhausted`. |
| M3 | MED | **Fixtures agreeing with the bug.** A failed *task* with no failed *run* rendered a blank failure. Nothing ties `tasks.state='failed'` to a failed run — the transition is legal alone, a task can fail with no run, a later attempt may be queued. The test that would have caught it used `taskInState('draft')` instead of `'failed'`. One word. | Task state is the backstop; three tests including the two interleavings. |
| M4 | MED | `taskFailed` typed its payload `string`, so it echoed whatever it was handed — while `describeRunFailure` refuses to echo an unrecognised value. Both keys are feed-allowlisted, so a caller passing a provider message would have put it in front of a founder. | Typed `RunFailureCategory` / `NextAttempt`. |
| L1 | LOW | `attemptsUsed` was clamped: a seventh attempt read "3 of 3" while the audit event recorded 7. | Unclamped. |
| L5/L6 | LOW | `listForTask` orders by attempt, not time; two docs still said `retry_state` was pending. | Corrected. |

## Pass 2 — canon fidelity

Beyond the shared headline:

| Finding | Fix |
| --- | --- |
| **`RETRY_SAFE_CATEGORIES` was more permissive than canon.** `worker_lost` cited row 4's *"Checkpointed steps idempotent"* — a requirement conditional on checkpoints that do not exist (`reclaimLostRuns` fails runs outright). `provider_error` cited rows 2/3, but here it is the catch-all for any thrown step, including row-8 tool failures whose idempotency cell reads **Required**. | Narrowed to `['timeout']`, the only unconditional "safe" in the table. |
| **"all 16 rows"** in the CDR header was a scope overclaim: 2 rows served, 12 unattributed. | §6 is now a row-by-row table naming P5-011 / P5-014 / P6-007 / P7-008 and the rest. |
| "Failure-injection tests" — nothing injects; **P7-008 already exists** and was uncited. | Recorded with the owner. |
| "Charging rules applied" and "Support bundle" unattributed; P5-011's row does not carry the bundle obligation. | Both recorded, including the orphan risk. |

## What both passes confirmed clean

`describeRunFailure` totality (pass 1 verified by execution against `null`, `'__proto__'`, NaN, string attempts —
never throws, never blanks); no provider text can reach the DTO; the summary-map set-equality guard is genuinely
bidirectional; tenant isolation on the new read path; schema-v2 backward compatibility with stored v1 rows; and
`listForTask` ordering is genuinely newest-first, with a test that would fail under ascending order.

## The pattern, again

Fifth ticket running: **a claim stated and not enforced**, plus **fixtures shaped so the false half cannot fail**.
What is new here is the failure mode's shape — this one was not merely unenforced, it was *actively dangerous to the
next person who tried to enforce it*. A contract that disagrees with its own database is worse than an absent
feature, because the absence is visible and the disagreement is not.

The cheap check that would have caught it at authoring time: **when you widen a set that a database constraint also
encodes, the migration is part of the same edit — and if you cannot write the migration, you cannot widen the set.**
