# CDR-078 — Export of documents and owned data (ACBP-P7-001)

Governing: **EXPORT-001**, **NFR-014** (open-format portability); ADR-016 (generated-artifact storage), ADR-002
(export is the ownership guarantee); `diagrams/15-data-lifecycle`; **trust-critical #2 (export path)**;
**invariant 19** (ownership check per archive). Depends on **ACBP-P5-011** (Done).

---

## §0 What an export is FOR, and why that decides the design

ADR-002 makes export the **ownership guarantee**: the answer to "what happens to my work if I leave". That is not
a convenience feature, and it fails in two directions that look nothing alike.

**Under-delivering is the obvious one** — an archive missing the founder's documents, or one that silently drops
what it could not read. The acceptance criterion is *"archive matches in-product data"*, and the failure behaviour
canon specifies is not "fail" but **"partial export enumerates missing"**: an archive that quietly omits is worse
than one that says what it could not include, because only the second can be acted on.

**Over-delivering is the dangerous one.** An export is the one product path whose entire purpose is to move data
OUT of the platform's control, to a destination the platform will never see again. Every other control in this
codebase can be tightened later; a secret that leaves in an archive is gone. Hence two properties that are not
negotiable and are not comments: **zero secrets in any archive**, and **ownership verified per archive**
(invariant 19), never inferred from who asked.

Those two directions are in tension — completeness pushes toward including everything, safety toward excluding —
and every gate below is a ruling about where the line sits.

## §1 The storage gap, stated first because it bounds what this ticket can claim

**The object-storage PORT is complete. The production ADAPTER does not exist.**

| Piece | Where | State |
|---|---|---|
| `ObjectStorage` (put/get/head, byte transport) | `contracts/adapters/storage-provider.ts` (P0-019) | **complete** |
| `SignedUrlIssuer` + TTL clamp + bucket config | `contracts/storage/port.ts` (P0-005; CDR-048) | **complete** |
| Content-addressed key derivation, tenant-prefixed | `contracts/storage/object-key.ts` | **complete** |
| Artifact/revision/verification contracts | `contracts/storage/*` (P5-011) | **complete** |
| **An S3-compatible implementation** | — | **does not exist** |
| In-memory implementation | `adapters/in-memory-storage.ts` | exists, tests only |

ADR-016 and CDR-048 chose an S3-compatible provider and ACBP-P0-005 is `Done` **as a decision**. No code
implements it, and no dependency for it is installed.

**DECIDED (owner, this session): build the mechanism against the port and disclose the gap.** Everything this
ticket asserts — ownership verification, manifest correctness, secret exclusion, cross-tenant denial, partial
enumeration — is provable against the in-memory adapter, because none of those properties are about S3. What is
**not** provable, and is therefore **not claimed anywhere**, is that an archive lands durably in object storage.

- **G1.1 — P7-001 is not production-complete when it merges.** It is mechanism-complete. Provisioning storage is
  an owner gate (a live external resource), and the adapter is its own work.
- **G1.2 — No fake adapter ships.** An "S3 adapter" that writes nowhere would be worse than none: it would make
  the gap invisible to exactly the reader who needs to see it. The in-memory adapter is honest about being
  in-memory.
- **G1.3 — This is recorded in the DONE line and the PR, not only here.** The failure this programme keeps
  finding is a mechanism that is designed, catalogued and reaches nothing (CDR-074 §5.4, CDR-075 §4.3). Naming
  it in the CDR alone has not been enough.

## §2 A canon conflict about WHEN, ruled rather than picked silently

Four documents disagree about whether export belongs in this phase:

| Source | Says |
|---|---|
| `COMPONENT-CATALOG.md:33` (Export module) | **Post-MVP** |
| `API-CONTRACTS.md:77` (Exports row) | **EXPORT-001/002 (Post-MVP)** |
| `ADR-002` §12 | *"Export commitments are binding … EXPORT-001 **at beta**"* |
| `SECURITY-VERIFICATION-PLAN.md:22` | Export at **M7**, supporting **Gate 12** |

**Ruled: build it now.** Phase 7 *is* closed-beta readiness, ADR-002 places EXPORT-001 "at beta", and the
security plan schedules its verification at M7 with a launch gate depending on it — three sources putting it in
this phase against two catalogue cells that predate the phase plan. The safer reading also happens to be the one
that ships the ownership guarantee earlier rather than later.

