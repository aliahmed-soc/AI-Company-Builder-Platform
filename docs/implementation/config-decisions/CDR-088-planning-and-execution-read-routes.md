# CDR-088 — HTTP routes for planning and execution reads

**Status:** accepted, implemented and merged as squash `6faa91c` (PR #98) ·
**Ticket:** ACBP-API-002 (slice 2 of the missing-route programme) ·
**Base:** `main` at `3cbfc89` · **Predecessor:** CDR-087 (slice 1, merged `d1d4ae8`).

**EIGHT routes shipped**, each with a §4 matrix: roadmap read, roadmap edit, task board, task detail,
artifact, artifact lineage, run-artifacts, approvals inbox. Exact-head CI
[`31613369311`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31613369311)
on `ec192bd`: 278 files / 4125 tests, **zero skips** — every matrix ran against real PostgreSQL.

**WHAT IS NOT PROVEN, AND MUST NOT BE READ INTO THE GREEN RUN.** This section exists because "4125
passed, zero skips" invites exactly the wrong inference:
- **Mutation testing STARTED 2026-08-13. FIVE guards resolved, ~24 still unattempted.** Under the
  standing rule the unattempted ones remain *unproven* — a green matrix is not equivalent to a killed
  mutant, and slice 1 recorded a mutation that reddened six tests while killing nothing.

  | Guard | Result | Run |
  |---|---|---|
  | Approvals **allowlist** | **KILLED — proven** | [`31638284349`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31638284349) |
  | Artifact **refusal-string** (unit + HTTP, both) | **KILLED — proven** | [`31641866863`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31641866863) |
  | Roadmap-edit **refusal distinctness** | **KILLED — proven** | [`31645938426`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31645938426) |
  | **G-oracle(b)** task granularity | **SURVIVED — unmeasurable, DEMONSTRATED** | [`31643354339`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31643354339) |
  | Task-board **G-cross** | **unmeasurable — NOT RUN, deliberately** | — |

  - **The allowlist kill was 1 failure out of 4125**, and it was the cited test. Mutating
    `approvalRequestId: row.id` → `row.account_id` reddened exactly the guard that asserts no internal
    column is published, and nothing else.
  - **The refusal-string kill fired BOTH claimed guards.** Two tests claimed to cover it — the unit test
    at the adapter and the §2.1a test at the HTTP boundary — and the informative question was whether the
    second was redundant. It is not: removing the `r === 'forbidden'` check reddened both, plus `G-cross`
    (a cross-company request then returns 200 carrying `'forbidden'` AS the artifact). The HTTP duplicate
    earns its place and would still catch a route rewired to bypass the adapter.
  - **G-oracle(b) SURVIVED a mutation designed to survive, and that is the evidence.** Collapsing the
    task-level `not_found` into `forbidden` at `task-controls.ts:80` reddened two real-PG core suites and
    left G-oracle(b) GREEN. `findLive` runs against `scope.db`, so a foreign task and an unknown task id
    are **both `undefined` before that line executes** — nothing there can separate them. This upgrades
    the identical slice-1 claim about CDR-087 G7(a)/G7(b) from *asserted by reading* to *demonstrated by
    run id*: a guard whose property is enforced by ABSENT INFORMATION rather than by a decision cannot be
    mutation-proven, and that is a category, not an excuse.
  - **The distinctness kill was 1 failure out of 4125, and the prediction held in BOTH directions.**
    Collapsing `stale_version` into `forbidden` reddened exactly the guard asserting the four refusals stay
    distinguishable, and **no integration suite moved** — that arm is only reachable with a stale roadmap
    id, which no matrix seeds. It was placed at the REQUEST layer on purpose, applying the M-ORACLE-B
    lesson that a fake-runtime unit test cannot witness a mutation inside `@acbp/core`. Matching the
    mutation's layer to the test being killed is the method, not an accident.
  - **Task-board G-cross is the same class as G-oracle(b), and was NOT RUN — deliberately.**
    `listBoardPage` takes **no companyId at all**; the board's tenant isolation is RLS alone, so there is
    no code-level filter to remove and no mutation that could fail the test. Running one anyway would have
    produced a red-or-green result carrying no information, which is the false-CONFIRMED failure already on
    record for trust-critical row 12. **An unrun mutation with a stated reason is worth more than a run one
    that cannot fail.**

  **THE PARTITION, which is the real result of this exercise.** Every remaining guard falls on one side:
  - **Guards over an APPLICATION DECISION are mutation-provable, and three of three were killed.**
  - **TENANT-ISOLATION guards are enforced by ROW-LEVEL SECURITY, not by application code, and are
    therefore unmeasurable by app-code mutation. That is the same fact as their strength** — app code
    cannot bypass a decision it never gets to make. Testing that class needs a MIGRATION-level mutation
    (dropping an RLS predicate), which is what the P1-014 suite already does and is a different exercise.

    Grinding through the remaining ~24 individually would re-derive this partition rather than add to it.

  - **A prediction I got half wrong, recorded because it is instructive:** I expected the request-layer
    unit test asserting `not_found` stays distinct from `forbidden` to redden too. It did not — that test
    uses a FAKE runtime, so a mutation inside `@acbp/core` never reaches it. Fake-runtime unit tests
    cannot witness core mutations; only the real-PG suites did.
- **Four routes were built implementation-first** — the three artifact reads and the approvals inbox.
  Their unit tests were written after the code and never watched to fail, which is weaker evidence
  than the watched-RED cycles behind roadmap read, task board, task detail and roadmap edit.
- **The roadmap, artifact and approvals matrices prove refusal at COMPANY SCOPE only**, not
  data-invisibility: those tables need seeding chains (`roadmaps.decision_id`, `artifacts.run_id`,
  `approval_requests.run_id` are all NOT NULL with FKs). Only the task matrices seed real rows; only
  the roadmap-edit matrix asserts from the database.
- **The approvals raw-column tripwire passes VACUOUSLY** while the inbox is empty. The allowlist is
  proven by the unit test that feeds sentinels, not by that HTTP check.

**Number:** 088, not 086. CDR-086 is claimed by ACBP-P3-006 on the unmerged branch
`p3-006-strategy-eval-area`; 087 is slice 1. `git ls-remote` shows no competing branch. This check
exists because the ACBP-P7-013 collision had three branches claim one id.

---

## §0 — What this ticket is

Expose already-built `@acbp/core` use cases at the HTTP boundary. **No new domain logic, no new
migration, no authorization decision moved out of core.** Same shape as slice 1.

### §0.1 — EXCLUDED, and not to be scaffolded toward
The held viewer-generate/delete group (#2, #3, #7, #11, #12-delete) is **owner-held**. No route, no DTO,
no result variant, and no type that anticipates it. This section is not a template for it.

### §0.2 — SCOPE FINDING: the approved "runs + artifacts" pair is only HALF available
Discovery of `packages/core/src/runs/` found **only lifecycle writes**: `startRun`, `heartbeatRun`,
`cancelRun`, `reclaimLostRuns`. A repo-wide search for `getRun` / `listRuns` / `getRunDetail` /
`listCompanyRuns` / `getRunStatus` returned **no matches**.

**There is no run-read use case in core.** Exposing "runs" as a read is therefore NOT pure exposure —
it requires authoring a new core read (repository query, authz action, result union, real-PG tests),
which is a domain addition beyond this ticket's stated scope.

**OWNER DECISION (2026-08-12): the runs read becomes its OWN TICKET — ACBP-API-003.** It is out of
scope for ACBP-API-002, which ships the artifacts half and the rest of the table below.

That ticket is a DOMAIN addition, not an exposure, and must be built as one: a repository query, a
`run:read` authorization action, a result union, real-PostgreSQL integration tests, and its own CDR.
It does not inherit this CDR's "no new domain logic" framing — §0 does not apply to it.

**Nothing in ACBP-API-002 may scaffold toward it**: no run-read result variant, no runtime method, no
placeholder route. `runs/{runId}/artifacts` below uses the run id ONLY as a selector for an artifact
query that already exists; it neither reads a run nor implies one can be read.

## §1 — Authorization: core decides, this layer maps
Inherited verbatim from CDR-087 §1. No route and no request-layer function re-checks a role. A second
authority answering the same question is the defect ACBP-P6-002 paid to delete. A viewer's refusal is
deliberately indistinguishable from a non-member's.

## §2 — The use cases being exposed (verified present, by name)

| Route | Core use case | Group | Notes |
|---|---|---|---|
| `GET .../roadmap` | `getLatestRoadmap` | 1 — pure exposure | |
| `POST .../roadmap` (edit) | `editRoadmap` | 2 — needs a response DTO | ROAD-002 versioned edit + affected-task flags |
| `GET .../tasks` | `getTaskBoard` | 1 | |
| `GET .../tasks/{taskId}` | `getTaskDetail` | 1 | |
| `GET .../artifacts/{artifactId}` | `getArtifact` | 2 | |
| `GET .../runs/{runId}/artifacts` | `listRunArtifacts` | 2 | run id is a SELECTOR here, not a run read |
| `GET .../artifacts/{artifactId}/lineage` | `readArtifactLineage` | 2 | |
| `GET .../approvals` | `listApprovalInbox` | 2 | |
| ~~run read~~ | **NONE EXISTS** | — | **deferred, §0.2** |

`getArtifact`, `listRunArtifacts` and `readArtifactLineage` were confirmed by opening the files. An
earlier claim in this programme that no artifact-read use case existed was WRONG — `export *` had
hidden them from a symbol search. Verify by opening the module, never by re-running the search that
produced the error.

### §2.1 — G3: runtime methods are REQUIRED, not optional
Each use case gets a **required** method on `CompanyRuntime`. A runtime missing one must fail to
compile. Optional methods let an unimplemented runtime ship silently. The fake runtime's defaults
**reject with the method name**, so an unstubbed call names itself in the failure.

### §2.1a — OWNER DECISION (2026-08-12): the artifact reads are ADAPTED AT THE REQUEST LAYER
`getArtifact` and `listRunArtifacts` do NOT follow the tagged-result convention every other use case here
uses. Verified by reading `packages/core/src/artifacts/persist.ts`:

```ts
getArtifact(...):      Promise<ArtifactDTO | 'forbidden' | 'not_found'>
listRunArtifacts(...): Promise<readonly ArtifactDTO[] | 'forbidden'>
readArtifactLineage(...): Promise<ReadLineageResult>   // tagged, like the rest
```

**Decision: adapt at the request layer; do NOT normalize core.** Normalizing would be a core change, which
is out of scope for ACBP-API-002 on the same reasoning that made the runs read its own ticket (§0.2).

**Consequences that MUST be honoured by the implementation:**
1. **§2.2's `Extract<R, {status:'ok'}>` derivation DOES NOT APPLY to these two.** Discriminate with
   `typeof r === 'string'` and derive the payload as `Exclude<Awaited<ReturnType<...>>, string>`. Do not
   hand-copy `ArtifactDTO`.
2. **A REFUSAL IS A STRING, AND THAT IS THE DANGER.** If a mapping fails to check, `'forbidden'`
   serializes into a 200 body *as though it were the artifact*. That is a data-leak-shaped defect the
   tagged convention makes impossible elsewhere, and here only the adapter prevents it. **A unit test
   MUST assert that each refusal string maps to a refusal and never appears in a 200 body.**
3. **`listRunArtifacts` HAS NO `not_found` ARM.** An unknown run id and a run with zero artifacts are
   indistinguishable — an empty array either way. That is oracle-safe by construction, but it means the
   route CANNOT honestly 404 an unknown run, and must not pretend to. Say so in the route comment.

### §2.2 — G4: derive payload types, never copy them
Every result payload is `Extract<CoreResult, { status: 'ok' }>['field']`. A hand-copied interface
drifts from core the first time core changes and nothing catches it.

### §2.3 — READ CORE'S PARAM AND OPTION TYPES BEFORE WRITING CALL SITES
Four slice-1 type errors all had one cause: inventing param/option shapes at the boundary. Positional
arity differs between use cases (`recordStrategyDecision` takes a `deps` slot; `getLatestStrategy` does
not, and its options carry no logger). Open each signature. Do not add casts or index signatures to
silence a mismatch — the mismatch is the message.

## §3 — Build-breaking checks these routes MUST join
- `check:rate-limit-coverage` — every handler consumes a limit or the build fails (25 → higher).
- `check:csrf-origin-gate` — state-changing routes are covered by `apps/web/src/proxy.ts`. The roadmap
  edit is the only state-changing route here; the rest are reads and the gate does not apply to safe
  methods by design.
- `check:boundaries`, `check:secrets`, `check:encoding`.

## §4 — The P1-014 adversarial matrix
Extend the existing suite; do not start a parallel one.

- **G-cross** cross-company refusal proved **FROM THE DATABASE**, not from a status code.
- **G-oracle** foreign id vs `UNKNOWN_UUID` → byte-identical status AND body, asserted at BOTH
  granularities where a sub-resource id exists (task, artifact, run-as-selector).
- **G-malformed** each `MALFORMED` id → bounded envelope whose only key is `error`, leaking no SQLSTATE,
  constraint name, table name or foreign id.

### §4.1 — FIXTURES GO IN A NESTED `beforeEach`
The parent suite calls `truncateFixtures(owner)` before EVERY test. Anything seeded in `beforeAll` is
gone before the first test body runs, and a test that does not INSERT will pass anyway against absent
fixtures — silently. Slice 1 lost three CI cycles to this.

Seed with the OWNER connection, per `decision-record.integration.test.ts`. That makes a negative
STRONGER: the foreign row provably exists and is still invisible.

### §4.2 — Mutation testing: check REACHABILITY before believing a result
A mutation must be shown to lie on the path the cited test drives. Slice 1's first G6 mutation reddened
6 tests and killed nothing because it mutated a branch that test never reaches; its failure count was
nearly identical to the valid mutation's. **A red run is not a kill — require the cited test NAMED in
the `Failed Tests` block**, and run `typecheck` on the mutation branch first, since a compile failure
produces a red run that executed no tests at all.

Expect some guards to be **structurally unmeasurable**: `company-context-resolver.ts:73-77` resolves a
foreign company and an unknown one to the same `undefined`, so no single-point mutation separates them.
Record that as unmeasurable with the reason. Do NOT record it as proven.

## §5 — Status mapping
- A read that finds nothing the caller may legitimately see and that has no sub-resource → **200 with
  an empty/null payload**, not 404 (CDR-087 §5.0 G9). An empty roadmap or task board is an honest
  first-visit state; a 404 makes a UI show an error page on a normal first visit.
- A missing SUB-RESOURCE (a specific task/artifact id) → `not_found`, kept DISTINCT from `forbidden`.
  They speak at different granularities and collapsing them loses information the client needs.
- Unknown query parameters are REFUSED with a bounded 400, never ignored — a caller must not believe a
  filter was applied when it was silently dropped.

## §6 — Open finding inherited from slice 1
`getStrategyForRequest` threads no `correlationId`, making the strategy read less traceable than the
writes. New reads here SHOULD thread one. Fixing the slice-1 case is not in scope.
