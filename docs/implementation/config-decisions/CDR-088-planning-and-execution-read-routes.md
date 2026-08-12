# CDR-088 — HTTP routes for planning and execution reads

**Status:** proposed · **Ticket:** ACBP-API-002 (slice 2 of the missing-route programme) ·
**Base:** `main` at `3cbfc89` · **Predecessor:** CDR-087 (slice 1, merged `d1d4ae8`).

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
