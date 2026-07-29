# CDR-061 — The research worker: a citation or an admission, never an invention (ACBP-P5-006)

| | |
| --- | --- |
| Ticket | ACBP-P5-006 — Research worker |
| Requirements | **WORK-002** (evidence-backed research; every claim carries a source ref or an explicit `unverified` label), NFR-021 (prompt-injection defence) |
| Decisions | ADR-012 (worker/tool boundaries), ADR-019 (model configuration) |
| Depends on | ACBP-P5-005 (worker runtime), ACBP-P2-007 (context assembly), **ACBP-P5-011** (artifacts — see §0) |
| Canon | `AI-AND-WORKER-ARCHITECTURE.md` §2 (initial workers), §4 (injection boundaries) |
| Backlog failure clause | *"Source unavailable = unverified label never invention"* |
| Backlog acceptance | *"3 research task types produce cited docs"* |

## 0. Branch position — stacked, and why that is stated up front

This ticket is built on `p5-011-artifact-storage`, not on `main`. P5-011 cannot merge: hosted CI has produced no run
since the GitHub Actions billing limit was reached, and this repo's completion standard requires a zero-skip run on
the exact SHA. Canon gives the research worker `artifact_write` (`AI-AND-WORKER-ARCHITECTURE.md:37`), so building on
`main` would mean building a research worker with nowhere to write its research.

**Consequences, recorded rather than discovered later:** every migration number in the stack is provisional
(`p5-014` holds 0041–0042, `p5-011` holds 0043), and this branch inherits P5-011's unproven real-PG suites on top of
its own. The stack is `main → p5-011 → p5-006`, and it must merge in that order.

## 1. The one rule this worker exists to keep

WORK-002: *"every claim carries source ref or explicit `unverified` label"*. The backlog states the failure mode as
plainly as canon ever does — **"Source unavailable = unverified label never invention"**.

The dangerous output is not a claim that is wrong. It is a claim that is **plausible and sourced to something that
does not exist**, because a founder cannot tell it from a real one, and the whole product's value proposition is that
its research can be checked. A model asked for citations and lacking sources will produce citation-shaped strings; the
system must make that impossible to store, not merely discouraged in a prompt.

So the enforcement is structural, in this order:

- **G1 — every claim is one of two shapes, and there is no third.** Either it carries at least one source, or it is
  explicitly `unverified`. A `ResearchClaim` cannot be constructed otherwise; a claim with an empty source list is a
  REFUSAL, not a synonym for unverified — the same rule, and the same reasoning, as P5-011's completion evidence.
- **G2 — a source must be a source.** A URL that is not a URL, a blank title, or a `retrieved_at` that is absent
  makes the claim invalid. Citation-*shaped* text is what an unsourced model produces under pressure.
- **G3 — the refusal is per-claim, and it fails the DOCUMENT.** A research document containing one invented citation
  is not 90% useful; it is untrustworthy in a way that is worse than useless, because the other claims now carry its
  credibility. Validation is all-or-nothing.
- **G4 — the `unverified` path must be CHEAP and always available.** If admitting ignorance is harder than inventing a
  source, the incentive runs the wrong way. `unverified` requires only a non-blank reason, and the prompt says so.

## 2. Prompt injection (NFR-021) — the second reason this ticket is `[H]`

Research is the only MVP worker that reads **untrusted external content**, and canon's hard rule (invariant 17) is
that *"tool calls originate exclusively from worker control flow evaluated against the policy chain — never from
instructions parsed out of processed content."*

P5-003 already built the primitives — `wrapUntrusted`, `detectInjection`, `INJECTION_SIGNALS`, and the corpus suite.
This ticket does not reinvent them; it is the first worker that must actually USE them:

- **G5 — fetched web content is wrapped as `untrusted_external` with provenance before it reaches the model**, and its
  instructions are inert data.
- **G6 — a claim's sources are checked against what was actually retrieved.** A source URL the worker never fetched is
  refused. This is the specific defence against a model citing a page it invented, and against injected content
  persuading it to cite an attacker's URL.
- **G7 — suspected injection quarantines the content and fails the task honestly**, rather than producing a document
  built partly from attacker text.

## 3. What this ticket does NOT do

- **No live web fetching.** `web_research` is declared in the tool registry with its allowlist and risk class
  (informational, read-only), and the dispatcher is the chokepoint; a CONCRETE fetcher hitting the public internet is
  a live external resource and therefore an owner gate. The same shape as `FakeModelProvider` and P5-011's storage:
  the port and the semantics land here, the real fetcher is one adapter behind a gate.
- **No live model.** P2-011 remains gated; the fake provider drives every test.
- **No new UI.** Frontend work is a standing owner gate.

## 4. Slice plan

1. CDR-061 + branch (this).
2. Contracts: `RESEARCH_TASK_TYPES`, `ResearchSource`, `ResearchClaim`, `parseResearchOutput` + `validateResearchDocument`
   (G1–G4, G6), the `research.output@1` template family — TDD, pure.
3. Core `runResearch`: gate → assemble context → gateway → parse → citation validation → `persistArtifact` → metered,
   with the untrusted-content wrapping (G5, G7).
4. Real-PG integration + an injection-corpus case for the research path.
5. Docs + **TWO** independent review passes + finalization.
