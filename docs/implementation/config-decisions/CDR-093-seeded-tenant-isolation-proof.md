# CDR-093 — proving a foreign row that EXISTS stays invisible

**Status:** proposed · **Ticket:** ACBP-API-010 · **Base:** `main` at `4a8b377` ·
**Origin:** an owner ruling. The CDR-088 roadmap block disclosed that it could not prove foreign-roadmap
invisibility because no roadmap was seeded; the owner ruled that disclosed-as-unproven was the right
interim state but is not the merge state for a tenant-data read, and ordered the disclosure list taken to
**zero** rather than shrunk by one.

**Number:** 093. **090, 091 and 092 are all claimed on unmerged sibling branches** — 090 by
`origin/p8-api-006-cdr`, 091 and 092 by `origin/p8-api-006-model-gateway`. Checked across every remote
branch with `git ls-tree`, not just `main`, per the ACBP-P7-013 collision. Taking the next free number on
`main` alone would have collided three times over.

---

## §0 — The audit, and the finding that changed the ticket's size

The order was to audit **every** CDR-088 matrix block for the same disclosure. Three blocks carried it —
roadmap, artifact reads, approvals inbox — so the ticket is three proofs, not one.

### §0.1 — TWO OF THE THREE DISCLOSURES WERE FACTUALLY WRONG

This is the finding worth recording, because it inverts what the disclosures meant.

Both the artifact block and the approvals block justified seeding nothing with the same sentence: that
their `run_id` is *"NOT NULL with an FK to `runs`"*.

**There is no `runs` table in this schema, and there never has been.** The tables are `task_runs`
(migration `0035`), `planning_runs` (`0028`) and `worker_runs`. The real constraints are:

| Block | Claimed blocker | Actual constraint |
| --- | --- | --- |
| artifact reads | `artifacts.run_id` → `runs` | `artifacts_run_fk (run_id, company_id) → task_runs (id, company_id)` — `0043_artifacts.ts:41` |
| approvals inbox | `approval_requests.run_id` → `runs` | `approval_requests_run_fk (run_id, company_id) → task_runs (id, company_id)` — `0047:78` |
| roadmap read | the decision chain | **accurate** — the only one of the three |

`task_runs` needs four columns (`account_id`, `company_id`, `task_id`, `attempt`; `state` defaults), and
**the CDR-089 block in the same test file has been seeding exactly that chain all along**, roughly two
hundred lines above the artifact block that called it impossible.

So those two matrices were never blocked by a hard constraint. They were blocked by an **unverified
sentence about one**, and they withheld a provable isolation claim for as long as the sentence stood. The
repository already has a rule for the inverse case — a control whose justification cannot be checked must
not ship (ACBP-P7-014). This is that rule pointing the other way: **an unverified premise talked two
tenant-data matrices out of proving isolation.** The comments are corrected in place rather than merely
honoured, and each now names the real constraint and its migration line.

### §0.2 — The approvals block omitted a hop it did need
`approval_requests_policy_fk` is a three-column composite `(policy_id, policy_version, company_id) →
policies`, both policy columns NOT NULL, so an approval request cannot exist without a policy **in the
same company**. `policy_eval_id` IS nullable, so no `policy_evaluations` row is needed. Four inserts, not
five — a hop the old comment did not mention while naming one that did not exist.

## §1 — Where the seeding lives, and why not inline

`packages/test-support/src/tenancy/isolation-fixtures.ts`, exporting `seedForeignRun`,
`seedForeignArtifact`, `seedForeignApprovalRequest` and `seedForeignRoadmap`.

**The journey helpers were considered first, as the ruling required.** `runMvpLoopJourney` genuinely
reaches a roadmap and an artifact — but only by driving `generateRoadmap` / `runResearch` through a **fake
model gateway** with an injected `ops` bundle. The adversarial HTTP suite has neither; it drives real Next
route handlers and seeds through the owner connection. So extending `test-support` with model-free
builders is the option the ruling explicitly put in scope, and hand-guessing constraints — which it
explicitly ruled out — is avoided by reading every constraint out of the migrations.

### §1.1 — Two NOT NULL columns exist only as later ALTERs
Reading `CREATE TABLE` alone would have produced two failing inserts:
- `policies.autonomy_level` — added and set NOT NULL by `0049_policy_autonomy_level.ts`;
- `approval_requests.payload_hash` / `binding_version` / `expires_at` — added and set NOT NULL by `0048`.

