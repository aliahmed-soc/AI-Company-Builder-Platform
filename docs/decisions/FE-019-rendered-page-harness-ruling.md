# ACBP-FE-019 — Ruling: does the rendered-page harness join CI?

**Status: RULING DELIVERED. The row is NOT Done — the ruling is a qualified yes, and a yes obliges wiring
that this ticket does not contain.**

**Ruling in one line:** yes to a harness that tests *behaviour*, no (for now) to one that measures *layout* —
and the row's own acceptance demo belongs to the second, so it cannot be the acceptance test for the first.

---

## 1. The measured gap

| Fact | Value | How it was established |
|---|---|---|
| Rendering harnesses installed | **none** | scanned all 14 `package.json`: no `jsdom`, `happy-dom`, `@testing-library/*`, `playwright`, `puppeteer`, `@vitejs/plugin-react` |
| `.test.tsx` files in the repository | **0** | recursive scan excluding `node_modules` |
| vitest environment | **`node`** | `vitest.config.ts` |
| `.tsx` files under `apps/web/src` | **40** | recursive scan |
| Lines of JSX with no test touching them | **4,782** | same scan |

Every screen this console has ever shipped has had its markup, its ARIA wiring, its conditional rendering and
its CSS assertions verified by reading, and by nothing else.

## 2. What the session's own defect record says

Six frontend tickets were reviewed adversarially this session, each finding independently verified by a
separate agent instructed to refute it: **21, 42, 35, 13, 27 and 15 confirmed defects**, all in work that had
already passed a full local gate and green CI.

Sorting the severe ones by *what would have caught them* is the whole decision:

**A rendering harness WOULD have caught:**

- ACBP-FE-013's **BLOCKER** — the harden control rendered only while no decision existed, so a newer selection
  could never be hardened. This is a conditional-render defect: "given a decision AND a newer selection, the
  control is present" is one render assertion.
- ACBP-FE-016's `role="region"` per card (fifty landmarks), the unconditional `tabIndex`, and the textareas
  that shipped without `cs-input` and rendered as unstyled UA controls.
- ACBP-FE-003's dark ground painting as a **640px stripe**, and `cs-item-*` spans laying out in a row inside a
  flex parent instead of stacking.

**A rendering harness would NOT have caught — and these were the worst:**

- ACBP-FE-016 **BLOCKER 1**, the invented risk vocabulary. Every row rendered *consistently*; it was
  consistently wrong. A render test asserting "this row shows its risk badge" passes.
- ACBP-FE-016 **BLOCKER 2**, a permanent warning that contradicted the server. No harness judges whether a
  sentence is true.
- ACBP-FE-016 **BLOCKER 3**, a page size of 50 presented as an inbox size. The number rendered correctly.
- ACBP-FE-013's `planningUnlocked` asserting a gate outcome the read cannot determine.

**The finding that matters: the three worst defects of the session were in code that WAS tested. The tests were
wrong about their inputs, not absent.** FE-016's suite fed `'high'` and `'low'` — values the CHECK constraint
forbids — so the only tests of the mapping exercised inputs the system cannot produce. No amount of rendering
would have helped. What helped, once applied, was cheaper and is already in place:

- fixtures **driven from the contract's own constant arrays**, so an impossible value cannot be fed;
- a **contract-alignment test** that assigns the real DTO to the local shape, so a hand-written body cannot
  drift;
- mirrored server constants **asserted equal** to the value the server actually applies.

Those three closed the blocker class. A harness closes a different, real, lesser class.

## 3. Why the row's acceptance demo settles the scope question

The row requires: *"the wiring commit must also demonstrate a RED run against a seeded regression (a
reintroduced horizontal overflow)."*

**A horizontal overflow cannot be measured by a DOM harness.** jsdom implements no layout engine —
`offsetWidth`, `scrollWidth` and `getBoundingClientRect()` return zeros — which is documented behaviour and the
reason its own guidance directs layout-dependent assertions to a real browser. (Stated as the documented
property it is: jsdom is not installed here, so this is not a measurement taken in this repository.)

So the row silently asks for **two different harnesses**:

| | catches | cost |
|---|---|---|
| **DOM harness** (jsdom + testing-library) | conditional rendering, ARIA wiring, which control is present, class application | one dev dependency set, `environment: 'jsdom'` per-file, no binaries |
| **Browser harness** (playwright/puppeteer) | overflow, computed styles, contrast, focus order, screenshots | browser binaries in CI, minutes of runtime, a real flake surface |

The overflow demo belongs to the second. Adopting the first and then demonstrating RED against an overflow is
not possible; a commit claiming it would be the kind of unfalsifiable evidence this programme keeps removing.

**And a known trap for whoever wires the second:** headless Chrome reports `prefers-reduced-motion: reduce`
*by default*, so an unset "normal" run tests the reduced condition twice and matches for the wrong reason.
Both media states must be forced explicitly.

## 4. The ruling

**YES to a DOM behaviour harness.** 4,782 lines of untested JSX and a confirmed BLOCKER of exactly the shape it
catches is sufficient evidence. The acceptance demo for that wiring must be a seeded **behavioural** regression
— the FE-013 shape is the right one: remove the `decisionCoversLatestSelection` condition and assert the harden
control disappears, proving RED before the fix restores it.

**NOT YET to a browser harness.** The class it uniquely catches is real but was, this session, one visual
defect out of six reviews, and the cost is browser binaries plus a flake surface in a CI run that is currently
deterministic at 305 files / 4,615 tests with zero skips. **Named trigger:** adopt it when either (a) a second
layout defect reaches `main`, or (b) any screen ships a chart, a canvas, or a virtualised list — all three
being things no DOM harness can check at all.

**ORDER OF WORK, and this is the part the evidence is loudest about:** the fixture and alignment disciplines in
§2 outrank both harnesses. They are already applied on FE-015 and FE-016 and cost nothing per ticket.

## 5. Why this row is NOT Done

The ruling is a qualified yes, and the row states that a yes obliges a wiring commit that demonstrates RED.
This ticket delivers the ruling and **not** the wiring. Marking the row Done would claim a guard that does not
exist — which is, precisely, the defect class every entry above is about.

**Owed:** the DOM harness wiring, with a RED run against a seeded behavioural regression.
