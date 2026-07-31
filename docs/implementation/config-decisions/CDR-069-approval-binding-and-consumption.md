# CDR-069 — Approval binding, expiry, revocation, single-use consumption (ACBP-P6-004)

Governing: ADR-009; `APPROVAL-AND-POLICY-ARCHITECTURE.md` §2; APPR-004/005/006/009; trust-critical #6/#7.

ADR-009's title is the whole ticket: *"Payload-hash-bound, expiring, revocable, single-use approvals enforced at the
tool dispatcher."* P6-003 built the record of what a human decided. This ticket makes that decision **bind to a
specific execution** — so "what you approved is exactly what runs" stops being a claim and becomes a test that can
fail.

---

## §0 What this ticket inherits

P6-003c merged with four gaps recorded rather than hidden. Three of them are this ticket's scope, and the fourth is
named here so it is not quietly absorbed:

1. **No payload binding.** `findLatestDecisionForCall` matches on `(company, run, tool)`. Any arguments will do.
2. **No expiry.** An approval from last month authorizes today.
3. **No revocation.** A human who changes their mind has no mechanism.
4. **`scope` is stored, shown to the deciding human, and not enforced.** One `approve` on a `one_action` request
   authorizes unlimited calls to that tool for the run's lifetime. **This ticket closes it** — single-use
   consumption IS the enforcement of `one_action`, which is why the two were always the same problem.

**NOT in scope, still:** CDR-068 §2-G4 (preview-equals-execution). Binding the *payload* is not the same as deriving
the *preview* from it, and its marker test stays until someone does the second thing.

---

## §1 Gates

### G1 — The bound hash covers tool, version, payload and cost bound; nothing else

`APPROVAL-AND-POLICY-ARCHITECTURE.md` §2's material-change rule names four things whose change must invalidate an
approval: **payload, tool, destination, cost bound**. Destination has no representation yet (no external tool class
exists), so it is covered by the payload it lives in and named here so its absence is deliberate rather than
forgotten.

The hash does NOT cover company, run, actor or policy version. Those are bound by the *query* — the dispatcher's
read is already company- and run-scoped, and RLS confines it — and folding them into the hash would make a
legitimate re-request produce a mismatch for reasons that have nothing to do with what the human saw.

### G2 — One canonicalization, reused, and versioned

`canonicalizeToolArguments` already exists, is total over cycles/`Date`/junk, sorts object keys and preserves array
order. The dispatcher already hashes tool arguments with it for TOOL-002's `arguments_digest`. Binding reuses it.

A **second** canonicalization would be the defect: two functions that agree today and drift tomorrow, with the
disagreement surfacing as an approval that silently stops matching. ADR-009 lists exactly this as the cost —
*"canonical serialization/normalization rules must be versioned and maintained."*

So the stored hash carries its **normalization version**. An unknown version is a **mismatch, not a migration
prompt**: fail-closed, because a hash we cannot recompute is a hash we cannot verify.

### G3 — Expiry is REQUIRED and the platform ships NO default value

ADR-009 §15 leaves *"expiry defaults per risk class"* an **open owner question** (AOQ-14-adjacent). The standing
instruction on that class of question is that the values are the owner's and none ship.

Resolution: `expires_at` is **NOT NULL and supplied by the caller**. The mechanism is complete and the policy is
absent, so when the owner sets per-risk-class defaults they land in one place and change no enforcement code.

A nullable "no expiry" column was rejected: it would make the *absence* of an owner decision read as *permission to
never expire*, which is the failure mode this whole phase exists to prevent.

**Clock ambiguity resolves to expired** (§2): the comparison is `now >= expires_at` — an approval expiring exactly
now is expired. As with the schedule clock, `now` is an INPUT, never ambient, so "was this valid at time T?" stays
answerable from the record.

### G4 — Revocation is a REQUEST LIFECYCLE transition, not a sixth decision path

P6-003 recorded that `revoke` is absent from `APPROVAL_DECISION_PATHS` "on purpose — that is ADR-009 §2 and
P6-004". It stays absent, and this is the reasoning, recorded now that the ticket is here:

- `approval_decisions` has **UNIQUE(request_id)**. A revocation is necessarily a *second* statement about a request
  that already has a decision, so it cannot be a decision row without destroying that constraint — and that
  constraint is what makes "one decision per approval" true.
