# CDR-032 — Context assembly (ACBP-P2-007)

**Status:** Accepted for the contracts slice (autonomous lead, standing Phase 2 authorization). **Requirements:**
MEM-004 (instruction precedence), NFR-021 (AI threat model / rules), NFR-018 (secret hygiene / zero-findings posture),
Invariant 12 (a seeded secret never reaches the prompt). **Governing ADRs:** ADR-011 (gateway contract), ADR-012
(worker/tool boundaries). **Architecture:** AI-AND-WORKER-ARCHITECTURE §1 (context assembly). **Depends on:** P2-006
(typed memory, Done) + P2-003 (gateway, Done). **No owner gate; no live model** (context assembly BUILDS the
`contextParts[]` the gateway later receives opaquely — it never itself calls a model), the P2-004 shape precedent.

Assemble model context from the company's typed memory (AI-AND-WORKER §1): **provenance-ranked** (confirmed user items
> accepted assumptions > research findings), with the **secret blocklist** (invariant 12 / NFR-018) enforced as
defense-in-depth, and **MEM-004 instruction precedence** (a confirmed user item outranks an AI assumption; a conflict
emits a question, never a silent memory override).

## 1. Provenance ranking (AI-AND-WORKER §1)

Memory items are ordered into the prompt by a **provenance tier**, then by confidence (desc) then recency (desc):
1. **Confirmed user items** (highest authority) — `user_fact` · `user_preference` · `constraint` ·
   `approved_decision` · `measured_outcome` · `correction`, in `confirmation_state` `accepted`/`validated` (or
   user-stated types regardless of state — they are founder-authoritative by MEM-001's type-by-source rule).
2. **Accepted assumptions** — `ai_assumption` in `accepted`/`validated`.
3. **Research findings** — `research_finding`.
`proposed` items are included at the tail of their tier (surfaced but lowest); **`invalidated` items are excluded**
(never fed to the model). The ranking is a PURE function over the typed `MemoryItemDTO` (type + confirmation_state +
confidence + createdAt) — no provider, no DB.

## 2. Secret blocklist — invariant 12 / NFR-018 (trust-critical, defense-in-depth)

Memory is founder-stated *business* content, so a secret should never be there in the first place — but the assembler
is the last gate before the model, so it enforces a **fail-closed blocklist**: any content span matching a secret
pattern is **redacted** to a fixed placeholder (`[REDACTED_SECRET]`) before the item is placed into context; the raw
secret value is NEVER emitted. The closed pattern set (extensible; conservative, low false-positive shapes):
- PEM private keys — `-----BEGIN ... PRIVATE KEY-----` blocks.
- Provider key/token prefixes — OpenAI `sk-`/`sk-proj-`, Anthropic `sk-ant-`, AWS `AKIA…`, GitHub `ghp_`/`gho_`/
  `ghs_`/`ghr_`, Google `AIza…`, Slack `xox[baprs]-…`, Stripe `sk_live_`/`rk_live_`.
- `Authorization: Bearer <token>` / `Basic <base64>` header values.
- Connection strings embedding credentials — `scheme://user:password@host…` (postgres/mysql/mongodb/redis/amqp/…).
- Long high-entropy tokens — a bounded catch-all for ≥32-char base64url/hex runs that look like credentials
  (tuned conservatively to avoid redacting ordinary business text; a matched run is redacted, the rest kept).
The matcher is a PURE function; it redacts spans, never drops silently without a marker, and is unit-tested against a
seeded-secret corpus (each pattern) AND a benign-business-text corpus (no false positives on ordinary content).

**Independent security review (hardened):** the PEM pattern was made **ReDoS-safe** (the body is bounded, not `*?`, so
a `BEGIN` with no `END` fails in O(bound) instead of scanning to EOF) and **fail-closed on a truncated key** (a
BEGIN-anchored fallback redacts the base64 body even when the `END` line is missing/mangled). JWT, `key=value`
credential-assignment, SendGrid, and npm shapes were added. **Documented residual gaps (defense-in-depth only — a
secret should never be in business memory):** a raw AWS *secret* access key (a plain 40-char base64 with `+`/`/`),
sub-40-char or all-lowercase generic tokens, and line-wrapped/whitespace-split tokens can still bypass; the layer is a
last-gate backstop, NOT the primary secret control (that is ADR-014/021 vault isolation + NFR-018 scanning). The
high-entropy catch-all can over-redact a ≥40-char mixed-case+digit business identifier (rare; the failure direction is
safe — content masked, never leaked). These are enumerated so downstream consumers do not over-trust the layer.

## 3. MEM-004 instruction precedence + conflict (DATA-ARCHITECTURE §3)

Confirmed user items rank above AI assumptions (§1). On a **conflict** — a confirmed user item and an `ai_assumption`
that address the same subject with contradictory content — the assembler **surfaces a question** (a
`context.conflict` signal the caller turns into a question event) rather than silently preferring memory. **Conflict
DETECTION semantics are the follow-up core slice** (below): robust same-subject/contradiction detection is genuinely
under-specified in canon (it needs either structured topics or a model judgement), so it is designed + implemented
with care in the core use case, not rushed into the pure contracts. The precedence *ordering* itself is in §1.

## 4. Slice plan (trust-critical — sliced so the security-critical pure logic ships first, reviewed)

1. **Contracts** (this slice): the PURE, provider-neutral logic — provenance ranking (`rankMemoryForContext`) + the
   secret blocklist (`redactSecrets` / `containsSecret` + the closed `SECRET_PATTERNS`) + the assembled-context DTO
   shape. Unit-tested (seeded-secret corpus per pattern; benign-text no-false-positive corpus; ranking order). This
   CDR.
2. **Core** (follow-up): `assembleContext` — reads the company-scoped typed memory (its own `memory:read` scope) +
   the current understanding version, ranks + redacts, detects MEM-004 conflicts → emits `context.conflict`
   question signals, returns the bounded `contextParts[]` for the gateway. Real-PG integration (seeded secret
   blocked end-to-end; seeded conflict surfaces a question; precedence proven; cross-company isolation). Independent
   **security review** (trust-critical). Then finalization.

## 5. Out of scope / deferred

The model call (the gateway, P2-003 — consumes `contextParts[]` opaquely); the HTTP surface + live provider (CDR-026
§0); the Research worker that produces `research_finding`s (P5); worker task-input context (M4/M5). No migration, no new
authz action (reuses `memory:read`), no new audit event in the contracts slice.
