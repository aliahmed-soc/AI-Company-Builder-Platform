# CDR-095 — The understanding read, the metered interview pair, and the two screens they unblocked

**Tickets:** ACBP-API-013 (backend), ACBP-FE-008, ACBP-FE-009
**Branch:** `p8-api-013-understanding-and-verdict`
**Date:** 2026-08-19
**Status:** built; awaiting the owner gate. **No row is set to `Done` by this record.**

---

## 1. What this closes, and why the two halves are not the same kind of change

`ACBP-FE-008` and `ACBP-FE-009` both sat as `Blocked-API`. They were blocked for
*different reasons*, and conflating them would have produced the wrong ticket.

| Row | What was missing | Kind of change |
|---|---|---|
| FE-008 | Nothing in the domain. `evaluateAnswer` and `suggestAssumptionForSkip` already existed as exported `@acbp/core` use cases; no HTTP route reached them. | **Exposure** |
| FE-009 | The read itself. The understanding module shipped four *writes* plus the strategy-unlock gate and nothing that returned the document. | **Domain addition** |

The FE-009 half is the shape that was **refused** three tickets ago: `listHeldWork`
on ACBP-API-011 (CDR-094 §3.2) was declined precisely because adding a read core
does not have is a domain addition rather than exposure. The owner ruled the other
way here, explicitly, on 2026-08-19. That difference is recorded in
`understanding-read.ts` itself, not only here, because the precedent otherwise
reads as contradicted by whoever finds the file first.

## 2. The judgement call: a MEMBER-level metered gate

`authorizeMeteredGenerate` is closed to four **owner-only** actions. `evaluateAnswer`
authorizes against no action of its own — it inherits `interview:read` and
`memory:write`, both `['owner','viewer']`.

Two options were available and both were wrong in the obvious form:

- Route the interview pair through `authorizeMeteredGenerate` → every **viewer** is
  refused mid-interview, for a call their own permissions allow.
- Add the interview actions to `METERED_GENERATE_ACTIONS` → silently grants viewers
  the four owner-only *generate* actions in order to make two interview routes work.
  This was the cheaper edit and would have been a privilege escalation.

A sibling `authorizeMeteredParticipate` was added instead, reusing the existing
`interview:participate` action. **CDR-092 §15's guarantee is unchanged and now holds
on both paths: authorize, then debit.** Nothing was invented; the split is by
posture, not by rule.

## 3. `superseded` — the fact `confirmed` cannot express

ACBP-FE-009's acceptance says *"the UI shows a stale document as stale"*. The read
as first written could not support that sentence.

`isVersionConfirmed` answers one question — may planning proceed — and returns
`false` for two states a founder must be able to tell apart:

1. an understanding nobody has confirmed yet, and
2. one that **was** confirmed until a correction superseded it (DISC-008).

A screen given only that boolean tells the second founder to confirm something they
already confirmed, and hides the fact that their correction landed.
`isVersionSuperseded` now sits beside the gate in `@acbp/contracts`, folding the
same closed event vocabulary. It is deliberately **not** the negation of the gate,
and a test asserts the two are never both true.

### 3.1 "Stale" means two things, and only one of them is reported

This is the distinction most likely to be lost by a future reader, so it is written
down twice — here and in the file.

- **Reported — DISC-008 supersession.** Folded from events the read already loads.
- **REFUSED — generation staleness.** Whether a *pinned generation* is running
  against a moved understanding already has an authority: the generate paths refuse
  with `stale_understanding` (`strategy-generation.ts`). A second, independently
  derived copy here is the duplicate authority CDR-087 §1 exists to prevent, and the
  read's copy would be the one no test of the generate path covers.

The file's header comment previously claimed the read computed *no* staleness at
all. That was true when written and false the moment `superseded` landed; it now
names which notion is reported and which is refused.

## 4. Deliberate omissions — decided, not overlooked

- **No review or confirm route.** `recordUnderstandingReview`, `confirmUnderstanding`
  and `correctUnderstanding` exist in `@acbp/core` and reach no HTTP route. FE-009's
  accessibility line asks that *"edit, reject and request-evidence controls have
  accessible names"*; a control that cannot reach the server has no accessible name
  worth giving, so **the screen names the gap instead of rendering inert buttons**,
  and a rendered test asserts zero `<button>` elements exist so the gap cannot
  quietly fill with decoration.
