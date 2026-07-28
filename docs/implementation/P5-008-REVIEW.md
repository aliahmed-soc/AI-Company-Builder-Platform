# ACBP-P5-008 — review ledger (document worker)

Two independent passes; both found real defects. Every finding is mine.

| | |
| --- | --- |
| Ticket | ACBP-P5-008 — Document worker |
| Branch | `p5-008-document-worker`, on the stack `p5-011 → p5-006 → p5-007 → p5-008` |
| Decision record | `CDR-063` |
| Requirements | **WORK-004** |
| Backlog failure clause | **"Quality-check fail = draft marked needs-revision"** |
| Backlog acceptance | *"3 doc types editable with provenance"* |

## The shape of this worker, because it is not the shape of the other two

Each MVP worker has one failure clause and no two are alike. That is not inconsistency; it is a statement about what
is salvageable:

| Worker | On failure |
| --- | --- |
| Research (P5-006) | Label the claim, or fail the task. **No bad artifact.** |
| Strategy (P5-007) | Ask, specifically. **No artifact at all.** |
| **Document (P5-008)** | **Persist it anyway — labelled.** |

The document worker is the only one that keeps its output, because a half-finished business plan is *editable* — the
acceptance criterion's own word — and discarding it costs the founder work they could have used. What would be wrong
is presenting it as finished, so the entire ticket rests on: **the draft must admit it is a draft in the bytes a
founder reads.** The warning renders above the first section heading and names every failing section; a test asserts
that ordering, not merely the warning's presence.

## Pass 1 — "does each guard do what its comment claims?"

### MEDIUM — a regex that did not match its own documented example

`UNFILLED_SLOT` listed `{{value}}` among the template-slot placeholders it detects, and did not match it: the opener
consumed one `{`, the body ran to the first `}`, and the trailing `}` had nothing left to match. A claim in a doc
comment the code never kept.

- **Fix:** anchored on repeated brackets, with `{{value}}` and `((x))` added to the placeholder test set.

### Recorded — an apparent contradiction worth stating

`unknown` is in this worker's placeholder list, while the strategy worker must **accept** `unknown` as the ADR-019
honest sentinel. Not a conflict: there it is a declared value for a named field in a structured comparison; here it is
the entire body of a prose section, which is a section nobody wrote. Same word, different unit — noted in the code so
a future reader does not "fix" one of them.

## Pass 2 — "what is untested, and what does 'editable' actually require?"

### MEDIUM — the untested-validator finding, AGAIN, one ticket later

`documentOutputValidator` was added and never exercised — exactly as `comparisonOutputValidator` and
`researchOutputValidator` had been when pass 2 of P5-007 caught them. **Shipping the guard for one case does not
generalize on its own**, which is a lesson this repo has now recorded twice and I have now needed twice.

- **Fix:** `worker-gateways.test.ts` is explicitly the home for all three, states that a fourth worker's validator
  belongs there on the day it is written, and cross-checks every validator against **both** other workers' payloads
  under its own schema ref.

### MEDIUM — duplicate section headings made "editable" untrue

Two sections could share a heading. A revision workflow (P5-012) has to address a section by something, and "the one
called Market" identifies nothing when there are two — and the needs-revision warning names failing sections by
heading, so duplicates make the warning ambiguous as well.

- **Fix:** refused, consistent with the duplicate-model and duplicate-request refusals in the other two workers.

## Known gaps, named rather than assumed

- **Nothing calls `runDocumentWorker` yet** — the dispatch path is a later ticket, as with P5-006 and P5-007.
- **The `workerId` stamped on artifacts (`document`) is not checked against the worker registry.** The registry is
  global config with no runtime write path and the resolution step belongs to dispatch; until then, three string
  literals across three modules are the only link. Worth a guard when dispatch lands.
- **The quality check judges emptiness, not quality.** Deliberate — see CDR-063 §1 G4. A document of well-formed but
  wrong prose passes, and no automated check this ticket could honestly ship would catch that.

## Evidence status

`pnpm run check` exits 0: **1500 passed / 0 failed / 1086 skipped.**

Locally proven: 20 document-contract tests and the expanded gateway-validator suite — no database needed.
**Unproven:** the 15 integration tests, dropped by `describe.skipIf` because no PostgreSQL is reachable. Hosted CI has
produced no run since the Actions billing limit was reached.
