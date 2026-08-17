# CDR-093 — proving a foreign row that EXISTS stays invisible

**Status:** accepted (owner, 2026-08-17; the number and this record's structure approved together with
`docs/implementation/API-BACKLOG.csv`) · **Ticket:** ACBP-API-010 · **Base:** `main` at `4a8b377` ·
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
- `artifacts_key_is_company_prefixed` is satisfied by **deriving** the key from the company id, mirroring
  the production derivation so the row is internally consistent; `content_hash` is a real sha256 of the
  body. **That derivation does not make a misplanted fixture fail at the database** — an earlier draft of
  this section claimed it did. `object_key` and `company_id` come from the same parameter, so the CHECK
  compares a value with itself and holds for any company. What catches a misplanted fixture is the caller's
  existence assertion pinned to the expected company, not the constraint.
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

## §3 — Evidence, and a first mutation report that was WRONG

### §3.1 — The retracted claim, kept because the mistake is the lesson

The first version of this section read: *"Planting the three 'foreign' fixtures in the caller's own company
— a simulated cross-tenant leak — turned **10 tests red** across all three blocks, including the raw-column
tripwire."* **That claim is false and is retracted.**

Reading the failure TEXT rather than the failure COUNT shows what actually happened. That mutation moved
each foreign fixture into company A while the caller's own fixture was already there, which put two
version-1 rows in one company and violated two UNIQUE constraints:

```
error: duplicate key value violates unique constraint "understanding_documents_company_version_uq"
error: duplicate key value violates unique constraint "policies_company_version_uq"
```

Those exceptions were thrown in `beforeEach`, so **every** test in the roadmap and approvals blocks failed —
including `an unknown query parameter is REFUSED, not ignored`, which has nothing to do with tenant
isolation. All-tests-in-a-block-red is the signature of a fixture error, not of a control being exercised.
Of the ten red tests, **eight were fixture errors and only two were assertions**, both in the artifact block.

This repository already had the rule — *a red exit code is not evidence* (ACBP-P7-013's probe reported 7/7
kills having run zero tests). It was broken here in its subtler form: the tests really did run, really did
go red, and the number was still not evidence, because nothing checked WHY. **A mutation report must quote
the failing assertion messages, not the count.**

### §3.2 — What the corrected mutations actually prove

Two mutations, each designed so a failure can only be an assertion failure.

**M1 — marker collision.** Each block's OWN fixture is given the FOREIGN marker, so the caller's own served
body legitimately contains the exact string the invisibility assertions forbid. Both rows stay in their own
companies, so no UNIQUE constraint is touched and no fixture throws. Result: **3 red, all assertions**, one
per block:

```
AssertionError: A's own roadmap read must not contain B's goal title
AssertionError: A's own inbox must not contain B's preview
AssertionError: A's own board must not contain B's task
```

**M2 — relocation, artifact block.** The foreign artifact planted in company A (no UNIQUE constraint applies
to `artifacts`, so this one is collision-free). Result: **2 red, both assertions**:

```
AssertionError: artifact: B's artifact must not surface inside A
AssertionError: artifact: identical status: expected 200 to be 404
```

Together these cover all four seeded blocks — roadmap, approvals, task board, artifacts — with a named,
quoted assertion apiece. The file was restored byte-for-byte after each run (verified: zero mutation
residue) and re-verified green at 54/54.

**What M1 does NOT prove**, stated so the next reader does not over-read it: it exercises the *content*
assertions, showing they fire when a forbidden string reaches the caller's body. It does not itself
demonstrate that RLS is what keeps the foreign row out — M2 does that for artifacts, by making a genuinely
foreign row reachable and watching the cross-tenant assertions fail.

### §3.3 — Suite evidence

Local, real PostgreSQL, zero skips: `pnpm run check` exit 0 — **284 test files / 4207 tests passed**, plus
12 / 267 for `test:boundaries`. Hosted CI on the exact head at zero skips remains the merge gate and the
only real-database evidence that counts; the local run is a pre-PR gate, not a substitute.

## §4 — What independent review found AFTER this was called complete

Five review dimensions with two adversarial refuters per finding reported 29 defects; **6 survived**. Four
were prose that this ticket's own change had made false, which is the failure mode the repository keeps
recording. Two were live vacuities in the tests:

- **The artifact positive control covered 2 of the 3 routes `callAll` drives.** `lineage` was requested and
  discarded, so every lineage negative in the block was still satisfied by a lineage route serving nothing
  to anybody — the exact vacuity this ticket exists to close, left open on one route. M2 could not reveal
  it either: `artifact` is index 0, so its assertion throws before lineage is examined. Now asserted for
  all three.
- **The task-board fixtures were seeded at the `tasks.state` default of `'draft'`, and drafts are
  deliberately OFF the board.** So "B's task never appears in A's board" was asserted about a task that
  appears on *nobody's* board, including its own company's — vacuous for a second reason entirely unrelated
  to isolation, and pre-existing rather than introduced here. Both fixtures are now `'planned'`.

Stale-by-my-own-hand prose, all corrected in place:
- the CDR-089 header still said the other three blocks "could only prove refusal at company scope … and
  they say so";
- the **roadmap EDIT block** — a CDR-088 block this audit had not visited — still claimed an "inability to
  seed a roadmap (the decision chain)" that this ticket disproved. It now seeds, so its no-write negative
  runs against a non-empty baseline rather than an empty table;
- the task-board header ranked itself "strictly stronger than the roadmap block below" and claimed to prove
  "the property the roadmap block explicitly cannot" — both false once the roadmap block seeded;
- §1.2 of this document claimed the derived `object_key` makes a misplanted fixture fail at the database. It
  cannot: key and `company_id` come from the same parameter, so the CHECK compares a value with itself.

## §4 — Not done here, deliberately

- **No production code changes.** This ticket is tests, fixtures and three corrected comments.
- **The CDR-089 run block is untouched** — it already seeds and already proves its own case.
- **The two corrected comments are not deleted, they are corrected**, following CDR-081 §1's precedent:
  the false claim is replaced by the real constraint with its migration line, so a later reader can check
  it rather than trust it.