- **No version selector on the understanding route.** It answers *"what does the
  platform currently understand"*. An unsupported query parameter is refused rather
  than ignored, on the approvals-inbox rule.
- **`evaluate` does not accept a session id.** The session is resolved from the
  company's open interview; a caller-supplied one would be a second, forgeable
  source for a fact the server owns.

## 5. The metered-route checker was widened, because it passed for the wrong reason

`check-generate-route-coverage.mjs` classifies metered routes by directory name
(`generate` / `recommend`). Neither `evaluate` nor `assumption` is named `generate`,
so **the checker reported success over two new money-spending routes it could not
see** — the exact escape its own header warns about ("a paid route at `brief/compose`
was never examined at all").

Three changes, in increasing order of how much they matter:

1. The two directory names and the two route paths were added, floor raised 4 → 6.
2. Both paid runtime methods joined `METERED_RUNTIME_METHODS` — **the rule that
   survives a rename**, and the one that would have caught this without (1).
3. The single `METERED_HELPER` became a set, each helper carrying its own
   authorization needle, with the same ceiling requirements and the same
   authorize-before-debit ordering check applied to every member.

A widened guard with no test that it can fail is not a guard. Three cases were added
that watch the **member-level** ceiling fail: a vanished helper, one that stopped
authorizing, and one that debits before it authorizes. A vanished helper is a
FAILURE rather than a skip — a `continue` there would mean deleting a helper also
deletes the only thing checking it.

## 6. What CI caught that local runs structurally could not

Local PostgreSQL is unreachable from Windows on this machine (the Hyper-V firewall
blocks the WSL address; opening it is a system-security change and an owner action).
Every real-PostgreSQL suite therefore **skips** locally — 1,704 tests. A skip is not
a pass, and this ticket is the demonstration.

Hosted CI ran at **zero skips** and went red:

```
error: new row for relation "understanding_items"
violates check constraint "understanding_items_class_valid"
```

The new integration fixture seeded an item class of `risk`. There is no such class —
the closed six live in `UNDERSTANDING_CLASSES` and are CHECK-constrained by migration
0019. All eight tests in the file failed in `beforeEach`, which is the
fixture-threw signature: none of them tested anything.

**The fix is not the swapped string.** `seedDocument` now types its class parameter
as `UnderstandingClass`, so an invented class is a *compile* error rather than eight
runtime failures whose real cause is one line up in the setup. Tenant B's classes
were also changed to ones tenant A has none of, so the cross-tenant invisibility
proof is assertable by class as well as by content.

### 6.1 The same trap, found twice more

`UnderstandingSectionDTO` widens **both** `class` and `status` to `string`. The view
narrows each defensively rather than asserting a guarantee the type does not make:

- an unrecognised **class** is counted and reported to the founder, never rendered
  under an invented heading and never silently dropped;
- an unrecognised **status** falls back to `unknown`, never to a confident reading.

Both have tests. The count is surfaced on screen specifically so the document cannot
appear shorter than it is without saying so.

## 7. What is proven, and what is only wired

Stated plainly, because the difference is the whole point of the evidence standard.

| Claim | Status |
|---|---|
| Cross-tenant invisibility of the understanding read | **Proven** — seeded tenant-B content, asserted against the serialised result |
| Authorize-before-debit on the member-level gate | **Proven** — behavioural test plus the widened source checker |
| Each verdict carries only its own payload | **Proven** |
| `superseded` distinguishes the two `confirmed: false` states | **Proven** — unit, wire, rendered, and end-to-end against real recorded events |
| No client-side answer scoring | **Proven** by construction and asserted |
| Assumption legible without colour | **Proven** — a test strips every `class` attribute and asserts the meaning survives |
| **"Document width capped for reading"** | ⚠️ **WIRED, NOT PROVEN.** jsdom has no layout engine, so the test asserts `cs-doc` is present. That is a wiring check, not a width measurement. The CSS cap is real (`max-width: 68ch`) but nothing here measures it. |
| **"Stacks under the question"** | ⚠️ **WIRED, NOT PROVEN**, for the same reason — DOM order is asserted, not layout. |

## 8. Not done, and not to be assumed done

- No backlog row is set to `Done`. That is an owner gate.
- No PR has been marked ready and nothing has been merged.
- The two rendered rows still depend on a browser-based check for their layout
  acceptance lines; §7 records them as unproven rather than counting the jsdom
  assertions as evidence.
