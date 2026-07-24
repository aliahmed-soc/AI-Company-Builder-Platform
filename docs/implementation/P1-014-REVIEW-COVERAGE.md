# ACBP-P1-014 — Independent review disposition

Three independent reviewers covered the owner's ten lenses against the tenant-isolation adversarial suite.
Defects and their fixes are itemised in [`P1-014-DEFECT-LEDGER.md`](./P1-014-DEFECT-LEDGER.md); this file
records the lens coverage and the disposition of every finding.

## Lens coverage

| Lens | Scope | Verdict |
|---|---|---|
| 1 | Threat-model completeness | 2 HIGH + 7 Medium/Low — all fixed |
| 2 | Execution as `acbp_app`, not owner | Materially clean; 1 Medium (runtime-role proof) fixed |
| 3 | RLS predicate-removal proof | 2 HIGH + 4 Medium — all fixed |
| 4 | HTTP real-database path fidelity | 2 HIGH — fixed |
| 5 | IDOR / enumeration / existence-oracle resistance | 1 HIGH + 3 Medium — fixed |
| 6 | Pooling / GUC / concurrency determinism | Strongest area; 2 Low robustness nits |
| 7 | Authorization and admin-authority separation | Clean, bidirectional, negative-only; 2 Low |
| 8 | Audit / activity / log privacy | 3 of 4 claims clean; 2 Medium fixed |
| 9 | CI runtime and flake resistance | Within ceiling; consolidation options recorded, not required |
| 10 | Ticket scope and defect-fix compliance | Class R change verified in scope; 1 HIGH tooling defect fixed |

## Highest-value findings

Two reviewers independently reached the same two HIGH conclusions, which is the strongest signal in the round:

1. **Trust-critical #20 could not detect its own regression.** Forged provider claims named placeholder ids,
   so code that began trusting `publicMetadata.accountId` would have resolved to nothing and still denied —
   green while a claim-trusting bypass shipped. Claims now name the real target tenant, and a source guard
   asserts no production file reads provider metadata at all.
2. **`CURSOR-CROSS-COMPANY` returned before its only assertion on every run.** A freshly created company has
   exactly one activity row, so a limit-1 page never produced a cursor. The test now generates a second row
   and treats the cursor as a hard precondition.

A third HIGH was a **tooling** defect: `check-boundaries.mjs` stripped block comments before line comments, so
a `//` comment containing `/*` erased a file's entire import list and the gate reported clean on the one file
that violated it. Fixed; the harness then moved to `packages/test-support`, its canonical home.

## Owner-gated finding

**`activity_events.event_id` global uniqueness** was escalated as a Class M gate and resolved by the owner as
**Option C — accept and document** (no migration 0012; no schema, index, RLS, grant, API or production
behavior change). The full evidence, the accepted principles, and the regressions that pin them are recorded
in the defect ledger under **R-A1**, and summarised for implementers in the suite README under
*"Identity uniqueness: what is global, and why that is safe"*.

## Disposition summary

- **No unresolved Critical, High, Medium, or reasonable in-scope Low remains.**
- **10 Class T** defects fixed (test/fixture only).
- **1 Class R** production fix: bounded HTTP error envelopes on the company and account routes, restoring the
  accepted "all cross-boundary errors are bounded and sanitized" invariant. No success or denial semantics
  changed; a source guard prevents regression.
- **1 Class M** raised and owner-decided (R-A1, above).
- **2 residual observations** carried deliberately: denial-timing differences that reveal only the caller's own
  state, and the `users` / `identity_webhook_receipts` global identity substrate, which is intentional and
  scoped rather than a gap.
- No test was weakened to pass. Where an expectation contradicted accepted behavior, the assertion was
  replaced with the sharper true invariant and the behavior documented.
