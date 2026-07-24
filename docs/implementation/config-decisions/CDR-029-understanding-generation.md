# CDR-029 — Understanding generation (ACBP-P2-008)

**Status:** Accepted (autonomous lead, standing Phase 2 authorization). **Requirements:** UNDER-001, UNDER-005
(+ UNDER-002 fact/assumption separation, already enforced by P2-006 typing). **Governing ADRs:** ADR-011 (gateway),
ADR-019 (model config + non-silent-fallback), ADR-015 (audit). **Architecture:** diagrams/04 (`gen` node),
DATA-ARCHITECTURE §3 (Understanding object = versioned `V`, company-scoped `C`, confidence). **Depends on:**
P2-005 (Done), P2-006 (Done). **No open question blocks it.**

Generate a **classified, versioned business-understanding document with confidence** from the company's confirmed/
typed memory (diagram 04: `more(required fields covered)=yes → gen`). This is the structural twin of P2-005: all
model calls go through the P2-003 **gateway** using the deterministic **FAKE provider** — building + testing an
understanding generator is autonomous. **Live generation + the HTTP understanding routes are the pre-existing
deferred owner gate CDR-026 §0** (real key + `gpt-5.1` snapshot pin + ADR-019 §13 eval gate); building P2-008 does
NOT open it. Review/confirm (the 5 controls + the planning gate) is **P2-009**, out of scope.

## 1. Document structure (diagram 04 `gen` node + UNDER-005)

The understanding document is a set of **classified items** in the CLOSED 6-class set the diagram names:
`fact · preference · constraint · assumption · research_finding · open_question`. Each item carries `content`,
`confidence` (numeric in [0,1]), and a `source_ref` (the memory item it derives from — provenance, MEM-003). The
6 classes map from the P2-006 memory types (`user_fact`→fact, `user_preference`→preference, `constraint`→
constraint, `ai_assumption`→assumption, `research_finding`→research_finding) plus `open_question` for gaps the
interview left unanswered — so the classification is **derived from provenance, not invented** (UNDER-002: type set
by source path, never by content — a generated claim can never become a `fact`).

## 2. Sections + "present / unknown / assumed" + confidence per section (acceptance)

Each of the 6 classes is a **section**. A section's `status` is:
- **present** — it has one or more confident items,
- **unknown** — no items (a genuine gap; surfaced honestly, never fabricated),
- **assumed** — its content rests only on assumptions (assumption-class provenance).
Each section has a `confidence` (the aggregate of its items' confidences; an empty/unknown section = 0). The
**overall document confidence = the WEAKEST section (min)** — UNDER-005's weakest-section rule (a document is only
as trustworthy as its least-supported area). Confidence is numeric; a band label (low/medium/high) is derived for
display, not stored as an independent source of truth.

## 3. Partial generation labeled partial ("Partial generation labeled partial")

If the model call fails, returns a malformed payload, or produces only some sections, the document is persisted
with `status = 'partial'` (honest degradation — never a `complete` document that silently omits sections). A
fully-generated document is `status = 'complete'`. This mirrors P2-005's static-fallback honesty.

## 4. Versioned (DATA-ARCHITECTURE `V`; "Versioned")

Each generation produces a NEW `version` (monotonic per company) — understanding is versioned, never edited in
place; a re-generation supersedes by adding a new version. Items belong to a document version and are immutable.

## 5. Schema — migration 0019 (`understanding_documents` + `understanding_items`)

Additive (0001–0018 untouched; no new SECURITY DEFINER — still three; no BYPASSRLS; no owner runtime). Two
company-owned, dual-keyed FORCE-RLS tables (the `memory_items`/`interview_questions` pattern):
- `understanding_documents`: `id`, `account_id`, `company_id`, `version` (int, unique per company), `status`
  (`complete|partial` CHECK), `overall_confidence` (double precision [0,1]), `created_by_user_id` (nullable —
  worker/system-authored), `created_at`. SELECT + INSERT only (append-only; a re-generation is a new version).
- `understanding_items`: `id`, `account_id`, `company_id`, `document_id` (FK), `item_class` (CHECK in the 6-set),
  `content`, `confidence` (double precision [0,1]), `source_ref` (bounded), `created_at`. SELECT + INSERT only.
Dual-keyed fail-closed policies (account AND company). Cross-company reads impossible.

## 6. Generation + metering + audit + tenancy

`generateUnderstanding` composes the existing scoped primitives: read confirmed/typed memory DIRECTLY via P2-006
`listMemoryItems` (company-scoped; full context assembly + secret blocklist is P2-007, not required here — the
inputs are first-party company-scoped memory), build the gateway request from a new `understanding.generate`
template + output schema, call the gateway (model call BETWEEN scoped ops, never in a held tx), validate the
structured output (deny-by-default), compute sections + weakest-section confidence, then persist the version +
items in ONE company-scoped transaction with the `understanding.generated` audit event (audit-or-nothing).
Every call meters usage (the gateway's fail-closed `usage_events`). `understanding.generated` is a NEW registered
audit event (metadata: `{version, status, item_count}` — bounded, no content).

## 7. Slice plan

1. **Contracts**: the 6-class enum + item/section/document DTOs + the generation output schema + deny-by-default
   `parseUnderstanding` + the pure confidence/weakest-section/section-status logic + `understanding.generated`
   audit registration + an `understanding.generate` template. (unit-tested) + this CDR.
2. **Migration 0019** `understanding_documents` + `understanding_items` + repo/schema + real-PG suite.
3. **Core** `generateUnderstanding` (memory → gateway → classify → persist version+items + audit, in-tx;
   partial labeling; usage metered) with the gateway injected; integration tests against the fake provider.
4. **Composition** validator + real-PG integration (persist under RLS; weakest-section; partial; audited; metered).
5. **Docs** (INTERVIEW.md/AI-AND-WORKER, EVENT-CATALOG, DATA-ARCHITECTURE) + reviews + finalize.

## 8. Out of scope / deferred

Understanding REVIEW + the 5 controls + the owner-only confirm/planning gate (P2-009); the HTTP understanding
routes + live provider (CDR-026 §0 — sequenced with the live provider, exactly as P2-005 deferred its routes);
strategy generation (P3-001); context assembly + secret blocklist (P2-007); the evaluation suite (P2-011);
dependency-staleness re-evaluation on correction (P2-009/DISC-008). No `understanding.corrected` event (P2-009).
