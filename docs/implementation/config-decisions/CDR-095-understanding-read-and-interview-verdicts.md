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

---

## 9. Adversarial review, and the four defects it found

Six independent lenses examined this change (authorization/metering, the `superseded` predicate, the widened
guard, the HTTP boundary, whether the new tests bite, and prose truthfulness). Every finding was then attacked by
a skeptic instructed to refute it and to default to refuted when uncertain.

**25 findings raised. 21 refuted. 4 survived** — and the fixes are in this branch.

Nothing that survived was a tenancy, privilege or cross-tenant defect. The authorize-then-debit invariant held,
the G9 null-carrying 200 held, the DTOs were named field by field, and no reviewer found a path by which one
tenant could reach another's data. What survived were two violations of this repository's own standing rules, one
spend-before-validate gap, and one guard-hardening item.

### 9.1 The money gate had no test that could fail (§the "guard coverage is the defect" rule)

`authorizeMeteredParticipate` — the member-level gate both new paid routes depend on — was never invoked by any
test. Every reference in a test file was a **stub**. Replacing its entire body with `return 'allowed';` left the
whole suite green, while an authenticated non-member could pass the gate and debit another company's paid-call
ceiling before core refused. That is the CDR-092 §15 drain with nothing able to catch it.

The gate was introduced in §2 of this document as the careful alternative to widening the owner-only set, and it
shipped with less test coverage than the thing it was careful about.

Fixed by mirroring the sibling's two suites. The integration half now asserts the claim the split was **made**
for and that had never been written down: **a viewer is ALLOWED `interview:participate`** (verified against
`authz.ts:289`, `['owner','viewer']`), while the same viewer is **forbidden** `strategy:generate` — the two
results asserted side by side, on the same caller and company, so the split is shown to have narrowed rather than
widened.

### 9.2 Four CSS custom properties that do not exist

`console.css` referenced `var(--danger)` and `var(--primary)`. The defined tokens are `--c-danger` and
`--c-primary`; every other rule in the file uses those names.

CSS fails silently. An unresolvable `var()` makes the whole declaration invalid at computed-value time, so
`border-left: 3px solid var(--danger)` does not lose its colour — it loses the **border**, because
`border-left-style` unsets to `none`. The confidence bar's `background` unset to transparent and rendered
nothing. Two `data-kind` tints collapsed to the same near-white. Meanwhile the comments directly above them
asserted that the tint distinguishes the states and that the bar repeats the number — so this was a prose defect
as well as a visual one.

**It shipped past a manual check I ran, and the check was wrong**: I grepped for `--danger:` as a substring,
which also matches `--c-danger:`, so an undefined token reported as defined. That is the same substring-matching
class of error as the `[companyId]` bracket trap already recorded in this repository.

Fixed, and the **class** is closed rather than the instance: `tools/check-css-tokens.mjs` now fails the static
gate when any `var()` without a fallback resolves to nothing. Nothing else in this repository reads CSS —
typecheck, lint, the secret scan and 4,930 tests all pass over a stylesheet whose colours do not exist, and jsdom
applies no stylesheet, so no rendered test could have caught it either. The checker was watched to fail on the
exact original defect before being trusted:

```
apps/web/src/app/console/console.css:1431
    var(--primary) resolves to nothing, so the whole declaration is invalid at computed-value time.
    A shorthand (border, background) loses more than its colour — it unsets the property.
    Did you mean: --c-primary?
```

Its own self-test asserts the substring bug directly: `--c-danger:` must NOT be read as defining `--danger`.

### 9.3 The paid route validated after it spent

`parseEvaluateAnswerBody` bounded `answerText` only by the 16 KiB body cap, never against `ANSWER_CONTENT_MAX`.
An over-long answer therefore passed every free check, consumed the per-company ceiling, was sent verbatim to the
provider, was **billed**, and was only then refused — by `createMemoryItem`, on `MEMORY_CONTENT_MAX`, and only on
a `clear` verdict. The same text could never have been stored as an answer either, so the model was being asked
to judge something the platform had already decided it would not keep. The console gates its own control on the
same constant, so this was reachable only from a non-console client.

