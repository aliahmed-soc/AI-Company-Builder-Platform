# ACBP-P5-003c — independent review record

Two full independent passes. **Both returned FAIL.** Design consequences are recorded in `CDR-055`.

Hosted CI on `de3e599` ran the corpus green on its first attempt, zero skips (2290/2290). Both passes found things a
green corpus could not, and pass 2 found a complete bypass of the boundary the corpus was measuring.

---

## Pass 1 — the seams around the boundary

Neither finding says the boundary was wrong. Both say it was **easier to get wrong than it needed to be.**

### HIGH-1 — a forgotten context defaulted to the trusted path

`context` was optional. A worker that processes untrusted content and simply *forgets* to pass it gets the trusted
path — and this is the one input where being wrong means untrusted content reached a tool. An omission looked
identical to a deliberate "there is no context".

**Fix.** The parameter is REQUIRED. A caller with genuinely no context passes `[]`, which is a decision. The compiler
found all fifteen call sites, which is exactly what should happen.

### MEDIUM-1 — the detector shipped without being called

`detectInjection` was exported, tested, and invoked by nothing in the shipping path; it would have sat unused until
P5-006 picked it up, which is how a security helper rots.

**Fix.** It runs on the live path now. It still decides nothing — provenance closed the gate before it is consulted —
but a refusal that names *which* signals the content matched is the difference between a log line and something a
human can act on, which is NFR-021's second half (*"quarantines the content and flags the task"*). Signals go into the
audit payload as a comma-joined closed vocabulary, never the content, and the key is **absent** rather than empty when
nothing matched: `''` would have to be read as either "none matched" or "not checked", and those are different facts.

---

## Pass 2 — the classification itself, against the fixed tree

### HIGH-2 — `tool_output` was trusted, which laundered injected content straight back inside

The finding that mattered. `TRUSTED_INPUT` listed `tool_output` alongside `trusted_user_input`. That is a complete
bypass of the boundary this sub-scope exists to build:

1. a `web_research` tool fetches a page;
2. its output enters the working context labelled `tool_output`;
3. the label reads as **trusted**;
4. the informational waiver is not withdrawn;
5. the injected instructions are back inside the boundary they were supposed to be outside of.

**Every corpus test still passed**, because the corpus wraps its content with `wrapUntrusted`. The hole was one label
away and nothing exercised it.

**Canon never called tool output trusted.** `AI-AND-WORKER-ARCHITECTURE §4` says **"per-tool class"** — the *tool*
decides — and a web-fetching tool's output is external content wearing a different hat. A per-tool trust mapping needs
the worker/tool registry of P5-004, so until then the only safe reading of "per-tool" is *"not automatically
trusted"*. I had turned an unresolved question into a permissive default, which is precisely the mistake the
fail-closed rule exists to prevent — and I had done it while writing the module whose subject is that mistake.

**Fix.** `TRUSTED_INPUT` is exactly `['trusted_user_input']`. `semi_trusted_generated` stays out for the adjacent
reason: canon says generated documents are *"never auto-promoted to fact"*, and a model's own earlier output is how an
injection would persist across steps. Proven at both levels — a contract test naming the laundering path, and a
real-database test that puts injected content into the context as `tool_output` and as `semi_trusted_generated` and
asserts both are refused.

### Noted as a deliberate deviation, not a defect

This module is **stricter than canon's table**. Canon attaches heightened scrutiny only to "External web content";
here every class except `trusted_user_input` withdraws the waiver. That is a conscious over-restriction in the safe
direction while no per-tool trust mapping exists, and it costs nothing today because nothing in the platform fetches
external content yet. It is recorded in `CDR-055 §5` so a future reader sees a decision rather than a bug.

### Found clean

The withdrawal applying only to the waiver and not to permission (an explicit policy `allow` still authorizes, because
the waiver only ever stood in for a missing answer); `untrusted_context` naming exactly the calls that *would* have
proceeded, while a class that was already refused keeps its own reason; the earlier gates keeping their reasons under
untrusted context; `wrapUntrusted` deliberately not sanitising; and `detectInjection`'s return shape having no `safe`
or `clean` field, so the claim the heuristic cannot support is not spellable.
