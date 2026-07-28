# CDR-063 — The document worker: a draft that admits it is a draft (ACBP-P5-008)

| | |
| --- | --- |
| Ticket | ACBP-P5-008 — Document worker |
| Requirements | **WORK-004** |
| Decisions | ADR-012 (worker/tool boundaries), ADR-019 (no fake precision) |
| Depends on | ACBP-P5-005 (worker runtime); **ACBP-P5-011** (artifacts — the backlog's Data column) |
| Canon | `AI-AND-WORKER-ARCHITECTURE.md` §2: *"structured editable documents with provenance"* |
| Backlog failure clause | **"Quality-check fail = draft marked needs-revision"** |
| Backlog acceptance | *"3 doc types editable with provenance"* |
| Risk class | **Internal-reversible** (the other two MVP workers are informational) |

## 0. Branch position

Stacked on `p5-007-strategy-worker` → `p5-006-research-worker` → `p5-011-artifact-storage`, for the reason recorded in
CDR-062 §0: these tickets are nominally parallel but all edit the same barrels and template registry, and none can
merge while hosted CI is producing no runs. Merge order: `main → p5-014 → p5-013 → p5-011 → p5-006 → p5-007 → p5-008`.

**Canon and the task-type list AGREE for this worker** — `business_plan_generation`, `landing_page_copy` and
`internal_product_requirements` are all in the closed `TASK_TYPES` set. No conflict to resolve, unlike P5-007.

## 1. This worker fails DIFFERENTLY from the other two, and the difference is the design

Each MVP worker has one failure clause, and all three are different — which is not an inconsistency but a statement
about what is salvageable:

| Worker | Failure clause | On failure |
| --- | --- | --- |
| Research (P5-006) | *"Source unavailable = unverified label never invention"* | Label the claim, or fail the task. **No bad artifact.** |
| Strategy (P5-007) | *"Insufficient input = specific request"* | Ask. **No artifact at all.** |
| **Document (P5-008)** | *"Quality-check fail = draft marked needs-revision"* | **PERSIST IT ANYWAY — labelled.** |

The document worker is the only one that keeps its output when the check fails, and that is right: a half-finished
business plan is **editable** (the acceptance criterion's own word), so discarding it throws away work the founder can
use. What would be wrong is presenting it as finished.

So the whole ticket turns on one thing: **the draft must admit that it is a draft, in the bytes a founder actually
reads.** A `needs_revision` flag that lives only in a database column is the hollow success again wearing different
clothes — the founder opens the document, sees no warning, and treats it as done.

- **G1 — two statuses, and the status is DERIVED, never supplied.** `complete` or `needs_revision`, decided by the
  quality check from the document itself. A model that could set its own status would always set `complete`.
- **G2 — `needs_revision` is written into the document.** The rendered markdown opens with the warning and names
  every section that failed, before any content. Not a footnote.
- **G3 — a failing check NEVER blocks persistence.** The artifact is written either way. This is the one place in the
  three workers where refusing would be the wrong answer.
- **G4 — the quality check is about EMPTINESS AND PLACEHOLDERS, not about being good.** A section that is blank, or
  that says `TBD` / `TODO` / `[insert x]`, is a section the model did not write. Judging prose quality is not
  something this check can honestly do; detecting that nothing was said is.
- **G5 — provenance is REQUIRED.** Canon asks for *"structured editable documents with provenance"*, and the
  acceptance repeats it. Every document records which approved context refs it was built from, and a document citing
  none is refused outright — that is a build with no inputs, not a draft.

## 2. Structure, because "editable" is a requirement

A document is SECTIONS, not a blob: a heading and a body, in order. That is what makes it editable in the sense the
acceptance means — a founder can revise one section without rewriting the document, and a later revision (P5-012) can
be diffed against it section by section.

## 3. What this ticket does NOT do

- **No editing UI, no revision workflow.** P5-012 owns revision; frontend is a standing owner gate. This ticket
  produces documents whose structure makes those possible.
- **No web access** — *"Internal tools only"*, like the strategy worker. No fetch, no injection screen.
- **No live model** (P2-011 remains gated).

## 4. Slice plan

1. CDR-063 + branch (this).
2. Contracts: `DOCUMENT_TYPES`, `DocumentSection`, `StructuredDocument`, `parseDocumentOutput`,
   `assessDocumentQuality`, `renderDocumentMarkdown` — TDD, pure.
3. Core `runDocumentWorker`: gateway → parse → assess → persist (either way) → report the status.
4. Real-PG integration, including all three doc types (the acceptance names three).
5. Docs + **TWO** independent review passes + finalization.
