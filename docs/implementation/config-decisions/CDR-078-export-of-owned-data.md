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

## §5 Open owner decisions

1. **The two catalogue rows that still say Post-MVP** (§2) — correct them, or record that the phase plan
   supersedes them.
2. **Archive retention.** Once an archive exists it is a copy of the founder's data sitting in the platform's
   storage; how long it may live is a privacy decision, not an engineering one, and NFR-016 owns retention
   documentation. Not defaulted here.
