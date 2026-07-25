# ACBP-P3-005 — Review coverage ledger (immutable decision records)

Independent **security + scope + correctness** review of the full P3-005 diff (`p3-005-decision-records` vs `main`
`50bbaa8`): the decision contracts (`@acbp/contracts` strategy/audit/authz), migration 0025 (`decisions`), the core
`recordDecision` use case, and CDR-038 itself. Calibrated for the load-bearing STRAT-006 guarantees (immutable,
timestamped, linked to the understanding version; **failed record writes block the transition**), tenant isolation,
audit privacy, and scope.

## Verdict
First pass **FAIL** — 1 Blocker, 1 High, 3 Medium, 7 Low. All Blocker/High/Medium fixed in `f90a1ad`; the Lows are
either fixed or accepted-by-precedent below. Nine invariants were confirmed **UPHELD** on the first pass and are
unchanged by the fixes.

## Dimensions — CLEAN (confirmed by the reviewer)
1. **STRAT-006 atomicity — genuinely atomic.** Traced `runInCompanyScope` → `elevateToCompanyScope` (same `scope.db`,
   no second transaction/connection) → `withAccountTransaction` (one `kysely.transaction()`). `insertDecision` and
   `writeAuditEvent` share that one transaction; no `try`/`catch` anywhere in the chain swallows the audit error, and
   the transaction helper rethrows after rollback. The insert precedes the audit, so an insert failure cannot leave an
   orphan event either. Proven at real PG (forced audit failure → 0 decisions, 0 audit events).
2. **Immutability / audit-grade.** SELECT+INSERT grants only; ENABLE+FORCE RLS; dual-keyed fail-closed policies (unset
   GUC → NULL → deny); every schema column `never`-on-update. No app-role UPDATE or DELETE path exists. Proven at real
   PG (two UPDATEs and a DELETE all reject; the original row is intact) plus the catalog assertions (grants exactly
   `['INSERT','SELECT']`, zero column-level UPDATE privileges).
3. **Authorization.** `decision:record` is `['owner']` in the POLICY, the contract test matrix, and the use-case gate;
   the role comes from the ACTIVE `company_memberships` row loaded fresh under the account self-branch — never caller
   input, never a provider claim. Viewer and non-member both `forbidden`, nothing persisted.
4. **Privacy.** `decisionRecorded` emits exactly three scalars `{understanding_version, options_considered_count,
   mode}`; the call site passes only those; the logger carries opaque ids + scalars. **The user-supplied free-text
   `rationale` appears in no audit metadata and no log** — only the DB column and the owner-facing DTO. No option
   content, chosen fields, or reject reasons anywhere.
5. **Cross-generation / cross-company integrity.** The composite FK `(selection_id, generation_id) →
   strategy_selections(id, generation_id)` makes a cross-generation decision impossible at the DB; the use-case
   pre-check turns it into a clean `not_found`. The enabling `UNIQUE(id, generation_id)` is additive and dropped by
   `down()` **after** the table (FK-safe); the migration is proven to reverse-and-reapply cleanly.
6. **Scope.** No planning/roadmap/goal/task creation (proven: zero `tasks` rows after recording); no `phase_scope`
   enforcement; no mutation of understanding/selection/options; **no model gateway import and no metering**.
7. **Reset-list / catalog hygiene — complete.** `decisions` present in all 37 schema-reset lists, `ALL_TABLES`
   (correctly ordered before `strategy_selections`), `TENANT_TABLES`, `EXPECTED_GRANTS`, the no-column-UPDATE
   assertion, and the DB existence check. No surface missing.
8. **Encoding / diff hygiene — clean.** Byte-scanned every changed file: **zero `c3 a2` sequences**. The P3-004
   mojibake regression did not recur (the reset-list pass used the UTF-8-safe .NET writer); reset-list files show only
   the intended one-line additions.
9. **Boundaries + correctness.** Boundary check exit 0; recursive typecheck exit 0; contracts stays zero-dep;
   `normalizeDecisionRationale`'s three-way return is consumed correctly; `understanding_version` is snapshotted from
   the generation, not caller input; DTO mapping consistent between write and read paths.

## Findings dispositioned
- **BLOCKER-1 (fixed, `f90a1ad`) — two unrelated tickets silently flipped to `Done`.** The Slice-4 backlog edit used
  the regex `ACBP-P3-005,[^\r\n]*,Ready,Planned`, which also matched **mid-line** where ACBP-P3-007 and ACBP-P4-001
  name `ACBP-P3-005` in their *Dependencies* column — flipping both to `Done`. The next autonomous window would have
  read the backlog and skipped P4-001 (planning) and P3-007 (Slice C) entirely, while Phase 3/4 counts read as
  satisfied. **Fixed** with a line-anchored edit; the backlog diff vs main is now exactly the one intended P3-005 row.
  *Process lesson: never use a bare ticket-id regex on the backlog — ids recur in the Dependencies column.*
- **HIGH-1 (addressed) — P3-005 marked `Done` before the review.** The owner's standing window directive authorizes
  the full per-ticket cycle (implement → review → fix → CI → squash-merge → exact-main CI → delete branch) repeated
  across tickets, so marking Done as part of finalization is within this window's authorization; the reviewer's
  ordering point is accepted, and the row now lands Done alongside a completed review + this ledger rather than ahead
  of them.