Fixed in **core**, before the gateway call, rather than in the parser — `companies-http.ts`'s own header assigns
field validation to the domain, and a parser-level cap would have been a second definition of the bound. The rule
is **imported**: `validateAnswerSubmission` is the exact predicate `recordInterviewAnswer` applies to the same
text, so the two cannot drift.

The test asserts **the gateway is never called**, not merely that the result is `validation` — a bound placed
after the model call would satisfy the second and none of the point. A companion case asserts an answer exactly
at the limit is still evaluated, so the fix cannot silently narrow what a founder may say.

### 9.4 The widened guard could still be walked past — twice

Both escapes were **demonstrated**, not hypothesised, and both produced `code = 0, failures = 0` on trees that
should have failed. That is the worst output a guard can give: not a missed defect but an affirmative all-clear.

1. **`functionBody` ended a function at the first column-0 `}`.** Any template literal supplies one the moment it
   contains a JSON-shaped prompt — which is the likeliest shape in a function that talks to a model. The paid
   call then fell outside the extracted body and the paid-method rule found nothing to complain about.
2. **The paid-method sweep enumerated only `*ForRequest` names.** A one-word rename removed a money-spending
   function from the only rule that does not depend on a naming convention.

Fixed with a brace-matching scanner that skips string and template literals (including nested `${}`
substitutions), a `topLevelFunctionNames` sweep that ignores the naming convention entirely, and by making an
unreadable function a **failure** rather than the bare `continue` it was — "could not check" reported as "fine",
in the exact rule that catches renamed money routes.

⚠️ **The first fix was itself wrong and CI-adjacent testing caught it.** Matching the first `{` picked up the
brace inside a *return type* — `Promise<{ userId: string; ... } | Early>` — yielding a two-line body in which
every needle was missing, and producing **26 false failures** against the real repository. The extractor now uses
both signals: brace matching for correctness inside literals, and a column-0 closing brace to identify which
opening brace begins the body. All four cases are pinned as regression tests.

### 9.5 What the review says is still unproven

Recorded here rather than left to be rediscovered:

- **No `route.ts` handler in this application has any test.** Zero test files under `apps/web/src` import a route
  module. For the three new routes that means the query-parameter guards, the 413 path, `maxDuration`, and the
  `context.params` binding are unexercised — including a guard with no failing test, by this repo's own rule.
- **The FE-008 wiring is untested**; only its pure helpers are. `interview-panel.tsx` has no test file, so the
  two paid `fetch` calls, the re-entrancy guards and the control gating are reachable only in a real browser.
- **No live provider has ever run from this repository**, so every claim about actual verdicts is asserted rather
  than measured — including the documented fail-open that returns `clear` on a gateway *error*, which is
  indistinguishable on the wire from a real `clear`.
- **`toDocumentDTO` reuse is unasserted**: no test compares the read path's output against the generate path's
  for the same row, which is the reuse the export was made for.

### 9.6 The open product question the review surfaced

**"Check this answer" is a write, and it is repeatable.** On a `clear` verdict, `evaluateAnswer` creates a
`user_fact` memory item — before, and independently of, the founder pressing "Save answer". `memory_items` has no
uniqueness on `source_ref`, and the control re-enables as soon as the request settles. A founder who checks, edits
the wording, checks again, then saves can leave several `user_fact` rows for one question, none superseding the
others, all feeding the understanding document FE-009 renders.

The mechanism is pre-existing P2-005 code. What is new is that this branch is the first thing to make it
reachable and to put a button on it. **This is an owner decision, not an engineering one**, and it is flagged
rather than changed: the button's copy already says the answer was recorded, but "Check this answer" reads like a
dry run and it is not one.