The generated Kysely types encode NOT NULL as a **required insert field**, so `tsc` is a real check on the
column set here, not just on syntax.

### §1.2 — The fixtures are internally coherent, not merely constraint-passing
- `strategy_generations_status_count_consistent` admits `'complete'` only with `option_count >= 3`, so
  three real `strategy_options` rows are inserted rather than declaring three and seeding none.
- `strategy_selections_mode_shape` for `'select'` demands a non-null `selected_option_id`, so the
  selection points at option 0 and the composite FK pins it to the same generation.
- `artifacts_key_is_company_prefixed` is satisfied by **deriving** the key from the company id, so a
  fixture planted in the wrong company fails at the database instead of producing a row that lies about
  where it lives; `content_hash` is a real sha256 of the body.
- `approval_requests_reversibility_matches_risk` makes reversibility **derived, not chosen**.

### §1.3 — What these fixtures do NOT prove
They are DATABASE-LEVEL. They satisfy the schema; they do not pass through the contract validation a use
case applies (the 16-field strategy-option standard is the clearest example). They therefore prove nothing
about whether the write paths are correct — that is the use-case suites' job. **Isolation is the only
claim they support, and the only one made.** Said here and in the module's own header so no later reader
promotes a green run into evidence it is not.

## §2 — The prescribed shape, and why the order of assertions is load-bearing

Each block seeds in a **nested `beforeEach`** (§4.1 — the parent truncates before every test), and asserts
the row's existence **on the owner connection FIRST**, pinned to the specific id the fixture claims to have
created. A bare "some row exists" would still pass if the fixture silently planted it in the wrong company.

Only once the foreign row is known to exist does its invisibility mean anything. This is the slice-1 lesson
applied: three CDR-087 tests once passed against generations that had been truncated away, and only the one
test that INSERTED noticed.

### §2.1 — Byte-identity got stronger for free
The oracle checks used to compare a foreign company against an unknown one when **both were empty**, where
identical bodies were guaranteed for an uninteresting reason. The foreign company now holds real data and
the unknown one cannot, so identical bodies now mean **the presence of data does not move the answer**.

### §2.2 — Positive controls, because the negative alone is satisfiable by a broken read
Company A originally had no roadmap and no artifact, so *"A's read does not contain B's data"* would have
passed against a route that returned nothing to anybody. Each block therefore also seeds the caller's OWN
company and asserts the read genuinely **returns** it, following the task-detail block's existing
`the caller CAN read a task in their own company — the positive that makes the negatives meaningful`.

This also converts an admittedly dead test. The approvals block's raw-column check was documented as
*"VACUOUS while the inbox is empty"* and *"earns its place only if this block ever seeds"*. Seeding only
company B would have left it exactly as vacuous; the inbox is now non-empty and asserted so before the
column names are checked.

### §2.3 — A granularity the artifact block never had
With a real artifact in B, the CDR-087 G7(b) sub-resource oracle finally applies to artifacts: inside
company A, which the caller legitimately holds, a FOREIGN artifact id and an UNKNOWN one must be
byte-identical. Previously every id in play was unknown, so the question could not be posed.

## §3 — Evidence

**The green was mutation-proven before it was reported.** Planting the three "foreign" fixtures in the
caller's own company — a simulated cross-tenant leak — turned **10 tests red** across all three blocks,
including the raw-column tripwire. The file was restored byte-for-byte afterwards and re-verified green.

That step exists because of this repository's standing rule: before treating any green as evidence, ask
whether a wrong implementation could have produced the same green. For an invisibility assertion the honest
answer is usually yes, so the assertion has to be shown capable of saying no.

Hosted CI on the exact head, at zero skips, remains the only real-database evidence for the merge gate;
the local run is a pre-PR gate, not a substitute.

## §4 — Not done here, deliberately

- **No production code changes.** This ticket is tests, fixtures and three corrected comments.
- **The CDR-089 run block is untouched** — it already seeds and already proves its own case.
- **The two corrected comments are not deleted, they are corrected**, following CDR-081 §1's precedent:
  the false claim is replaced by the real constraint with its migration line, so a later reader can check
  it rather than trust it.