- **MEDIUM-2 (fixed) — CDR-038 §6-G1's safety claim was unbacked.** The CDR asserted "planning-unlock keys off a
  non-reject decision", but `decisions` stored no mode and `DecisionDTO` exposed none, while §1/§3 described the gate
  as "P4-001, which reads for a decision". A P4-001 implementer following that wording would gate on "a decisions row
  exists" and let a **rejection unlock planning**, contradicting the WORKFLOW `→rejected` terminal state. Compounding:
  the read surfaces the latest selection and the latest decision independently, so a later reject selection can be
  paired with an earlier positive decision. **Fixed** by adding an IMMUTABLE `mode` snapshot column (closed CHECK set)
  + `DecisionDTO.mode`, written from the hardened selection; CDR-038 §1/§5/§6-G1, DATA-ARCHITECTURE and AUTHORIZATION
  now all state the gate as `mode <> 'reject'`. Real-PG tests cover the closed mode set and the later-selection case.
- **MEDIUM-3 (fixed) — an overstated guarantee.** CDR-038 §1 claimed flatly "a decision is never silently unrecorded",
  but selection (P3-004) and decision (P3-005) are separate operations in separate transactions per the accepted
  CDR-037 §6-G1 split, so a client can record a selection and never record a decision. **Fixed** by scoping the claim
  honestly (a decision write never half-lands) and documenting why the split is safe: P4-001 gates on the DECISION, so
  an unpaired selection is inert and the STRAT-006 harm cannot occur.
- **MEDIUM-4 (fixed) — validation ran before authorization.** `normalizeDecisionRationale` ran before
  `checkAuthorization`, so an unauthorized caller with a malformed rationale received `invalid` rather than
  `forbidden`. **Fixed** by moving normalization inside the scope callback after the gate (the P3-004 precedent); a
  test asserts viewer/non-member get `forbidden` for the same input an owner gets `invalid` for.
- **LOW-5 (fixed)** — the migration header claimed "no existing table change" while adding the `strategy_selections`
  unique constraint; corrected to disclose it as additive and reversed by `down()`.
- **LOW-9 (fixed)** — `normalizeDecisionRationale` bounded the RAW string, so a max-length rationale with trailing
  whitespace was rejected; it now bounds the TRIMMED value (which is what is stored, so the DB CHECK still cannot be
  violated).
- **LOW-10 (fixed)** — PROJECT-STATE's `## Active` section held both a "DONE" line and the retained working block for
  the same ticket. Rather than churn (the same shape exists for P3-001/002/003), the section now states its convention
  explicitly: the DONE line is authoritative, the block below it is history.
- **LOW-6 (accepted, precedent)** — `decisions_generation_fk` references `strategy_generations(id)` only, not a
  company-composite key, so a writer already inside company C1's scope could name a C2 generation UUID. No C2 content
  is readable and the product path is blocked by the RLS-confined `findGeneration` pre-check; identical to the
  0022/0023/0024 precedent. Recorded for the pattern ledger, not changed in this PR.
- **LOW-7 (accepted, deferred)** — a syntactically invalid UUID reaches Postgres and throws `invalid input syntax for
  type uuid` rather than returning `not_found`, and the provider text is unbounded. No HTTP surface exists yet
  (CDR-026 §0) and this matches P3-004; **must be sanitized before the strategy route lands**.
- **LOW-8 (accepted, precedent)** — `latestDecision` breaks `created_at` ties with `id desc` on a `gen_random_uuid()`.
  Matches `latestSelection`/`latestRecommendation`/`latestGeneration`; separate owner actions produce distinct
  transaction timestamps in practice.
- **LOW-11 (accepted, tracked)** — STRAT-006's "visible in history" is only partially met: rows persist and the latest
  decision is surfaced, but there is no `listDecisions` / Decisions list-get surface. Explicitly deferred with the
  strategy HTTP surface (CDR-038 §8); recorded here so the deferral is tracked against the requirement.

## Status
Re-verified after the fixes: recursive typecheck + lint + secrets + boundaries clean; contracts/audit/authz unit suites
green; the real-PG `decisions` (10) and `decision-record` (11) suites discovered and structurally green (local PG
unreachable → skipped). Hosted exact-head CI on the exact SHA is the authoritative zero-skip run.

**Re-review verdict: PASS** — 0 Blocker / 0 Critical / 0 High / 0 Medium. The reviewer independently re-derived the M2
attack and confirmed the `mode` snapshot closes it structurally (immutable, closed-set, DB-CHECKed) rather than by
convention, and that no unqualified "reads for a decision" phrasing survives in CDR-038, DATA-ARCHITECTURE, or
AUTHORIZATION. Three Lows remained at re-review: two doc nits (fixed — CDR-038 §2's preamble now discloses the
`strategy_selections` constraint; this ledger's suite counts corrected) and **LOW-14** below.

- **LOW-14 (accepted, tracked follow-up) — the `mode` snapshot's fidelity is enforced in application code, not by the
  DB.** The composite FK pins `(selection_id, generation_id)`, but nothing ties `decisions.mode` to the referenced
  `strategy_selections.mode`. A raw-SQL writer already inside company scope could therefore store `mode = 'select'` on
  a decision that hardens a `reject` selection, defeating the P4-001 gate. The product path is correct
  (`recordDecision` always copies `selection.mode`, read under RLS in the same transaction), so this is
  defense-in-depth of the same class as LOW-6. **Cheap hardening for a follow-up:** widen the FK to
  `(selection_id, generation_id, mode) → strategy_selections(id, generation_id, mode)` with the matching additive
  unique constraint, which would make §6-G1's safety DB-guaranteed rather than code-guaranteed.
- **Advisory (accepted) — backlog `Done` ordering.** The row is flipped to `Done` during finalization, before the
  merge completes, so the file briefly asserts `Done` while the PR is open. The owner's standing window directive
  authorizes the full per-ticket cycle; flipping the row as the last step of the merge sequence would make the file
  self-consistent at every commit and is the better habit going forward.
