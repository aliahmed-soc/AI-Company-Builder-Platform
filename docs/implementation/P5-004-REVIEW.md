# ACBP-P5-004 — independent review record

Two full independent passes. **Both returned FAIL.** Design consequences are recorded in `CDR-056 §6`.

Hosted CI on `6f45b89` ran the registry suite green on its first attempt, zero skips. As on P5-003b/c, the passes found
what a green suite did not — and here the pass-1 finding was a guarantee the design record *claimed* while nothing
implemented it.

---

## Before the passes: a defect the TDD caught

Worth recording because it is the same shape three tickets running. My first `requiresApproval` passed the threshold
straight to `isAtLeastAsRestrictiveAs`, which **resolves** its arguments — so an unrecognised threshold became the
*most* restrictive class, nothing could ever meet it, and a single typo in a definition would have switched approval
off **for every class**. That is the P5-003a `riskRank` inversion in a new place. The threshold is now validated
*before* it is resolved.

The lesson is narrow and keeps recurring: **a function that resolves-then-compares is safe for the candidate and
dangerous for the threshold.**

---

## Pass 1 — the use case

### HIGH-1 — the MVP zero-external-actions boundary was documented and not implemented

`CDR-056 §2-G4` said the boundary is enforced *structurally*, quoting canon's own word. I wrote `isMvpSafeAllowlist`,
tested it thoroughly against every class — and then **nothing called it**. A definition allowlisting `send_email` would
have resolved cleanly and handed the dispatcher an external-effect capability.

A guarantee documented and not implemented is worse than one never claimed, because the document is what the next
person trusts instead of re-checking.

It cannot be a CHECK — `allowed_tools` is a `text[]`, the classes live in `tool_definitions`, and PostgreSQL CHECKs
cannot subquery. **Fix:** enforce at *resolution*, the one point where a definition becomes a capability. A violating
definition may exist and can never be used, which is the property "structural, not procedural" actually needs. An
allowlist naming an **unregistered** tool fails it too, since an unknown tool resolves to the most restrictive class.

### MEDIUM-1 — the boundary check would have been poisoned by history

`toolRiskClasses` returned *every* version of a tool. Because the check refuses if **any** row is external-effect, a
tool re-classified **down** from `external_reversible` to `informational` would have gone on being refused by its own
past. **Fix:** `distinct on (tool_id) … order by tool_id, version desc`, with a test that registers a reformed v1/v2
pair and proves it resolves.

---

## Pass 2 — the requirement, against the fixed tree

### HIGH-2 — WORK-006's failure clause was unmet AND unstated

> *"Disable during execution triggers safe-stop per TASK-007."*

Disabling stops future resolution; it does not safe-stop a run already executing. **It cannot yet** — nothing links a
run to a worker. `task_runs` has no `worker_id`, because the component that knows which worker is executing is the
worker runtime (P5-005), and adding a nullable, unpopulated `worker_id` now would be exactly the FK-less hole
`CDR-049` and `CDR-052 §1` both refused.

So the gap is **sequencing, not oversight** — but it was *silent*, and an unmet failure clause nobody wrote down is
indistinguishable from one nobody noticed. **Fix:** recorded explicitly in `CDR-056 §6`, naming the two steps that
close it (P5-005 stamps the worker onto the run; the disable path then calls P5-002's `cancelRun`, which already
implements the bounded safe-stop TASK-007 describes). Nothing in the code or docs claims the clause is met.

### MEDIUM-2 — `listActiveDefinitions` shipped uncalled, and WORK-001's acceptance was unproven

WORK-001's acceptance says *"Registry lists each worker with capabilities and tool allowlist"*. There was no listing —
the repository method existed and nothing used it, the same shape as P5-003c's uncalled detector.

**Fix:** `listWorkers`, readable by any active member. One entry per worker at the version that would actually run, not
every version ever registered. A **viewer** can see a pause deliberately: hiding it would make the control invisible to
exactly the people wondering why nothing ran. `has_reason` is a boolean, so the owner's text stays theirs.

### Found clean

The two-table split (global definition vs. per-company state) and its two different grant shapes; keying the state on
`worker_id` **without** a version, so registering v2 cannot silently un-pause a worker; `unknown_worker` and
`not_accepting` being distinct from an empty allowlist, which the dispatcher would have reported as `not_allowlisted`;
refusing to record a pause for a worker that does not exist; `worker:control` being owner-only; and all four vocabulary
CHECKs asserting **set equality** against their contracts — written at authoring time this ticket, rather than after a
review pass, because that gap has been the finding three tickets running.
