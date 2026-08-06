# ACBP-P7-008 — review coverage ledger

Branch `p7-008-failure-injection-pass`, draft PR #81. Companion to CDR-084 and to
`P7-008-SCENARIO-EVIDENCE.md` (which is generated — do not edit it).

**This file records REVIEW FINDINGS. The evidence lives in `tools/failure-scenario-index.mjs` and is rendered.**
Written that way on purpose: ACBP-P7-007's ledger opened with a status sentence that was true when written and
false the moment the ticket merged, and a review pass had to catch it. Claims here name commits, not states.

---

## §1 What review found, in the order it was found

Every item below changed code or an artefact. Items marked **self-caught** were found by me before any gate ran;
they are listed because a ledger that only records what a reviewer found overstates how clean the first draft was.

| # | Found in | The defect | Fixed in |
|---|---|---|---|
| 1 | slice 1 | CDR-084's provisional disposition table recorded rows 6 and 14 as having **no coverage**. Both were wrong — row 14 is among the best-covered rows in the repository. | `259dcea` |
| 2 | slice 1 | The CDR's premise "build the fault-injection rig" was **retracted entirely**: the rig already exists. | `259dcea` |
| 3 | slice 3, **by the new checker on its first run** | **Four of sixteen `testTitle`s were written from memory rather than read.** The checker named all four. Row 15 had also moved file. | slice 3 |
| 4 | slice 3, **self-caught via lint** | `isRunId` was imported into the migrated checker without being used — meaning the inline `/^\d{6,}$/` was still there. Extraction that leaves the duplicate behind is not extraction. | slice 3 |
| 5 | slice 3, **self-caught** | The new checker's test harness had a `row()` helper that accepted overrides and never spread them, so `secondRow()` silently duplicated row 1 and 17 cases failed for an unrelated reason. Driving the checker by hand exited 0, which located it. | slice 3 |
| 6 | slice 4 | Canon says an expired approval "cannot execute". Both indexes proved it **at the repository layer only**, through a `decider_type` CHECK test about *who* may decide rather than *when* one lapses. Searching either dispatcher suite for "expired" returned **zero** cases while every sibling approval state had one. The enforcement was in production and nothing drove it. | slice 4 |
| 7 | slice 5 | Launch **gate 8** was measured from a raw `INSERT INTO emergency_stops` helper *named* `activateStop`, so the ≤5s window measured transaction visibility and **excluded activation entirely** — ACBP-P7-007 recorded this as trust-critical #10's defect and could not fix it there. | slice 5 |
| 8 | slice 6 | **Eighteen of the thirty-three `mutation` cells were wishes, not edits** — they named no function, file or column. Three were not merely vague but wrong; one (trust-critical #1) was an **equivalent mutation** whose green probe would have been read as proof. | `0cca4e2` |
| 9 | slice 6, **by the new rule, on a row I had written an hour earlier** | Trust-critical #10's rewritten mutation still named no symbol — `evaluateStops` was unnamed. | `0cca4e2` |
| 10 | slice 6, review of my own diff | The mutation rule's tokeniser **did not admit hyphens**, so `enqueue-job.ts` became `job.ts` and a row naming a real file would have read as stale. **A rule that fails honest rows is worse than one that misses a bad row** — people delete it. | `668198f` |
| 11 | review of the **rendered** document | I asserted that `workflow_dispatch` cannot help the branch that adds it. **Tested instead of assumed: it can** — run `31128906516` was created on `2314ef7` during the outage. | `c2649aa` |
| 12 | review of the **rendered** document | Four `entryPoint` cells named prose where a real function exists, and **row 15's named the wrong place entirely** (worker runtime step boundary, while its test drives `dispatchToolCall`). The same defect I had corrected in row 16 an hour earlier and not swept for. | `c2649aa` |

---

## §2 What the review method actually caught, and what it did not

**Tools caught 3, 4, 5, 9.** Every one was a case where the artefact and the code disagreed and a machine could
see it. That is what the two index checkers are for, and the ratio is the argument for building them.

**Reading a DIFFERENT rendering caught 11 and 12.** Both had survived two passes over the index itself. This is
the "verify with a different anchor" rule paying out: re-checking with the method that produced the work
verifies nothing. The rendered document was the different anchor.

**Nothing mechanical caught 6, 7, 8 or 12's root.** Those needed someone to read a test body and ask whether it
asserts what its row claims. The limits are recorded where they apply rather than papered over:

- a `mutationRunId` is **shape-checked, never resolved** (CDR-080 §7.10);
- **nothing cross-checks a mutation against the test title it claims to redden** (CDR-080 §7.11);
- the new mutation rule **cannot tell a right symbol from a wrong-but-real one** — scenario row 16 named
  `startRun` while its test drives `enqueueJob`, both real, same file. Pinned as a test case so the limit
  cannot quietly stop being true.

---

## §3 The acceptance criterion is NOT met, and this is why

"16-scenario matrix green" means, per CDR-084 §1, that a recorded mutation made the cited test go red in a
hosted CI run. **0 of 16 rows are `measured`.** Fourteen have live tests that pass; nothing has yet proved any
of them can fail. Two have no injectable subject.

The probe is written and ready (each row's `mutation` is now an applicable edit naming real code) and was
blocked for the whole of 2026-08-06–07 by a **major GitHub Actions outage**, during which no workflow run was
created for this branch by any push. The manual trigger added at `2314ef7` is what re-opened the route.

---

## §4 Owner decisions this ticket does not take

CDR-084 §7, unchanged: rows 5, 6, 8, 10 and 16; whether NFR-019 stays `Covered` while its queue/banner/drain
half is unimplemented; and the Closed-beta launch-gate sign-off. Row 16 is a **canon contradiction** — the
matrix requires in-flight safe-stop, `WORKFLOW-STATE-MACHINES.md:35` says pause does not terminate a running
run. One of the two is wrong, and that is an architecture decision rather than a test decision.