**Not silently reconciled**: the two catalogue rows still say Post-MVP and are left untouched by this ticket —
editing canon to match an implementation decision is how a conflict becomes invisible. Flagged for the owner as
a one-line correction if they agree.

## §3 Design gates

- **G3.1 — Ownership is verified per ARCHIVE, from the server's own scope** (invariant 19). Never from a
  requested account/company in the payload. The same discipline `enqueueJob` uses: stamp from the resolved scope,
  because the two are equal only by coincidence of the current call path.
- **G3.2 — Secret exclusion is ENFORCED, not promised.** Reuses `containsSecret` / `redactSecrets` /
  `SECRET_PLACEHOLDER` from ACBP-P2-007's context assembly rather than inventing a second detector — two secret
  detectors would eventually disagree, and the one that matters is whichever the export happens to call. Every
  text field entering an archive passes through it.
- **G3.3 — Detection failure excludes, never includes.** If a field cannot be scanned (unexpected type, unreadable
  encoding) it is omitted and enumerated as missing. The asymmetry is the whole point: a missing document is a
  complaint, a leaked secret is unrecoverable.
- **G3.4 — Partial is a FIRST-CLASS outcome, not an error** (canon: *"partial export enumerates missing"*). The
  manifest names every item that could not be included and why, in a closed reason vocabulary. An export that
  fails wholesale because one row was unreadable converts a partial answer into no answer.
- **G3.5 — The manifest is the archive's own inventory**, written from what was ACTUALLY included, never from
  what was intended. A manifest generated from the query plan rather than the emitted bytes will agree with
  itself and disagree with reality — the CDR-073 §0 failure shape.
- **G3.6 — Open formats only** (NFR-014). JSON for structured data; artifacts keep their stored format. No
  platform-proprietary container.
- **G3.7 — Exports are audited**, and the audit records the SCOPE and the counts, never the content.
- **G3.8 — Cross-tenant is denied and says nothing.** A refused export must not confirm whether another tenant's
  data exists — the `SignedUrlResult` precedent, which distinguishes `forbidden` from `not_found` internally
  while refusing to leak the difference outward.
- **G3.9 — Re-runnable** (canon: rollback/recovery is "re-runnable"). An export produces no state a second run
  would corrupt.

## §4 Scope boundaries

- **No HTTP surface.** The API-CONTRACTS export row is Post-MVP and there is no route to hang it on; building
  one would invent a requirement. The core use case is the boundary this ticket delivers.
