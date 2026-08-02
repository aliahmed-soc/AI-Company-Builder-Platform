# CDR-074 — Idempotency and replay hardening (ACBP-P6-011)

Governing: **TASK-009**, **NFR-006**; ADR-008, ADR-013; `FAILURE-AND-RECOVERY.md` row 11; **launch gate 5**;
**trust-critical #11 and #12**.

Canon's two trust-critical clauses, verbatim:

> **11. Replayed jobs do not duplicate authoritative effects.** *(P6-011)*
> **12. Duplicate usage messages do not double count.** *(P6-009/011)*

And `FAILURE-AND-RECOVERY` row 11, which names both the mechanism and the expected user-visible outcome:

> | Duplicate delivery (job/event) | Idempotency-key / event-id dedupe | Duplicate suppressed | … | Core mechanism
> (NFR-006) | Invisible (correct) |

---

## §0 The thing that makes this ticket different

**A duplicate that was suppressed and a duplicate that never arrived look identical from the outside.** Canon
itself says the user-visible outcome is *"invisible (correct)"* — which is right as a product statement and
treacherous as a verification standard, because "nothing happened twice" is also what a system with no
duplicate suppression looks like on a day when nothing was delivered twice.

So this ticket cannot be verified by absence. Every mechanism needs a test that **actually delivers the
duplicate** and asserts two things separately:

1. the effect happened exactly once, and
2. the system *knew* it was suppressing something.

Point 2 is why the backlog asks for an **incident counter** alongside suppression. Without it, a suppression
path that silently stopped working would be indistinguishable from a quiet week — and the first evidence would
be a double charge.

This is the sibling of CDR-073 §0's failure mode. There, a wrong number looked like a right one; here, a missing
guard looks like a calm system.

## §1 What already exists — this is HARDENING, not greenfield

Seven surfaces already carry duplicate suppression. Naming them matters, because the ticket's honest scope is
"prove these, and close the one gap", not "build idempotency":

| Surface | Mechanism | Migration |
|---|---|---|
| `jobs` | partial unique `(company_id, idempotency_key)` where key not null | 0031 |
| `job_checkpoints` | a step completes once — duplicate completion is the SAME FACT | 0032 |
| `tool_calls` | partial unique `(company_id, tool_id, idempotency_key)`, **bound to an arguments digest** | 0036 |
| `audit_events` | partial unique `(account_id, idempotency_key)` | 0007 |
| `activity_events` | `ON CONFLICT (event_id) DO NOTHING` on the projection | 0009 |
| `credit_transactions` | partial unique `(account_id, idempotency_key)` where `kind = 'reservation'` | 0041 |
| `artifact_revisions` | full unique `(company_id, idempotency_key)`, key NOT NULL | 0044 |

The dispatcher's short circuit is already the hardest of these and was fixed under P6-002: a key naming
**different arguments** returns `idempotency_conflict` rather than another call's record; a prior **denied** call
is not reported as `duplicate` (which would let `if (denied) abort; else proceed;` read a laundered refusal as
permission); and a blank key is treated as no key, so two calls that both omitted one cannot suppress each other.

**Nothing in this ticket may weaken any of the above.** The work is a replay suite that proves them, plus §2.

## §2 The one real gap — `usage_events` has no duplicate suppression

`usage_events` (migration 0017) has **no idempotency key and no unique constraint** beyond its primary key. A
retried delivery of the same model call inserts a second row.

That is exactly the half of trust-critical #12 that ACBP-P6-009 deliberately did **not** close, and said so:
a `SUM` cannot double count unless the *ledger* holds duplicates. P6-009 proved the rollup does not double count
a single ledger row; it has no defence against two rows describing one call. Both halves are needed before #12
is closed, and this ticket owns the second.

**The consequence is direct**: a duplicated usage row inflates the account rollup, and CDR-073's reconciliation
cannot detect it — reconciliation recomputes *from the ledger*, so it faithfully reproduces the duplicate and
reports no drift. The same blindness recorded for the `kind` predicate, from a different direction.

### Why suppression here must not throw

Metering is **fail-closed** (CDR-026 §5): a usage-write failure throws and the model output is withheld. So a
duplicate must be recognised as *already recorded* and treated as success — not surfaced as a write failure, or
a retried delivery would withhold an output the customer already paid for.

That rules out a bare unique constraint whose violation propagates. The insert needs `ON CONFLICT … DO NOTHING`
with a **zero-rows-affected** result read as "suppressed", which is a different code path from "inserted".

### DECIDED — the key is a CALLER-SUPPLIED call id, nullable, with a partial unique index

`usage_events.idempotency_key text`, plus `unique (company_id, idempotency_key) where idempotency_key is not
null` — the `jobs` (0031) and `tool_calls` (0036) shape.

**Not a natural key** over the call's identifying attributes, which was the tempting option and is wrong: two
genuinely distinct model calls with identical provider, model, token counts and cost in the same instant are
legitimate, and a natural key would silently discard the second — turning a duplicate-suppression feature into
an under-counting bug, which is the same class of error in the opposite direction.

**Nullable, not NOT NULL.** A key is protection a caller opts into by supplying one; the partial index means
rows without a key never collide with each other. That is deliberate and matches the dispatcher's rule that a
blank key is no key — two calls that both omitted one must not suppress each other. It also keeps the migration
additive over existing rows.

### What the exposure actually is today — stated so the guard is not oversold

The current usage write is **inline and fail-closed**: `writeUsageEvent` runs in its own short transaction after
the model call, and a failure throws so `callModel` withholds the output. A failed write therefore does not
leave a duplicate behind, and a genuine retry means the model was called again, which *should* count twice.

So this key is not fixing a live double-count on today's path. It is closing the structural hole that
trust-critical #12 names — the ledger has no defence *at all* against two rows describing one call — ahead of
the message-driven usage delivery that NFR-006 and ADR-008 anticipate, and for any caller that retries the write
rather than the call. Saying this plainly because a guard sold as fixing a present bug invites the next reader
to assume the bug was found and measured, and neither is true.

## §3 Scope boundaries

- **No existing suppression mechanism is loosened.** Additive only.
- **The `Idempotency-Key` HTTP surface** (`API-CONTRACTS`: *"honored on all mutations"*) is NOT wired here —
  there is no HTTP mutation surface for these paths yet, and building one would invent a requirement. The core
  use cases are the boundary this ticket hardens.
- **Incident counters are counters, not alerts.** Surfacing them is P6-010's (limits and alerts) and the
  Decision Room's; this ticket makes the number exist and be recorded.

## §4 Open owner decisions

None raised yet. If the incident counter needs a threshold at which a suppression rate becomes an alert, that
value is the owner's on the same footing as CDR-073 §3.1's drift threshold — and would be recorded here rather
than defaulted.