- A decision is **what a human said about a proposal**. A revocation **withdraws an authorization that already
  exists**. Recording the second as the first would misreport the trail: a reader would see two contradictory
  decisions where what happened was an approval and then a withdrawal.

So: `approval_requests` gains `revoked_at` / `revoked_by_user_id` and a `revoked` status, in the column-scoped
UPDATE grant that already exists for lifecycle columns. The content a human read stays immutable.

### G5 — Verify-and-consume is ONE conditional UPDATE, and its zero-row result is the refusal

Single-use consumption is not a read followed by a write. It is:

```sql
update approval_requests
   set status = 'consumed', consumed_at = $now, consumed_by_call_id = $call
 where id = $id and status = 'decided' and revoked_at is null and expires_at > $now
returning id
```

Zero rows returned **is** the refusal, and it is one statement, so the row lock serialises every concurrent
consumer. There is no window between checking and taking. A read-then-write would let two dispatches both observe
`decided` and both proceed — the exact double-execution single-use exists to prevent.

Expiry and revocation are **in the predicate**, not checked separately before it, for the same reason: a separate
check is a separate instant.

### G6 — Revoke-vs-consume races: the lock decides, and losing produces a compensating alert

§2 says such races *"resolve in favor of revocation or produce a compensating alert (APPR-006)"* — canon permits
either, and only one of them is honest.

Both operations take the same row lock, so exactly one wins:

- **Revoke first** → consumption's predicate fails → the call is refused. Revocation won.
- **Consume first** → revocation finds a `consumed` request. The action is already authorized and may already have
  run; nothing can un-authorize it. Returning "revoked" here would be a lie about the world.

So a revocation arriving after consumption returns `already_consumed` and emits an audit event **marked as
requiring compensation**. That is the second branch of §2 taken deliberately, and it is recorded because a system
that reports a failed revocation as a successful one is worse than one with no revocation at all.

### G7 — Consumption happens at AUTHORIZATION, and that burns the approval

The dispatcher authorizes and records a `requested` tool call; actual execution is the worker runtime's job
(P5-005), which does not exist. Authorization is therefore the only chokepoint that exists, so it is where
verify-and-consume runs — in the transaction that already writes the `tool_calls` row.

**Consequence, stated plainly:** an authorized call that never executes has still consumed its approval. A human
must approve again. That is the fail-closed direction — the alternative is an unconsumed approval sitting available
for a second dispatch — and it is a real UX cost, recorded here rather than discovered later. When P5-005 lands and
there is a true execution instant, this is the decision to revisit.

### G8 — A hash mismatch REJECTS; it never warns and continues

The backlog's failure clause, verbatim: *"Hash mismatch = reject never warn-and-continue."* There is no
`warn`-shaped outcome anywhere in the result types, so the lenient path is not merely unused — it is inexpressible.

---

## §2 Sub-scopes

| | Scope |
|---|---|
| **a** | This CDR; binding contracts (hash + version, expiry evaluation, consumption/revocation result types); unit tests |
| **b** | Migration 0048; repository `verifyAndConsume` + `revoke`; real-PG proof |
| **c** | Wire: `requestApproval` computes and stores the hash + requires expiry; the dispatcher verifies-and-consumes; `revokeApproval` service; `approval.revoked` / `approval.consumed` audit events |
| **d** | Docs, two independent review passes, finalization |

---

## §3 Status

Written first, as the design record; updated here against what was actually built, because a design record that
still describes intentions after the code lands is the same failure as a claim without a test.

**IMPLEMENTED: a (contracts), b (migration 0048 + repository), c (dispatcher wiring, revocation service, audit).**
All eight gates in §1 are built, and all eight are tested — but only after two review passes; the paragraph here
first claimed "built and tested" while §1-G6's compensating alert did not exist at all. That sentence is the exact
failure this section is supposed to prevent, and it is recorded rather than quietly corrected.

The four requirements the ticket carries — APPR-004 binding, APPR-005 expiry, APPR-006 revocation, APPR-009
single-use — are enforced at the dispatcher by one conditional UPDATE.

**§0's inherited item 4 IS CLOSED.** `scope` was stored, shown to the deciding human, and not enforced: one
`approve` on a `one_action` request authorized unlimited calls for the run's lifetime. Single-use consumption IS
that enforcement, which is why the two were always the same problem.

### What changed from the design, and why

