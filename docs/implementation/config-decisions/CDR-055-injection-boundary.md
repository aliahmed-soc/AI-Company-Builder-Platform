# CDR-055 — The injection boundary: untrusted content cannot invoke tools (ACBP-P5-003c)

**Status:** proposed · **Ticket:** ACBP-P5-003c · **Requirements:** NFR-021 · **ADR:** 011, 012, 019 · **Trust-critical:** #17 · **Invariant:** 17 · **Depends on:** ACBP-P5-003b (the dispatcher chokepoint)

| | |
| --- | --- |
| In scope | The trust classification of content; the wrapper that makes instructions inert; injection detection and its signals; **heightened scrutiny at the dispatcher**; the injection corpus |
| Out of scope | Anything that FETCHES external content (P5-006's research worker — nothing in the platform fetches any today); the quarantine STORE and the task flag, which belong with the component that acquires the content; the policy engine that will supply real heightened-scrutiny answers (Phase 6) |

## 0. What canon settles

`AI-AND-WORKER-ARCHITECTURE §4` is unusually specific, and it decides almost everything here:

| Content class | Trust | Rules |
| --- | --- | --- |
| Authenticated user input | Trusted-as-input | May steer work; still schema-validated; cannot bypass policy chain |
| External web content (research) | **Untrusted** | Wrapped as data with provenance; instructions within it are **inert**; **heightened policy scrutiny** on any tool call proposed while processing it |
| Uploaded files / integration content (future) | Untrusted | Same |
| Generated documents | Semi-trusted | Own provenance; never auto-promoted to fact |
| Tool output | Per-tool class | Structured; validated against the tool's output schema |

> **Hard rule (invariant 17):** *tool calls originate exclusively from worker control flow evaluated against the policy chain — never from instructions parsed out of processed content. Suspected injection ⇒ content quarantined, task flagged, `policy.blocked`-class event emitted.*

NFR-021's acceptance is a measurable one: *"Injection test corpus (instructions embedded in researched web content) produces **zero unauthorized tool executions**."*

## 1. The decision that carries the ticket

**"Heightened policy scrutiny" has exactly one honest meaning in Phase 5: the informational waiver does not apply.**

`CDR-054 §0` established that with no policy engine, `informational` proceeds and everything above it is refused — canon's own Phase 5 envelope. Canon *also* says a call proposed while processing untrusted content faces heightened scrutiny. Heightened relative to the normal path can only mean *more* refusal, never less, so:

> While untrusted content is in the working context, **the waiver is withdrawn**. Every class — including `informational` — needs a real policy answer, and in Phase 5 there is none, so every such call is refused with `untrusted_context`.

That is what makes *"zero unauthorized tool executions"* a structural property rather than a hope: it does not depend on detecting the injection at all. A corpus entry that no detector recognises still cannot cause a tool call, because the *provenance of the context* — not the cleverness of the text — is what closes the gate.

Detection then serves the second half of the requirement (quarantine and flagging), not the first.

## 2. Guarantees

- **G1 — instructions inside untrusted content are INERT because they are never in an instruction position.** `wrapUntrusted` produces a value that carries content plus provenance and is only ever rendered into a data slot. It is not sanitisation, and deliberately so: sanitisation is a filter that can be evaded, whereas a value that never reaches an instruction position has nothing to evade.
- **G2 — a tool call proposed under untrusted provenance is refused in Phase 5, whatever its class.** §1's reading. `untrusted_context` joins the closed denial set, and — like every other refusal — it is RECORDED (TOOL-002).
- **G3 — the refusal does not depend on detection.** Provenance closes the gate. A corpus entry that defeats every signal still produces zero executions.
- **G4 — detection is HONEST about being a heuristic.** `detectInjection` returns the signals it matched, never a bare boolean verdict, and never claims content is clean — only that it matched nothing known. An absent signal is not evidence of safety, and the API says so.
- **G5 — the corpus is a real corpus, driven end to end.** Entries go through the actual dispatcher against a real database, and the assertion is on the `tool_calls` table: zero rows with an authorized outcome. Asserting on a mock would prove the mock.
- **G6 — nothing is quarantined that nothing fetched.** No component acquires external content yet (the research worker is P5-006). The quarantine STORE and the task flag are therefore sequenced with the acquirer; this ticket delivers the boundary the acquirer must pass through, plus the detection it will use. Building a store for content that cannot exist would be a table with no writer and a guarantee with no proof.

## 3. Shape

| Element | Shape |
| --- | --- |
| `CONTENT_TRUST` | CLOSED, from canon's own table: `trusted_user_input · untrusted_external · semi_trusted_generated · tool_output`. |
| `UntrustedContent` | `{ trust, content, provenance }` — a value, not a string. Produced by `wrapUntrusted`. |
| `detectInjection` | `(content) => { signals: readonly InjectionSignal[] }`. Signals are a CLOSED set; an empty array means "matched nothing known", not "safe". |
| `untrusted_context` | A new `TOOL_DENIAL_REASON`, recorded like any other. |
| dispatcher | An optional `contextTrust` input. `untrusted_external` present ⇒ the informational waiver is withdrawn. |

## 4. Slice plan

1. CDR-055 + branch + draft PR.
2. Contracts: trust classes, `wrapUntrusted`, `detectInjection`, the new denial reason — TDD, pure.
3. Dispatcher integration: withdraw the waiver under untrusted provenance; migration for the new denial value.
4. The injection corpus, driven through the real dispatcher against real PostgreSQL.
5. Docs + **TWO** independent review passes + finalization.

## 5. Review outcomes (both passes FAILED; see `docs/implementation/P5-003c-REVIEW.md`)

- **G7 — the context parameter is REQUIRED.** Optional, a FORGOTTEN context defaulted to the trusted path, and this
  is the one input where being wrong means untrusted content reached a tool. A caller with genuinely no context passes
  `[]` — a decision rather than an omission that looks identical to one.
- **G8 — detection runs on the LIVE path and records its signals.** It still decides nothing, but a refusal that names
  which signals matched is the difference between a log line and something a human can act on — NFR-021's second half.
  Signals only, never content; the key is ABSENT rather than empty when nothing matched, because `''` would have to
  be read as either "none matched" or "not checked".
- **G9 — TOOL OUTPUT IS NOT TRUSTED.** The pass-2 finding, and a complete bypass: a web-fetching tool's output
  re-entering the context as `tool_output` would have read as trusted and put the injected instructions back inside
  the boundary. Canon says **"per-tool class"** — the tool decides — and a per-tool mapping needs P5-004's registry, so
  until then the only safe reading is *not automatically trusted*. `TRUSTED_INPUT` is exactly
  `['trusted_user_input']`.

### A deliberate deviation: this module is STRICTER than canon's table

Canon attaches heightened scrutiny only to *"External web content"*. Here **every** class except
`trusted_user_input` withdraws the waiver — including `tool_output` and `semi_trusted_generated`. That is a
conscious over-restriction in the safe direction while no per-tool trust mapping exists, and it costs nothing today
because nothing in the platform fetches external content yet. Recorded here so a future reader sees a decision rather
than a bug, and so P5-004 knows it inherits the question.