- **No S3 adapter** (§1). Its own ticket, behind an owner gate.
- **No EXPORT-002** (transfer-aware formats, ADR-002's "direction") — a separate requirement id, not this one.
- **No deletion or deactivation semantics** — that is ACBP-P7-002.

## §6 What is IN the archive, and the guard that keeps that answer honest

The single largest way this ticket can fail acceptance is a collection nobody remembered to export. Nothing about
a bespoke read per entity would ever catch it: the code would be correct about everything it mentioned and silent
about everything it did not, and the archive would look complete to every test written against it.

- **G6.1 — The classification is TOTAL over company-scoped tables.** Every table carrying a `company_id` is in
  exactly one of two closed lists: `EXPORT_COLLECTIONS` (in the archive) or `EXPORT_EXCLUSIONS` (not, with a
  reason from a closed vocabulary). Neither list may name a table twice, and no table may appear in both.
- **G6.2 — A real-PostgreSQL guard asserts the classification against the LIVE schema**, not against a
  hand-maintained list. A table added by a future migration fails the guard until someone rules on it. This is
  the control that makes "archive matches in-product data" a property rather than a hope, and it is deliberately
  anchored on `information_schema` — a different anchor from the `DatabaseSchema` interface the export reads
  through, so a wrong entry in one cannot excuse itself in the other.
- **G6.3 — Exclusions are ruled, not defaulted.** The vocabulary is `third_party_identity` (another person's
  identity is not the founder's data to take), `separate_export_surface` (audit has its own reason-captured
  export — API-CONTRACTS `:75`), `derived_projection` (rebuildable from what IS exported; CDR-073's rule that a
  projection is never a source of truth), `platform_operational` (the platform's own machinery, not the founder's
  work), and `billing_record` (the platform's books; BILL-\* owns them).

### §6.1 The generic reader, and why it beats a mapper per entity

Collections are read as whole rows through one company-scoped reader over a **closed table allowlist**, not
through a hand-written DTO per entity. The trade is deliberate and runs in the safe direction:

- a bespoke mapper that forgets a column **under-delivers silently** — the ADR-002 failure, invisible to tests;
- a generic reader that picks up a new column **over-delivers into the secret guard**, which redacts, counts and
  reports it.

The allowlist is what keeps "generic" from meaning "arbitrary": the table name never originates from input, only
from the closed set, and the reader re-checks membership itself rather than trusting its caller's type.

### §6.2 Every value, not every field named in advance

`sanitizeExportText` handles one text field. A row is not a text field: JSON columns nest, and a secret pasted
into `payload.notes[2]` is exactly as gone as one in a top-level column. So the row walk is **recursive over
values**, applying the blocklist to every string leaf at any depth.

- **G6.4 — A value the walk cannot represent EXCLUDES ITS WHOLE ROW** (§3-G3.3 at value granularity), rather than
  being dropped from an otherwise-included row. A row silently missing one field is a lie about that row; an
  enumerated omission is a complaint the founder can act on.

### §6.3 Ownership is re-verified per ROW, beneath RLS

RLS already scopes the read. G3.1 still requires the archive to verify, because invariant 19 is a property of the
archive, not of the query that filled it:

- **G6.5 — The archive is stamped from `scope.tenant`, never from the request parameters.** They are equal only
  by coincidence of the current call path, which is the same reasoning `enqueueJob` uses.
- **G6.6 — A row whose `company_id` is not the scope's is OMITTED with `ownership_unverified`**, never included.
  Unreachable while RLS holds — which is the point: this is the layer that still refuses if RLS ever does not,
  and it is a pure function so it can be tested and mutated without needing RLS to be broken first.

### §6.4 Truncation is an omission, never a silent cap

Every other read in this codebase is bounded, and an unbounded export read is a real memory hazard. But a bound
that silently drops rows converts the ownership guarantee into a lie of exactly the shape §0 warns about.

- **G6.7 — The read asks for `cap + 1`.** If the extra row comes back, the collection ships its capped rows AND
  is enumerated as `truncated`, so `complete` is `false` and the founder is told which collection was cut. The
  bound is honest in both directions: nothing is lost silently, and nothing unbounded is loaded.

### §6.5 The omission vocabulary shrank, because a reason nothing can produce is a lie

The manifest slice shipped `unsupported_format`. **Nothing produces it** — artifact *bytes* are not copied by
this ticket (there is no storage adapter to copy them from, §1), so no format is ever rejected. It is removed
rather than left in place: a reader switching on the vocabulary would treat it as a case that can occur, and
"catalogued, reaches nothing" is the exact failure CDR-074 §5.4 and CDR-075 §4.3 both had to disclose. The
vocabulary is now `unreadable`, `ownership_unverified`, `truncated` — each with a producer named above.

### §6.6 Ordering: objects first, audit last

The audit event is written **after** the archive exists.

- Audit-then-write would leave, on a storage failure, an audit record asserting an export that does not exist —
  a trail that lies, which is worse than no trail.
- Write-then-audit leaves, on an audit failure, objects in storage with no record. Those are **inert**: the key
  carries a per-run identifier, nothing lists a prefix, and no surface can hand out a link to an archive with no
  audit row. Re-running produces a fresh prefix (§3-G9), so the failure costs storage, not correctness.

### §6.7 What this ticket deliberately does NOT persist

**There is no `export_jobs` table**, though the BACKLOG data-objects cell names one and EVENT-CATALOG `:279`
names an `export_job_id`. A job row exists to be *polled*, and §4 already ruled out the HTTP surface that would
poll it — so the table would have exactly one writer, no reader, and no status anyone can observe: the "designed,
catalogued, reaches nothing" shape again, this time built on purpose. The **audit event is the durable record**
(EVENT-CATALOG already calls it audit-grade, permanent), and its subject is the archive. When the export API
ticket arrives and something needs a status to poll, the table belongs to it.

## §7 Open owner decisions

1. **The two catalogue rows that still say Post-MVP** (§2) — correct them, or record that the phase plan
   supersedes them.
2. **Archive retention.** Once an archive exists it is a copy of the founder's data sitting in the platform's
   storage; how long it may live is a privacy decision, not an engineering one, and NFR-016 owns retention
   documentation. Not defaulted here.
3. **The exclusion rulings in §6.3 are engineering defaults on a privacy question.** `memberships` /
   `company_memberships` are excluded because they carry *other people's* identities; `usage_events` /
   `credit_transactions` / `usage_corrections` because they are the platform's books. A founder could reasonably
   argue their own billing history is theirs. Flagged rather than treated as settled.