- **§1-G5's predicate gained a second half.** The design said the gate reads the REQUEST. Rewritten that way, a
  REJECTED request authorized — a reject is `decided` too, as is a not-yet-due `schedule` and an
  `edit_then_approve`. Seven existing tests caught it. Both halves are required: the request says the approval is
  live and bound to these bytes, the decision says a human said yes. Reading the decision once is safe because
  `approval_decisions` is append-only with `UNIQUE(request_id)`; everything that can change is re-checked
  atomically.
- **§1-G5's ORDER was wrong and the database said so.** Consumption was specified to run before the call was
  recorded, so a lost race could never leave an authorized call beside an unspent approval.
  `consumed_by_call_id` is a real foreign key, so consuming first referenced a row that did not exist. The
  reasoning was also unnecessary: both statements are in ONE transaction, so nothing commits separately. The call
  is now recorded, the approval spent, and a lost spend corrects the record to `denied` before commit.

### What the two review passes found, because it is the substance of this ticket

Pass 2 ran 33 mutations and 10 survived; pass 1 proved its headline finding against a real database. Both are
recorded here because the fixes only make sense against what was wrong.

- **§1-G5's statement did not match its own specification.** The gate read ONE standing request and then spent by a
  predicate naming NO row — `(company, run, tool, …)`. `UPDATE` has no `LIMIT`, so two decided requests for the same
  action both matched, both took the same consuming call, and the partial unique index raised 23505. That threw out
  of `dispatchToolCall`, which its docblock says never happens for a refusal, rolling the transaction back so no
  `tool_calls` row and no audit event survived — a TOOL-002 violation on the calls most worth recording, and
  permanent, because every retry reproduced it. `where id = $id` was in this document the whole time.
- **A spent approval poisoned its `(run, tool)` forever.** The read matched `decided | consumed | revoked`, so after
  consumption a row always stood, the gate read it as an explicit refusal, and EVERY later call was denied —
  including calls the company's own policy allows outright and which never needed an approval. A terminal approval
  is ABSENT, not refusing; the read is now `status = 'decided'` only.
- **The `tool_version` binding component was inert** — recomputed from the approval's own stored value, so it could
  never mismatch. A human approves under v1, an active v2 lands, v2 runs. Now taken from the registry.
- **Nothing at the dispatcher tested the ticket's headline behaviour.** `spend = false`, hashing a constant instead
  of the real arguments, dropping the usability half of the gate, deleting the `approval.consumed` audit, and
  deleting the lost-race correction all left the suite green. The primitives were well tested; the wiring was not.
- **§1-G6's compensating alert was specified and never built.** Fixed by `approval.revoke_failed`, outcome
  `blocked`, carrying `compensation_required` — a human reaching for the brake and finding it already spent is
  precisely the event an operator must be able to alarm on, and an API response nobody stored is not one.
- Plus: `0048.down()` failed on any database holding a spent approval (constraints re-added before the rows were
  normalized); `expiresAt` was the one date in the stack with no validation; a fractional cost estimate reached the
  driver instead of being refused; and a whole comment block argued for an order the code does not use.

### Named limits — deliberate, not overlooked

- **THE COST BOUND IS BOUND BUT NOT RE-VERIFIED AT DISPATCH.** `dispatchToolCall` has no cost input, so the
  dispatcher recomputes the hash using the request's OWN stored cost and cannot detect cost drift — it never sees a
  second cost to compare. Canon's *"execution exceeding bound limit fails closed"* is the worker runtime's check at
  execution (P5-005). Recorded in the dispatcher beside the code rather than left for a reviewer to find.
- **CONSUMPTION AT AUTHORIZATION BURNS THE APPROVAL** even when the call never runs (§1-G7). There is no execution
  instant yet, so authorization is the only chokepoint that exists. Fail-closed, and a real UX cost. This is the
  decision to revisit when P5-005 provides a true execution instant.
- **`approval.expired` IS NOT EMITTED.** It is in EVENT-CATALOG; nothing sweeps expiry, so no code could emit it
  honestly, and one per refused dispatch would be duplicates describing a single lapse. Registering an event no
  code can emit is the failure this repo already refused once for `tool.call_started`.
- **CDR-068 §2-G4 (preview-equals-execution) IS STILL NOT BUILT.** Binding the PAYLOAD is not deriving the PREVIEW
  from it. Its failing-by-design marker test stays until someone does the second thing.
