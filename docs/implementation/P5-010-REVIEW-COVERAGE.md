# ACBP-P5-010 — independent review coverage

Ticket: **ACBP-P5-010** structured-output validation hardening (NFR-007; trust-critical #18 groundwork). Branch
`p5-010-structured-output-hardening`, PR **#46**, CDR-046.

Both passes returned **FAIL**, both with Medium findings — no High. That is consistent with the ticket's shape: it
adds no product behaviour, so the failure modes available to it are about whether the *tests* mean what they claim.

**The ticket's largest finding came before either pass**, during the CDR: every mechanical clause of the Objective was
already implemented by P2-003. See CDR-046 §2.

## Before the passes — the ticket is proof, not build

Checked clause by clause against `model-gateway.ts` and `contracts/model/gateway.ts` before writing anything:
schema-first validation, the terminal `invalid_output` category, the clamped re-ask bound, usage accumulated across
attempts, and no partial-accept path — **all present**. Re-implementing any of it would have produced two behaviours
that can disagree, surfacing as a model output one caller accepts and another rejects.

So the deliverable is the conformance suite the backlog actually names ("Invalid-output tests", "Validation suite").

## Two drafting errors caught LOCALLY, not in CI

Worth recording because they are the argument for the suite being a unit test:

- The first draft asserted `maxReask = N ⇒ N + 1` calls for arbitrary `N`. It expected 4 calls for `N = 3` and got 2
  — because the platform **clamps re-ask to one** (`MAX_REASK_ATTEMPTS`, CDR-026 §1). Asserting `N + 1` for arbitrary
  `N` would have been asserting the *absence* of the cap, which is the opposite of NFR-007. The test now pins the cap.
- `freeTextRequest` spread `outputSchemaRef: undefined`, which does not compile under `exactOptionalPropertyTypes` —
  absent and `undefined` are different things, and "the caller supplied no schema" is the case under test.

Neither cost a CI round-trip. `callModel` takes its provider, usage sink, cost estimator and validator by injection,
so the whole suite runs locally in ~1s.

## Pass 1 — FAIL (0 Blocker, 0 Critical, 0 High, 2 Medium)

### MEDIUM-1 — the platform cap was hardcoded in a second place

The unbounded-configuration test asserted `callCount === 2`. That silently re-encodes `MAX_REASK_ATTEMPTS = 1` in a
test file. A deliberate change to the cap would fail this test with no pointer to what actually moved, and the two
values could drift apart while both looked intentional.

Now derived: `MAX_REASK_ATTEMPTS + 1`, and the exact-bound loop iterates `0..MAX_REASK_ATTEMPTS` rather than a
hand-written list.

### MEDIUM-2 — the CDR under-described its own deliverable

CDR-046 §3 listed six properties; the suite pinned seven. The seventh — **validation is opt-in**, so a call with no
schema ref is never failed as `invalid_output` — is a real guarantee that guards the *other* direction: a change
making validation unconditional would satisfy all six listed properties while breaking every free-text caller. Added
to §3 as item 7.

## Pass 2 — FAIL (0 Blocker, 0 Critical, 0 High, 1 Medium)

### MEDIUM-1 — the two request fixtures were written side by side, so they could drift

`request` and `freeTextRequest` each listed all six required fields. The opt-in test's entire meaning is that the two
differ in **exactly one** way — and written separately, nothing enforced that. A field added to one and not the other
would have left the test comparing two unrelated requests while still passing.

Now the free-text request is the base and the structured one is derived from it by adding the schema ref, which makes
"exactly one difference" structural rather than a convention someone has to maintain. (The key is *added* rather than
a copy having it set to `undefined`, because `exactOptionalPropertyTypes` treats those as different — which is the
setting doing its job.)

## The acceptance criterion is honestly HALF met, and says so

"Invalid output cannot complete a task" names task completion, which is driven by execution — **P5-002/P5-005, not
built**. There is no path today by which a model output completes a task.

- **Delivered (necessary condition):** the gateway never hands a caller an unvalidated or partially-validated value.
- **Not delivered (sufficient condition):** that a task cannot reach `completed` on one. That belongs to the
  coordinator ticket.

The backlog itself files this as "trust-critical #18 **groundwork**", and the traceability note says *groundwork*,
not *covered*. Claiming otherwise would be the hollow-success failure invariant 20 exists to prevent, applied to our
own backlog.

## Evidence

| Head | Run | Result |
| --- | --- | --- |
| `08e1018` (conformance suite) | 30239967474 | **1954 passed (1954)**, 0 skipped |
| final head (review fixes) | see PR #46 | recorded at merge |

Unlike every other ticket this session, this suite also runs **locally** — 7/7 in ~1s, no database — which is
precisely why its two drafting errors were caught before the first push.
