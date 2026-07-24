# AI and Worker Architecture

Status: Proposed. Governs WORK-001…006, TOOL-001…003, DISC/UNDER/STRAT generation paths, NFR-019/021. ADRs: ADR-011 (gateway contract), ADR-012 (worker/tool boundaries). Diagrams: `diagrams/07`, `09`.

## 1. Component chain

`Context assembly → prompt/template registry → model gateway → structured-output validation → output validation (domain) → artifact persistence → usage/cost recording → human feedback → revision flow`

- **Context assembly:** builds model context from typed memory items (provenance-ranked: confirmed user items > accepted assumptions > research findings), understanding version, task inputs. Enforces the secret blocklist (invariant 12) and MEM-004 precedence (conflicts emit questions, never silent memory override).
- **Prompt/template registry:** versioned templates per worker capability + task type; template version recorded on every call (with model version) for artifact attribution.
- **Structured-output validation:** every model response validates against the task's declared schema; invalid output → bounded re-ask → normalized failure (never partial silent acceptance).
- **Output validation (domain):** post-schema checks — e.g., STRAT-001 similarity check, citation presence for research (WORK-002), field-completeness for the 16-field option standard (STRAT-002).
- **Human feedback / revision:** usefulness ratings (J-12) stored against artifact + worker version; revisions (J-13) create lineage-linked new runs.

## 2. Worker definitions (ADR-012)

Workers are **versioned configuration + prompts over one shared execution runtime** — not independent agent services (PRD §20; C-04 discipline: the reference product proved capability areas, not agents).

| Field | Content |
|---|---|
| Worker ID / version | e.g., `research@1` |
| Capability | declared task types it may accept |
| Allowed tools | explicit allowlist (WORK-005; deny-by-default, invariant 4) |
| Required input schema | task-type input contract |
| Output schema | artifact contract (validated) |
| Max execution budget | model-spend cap per run (NFR-015; POL-001 interplay) |
| Max duration | wall-clock bound; overrun → safe-stop → failed(`timeout`) |
| Retry eligibility | which failure categories auto-retry (TASK-010) |
| Approval profile | which of its tool calls are approval-gated by risk class |
| Model profile | which gateway task-class config it uses (primary; fallback eligibility) |
| Logging policy | redaction class for its prompts/outputs |

### Initial workers (MVP)

| Worker | Contract |
|---|---|
| **Research worker** | Input: research question + scope + understanding version. Tools: `web_research` (read-only, informational class), `memory_read`, `artifact_write`. Output: evidence-backed research document; every claim carries source ref or explicit `unverified` label (WORK-002). Task types: market research, competitor research, customer-segment analysis. |
| **Strategy worker** | Input: confirmed understanding version (+ research artifacts). Tools: `memory_read`, `artifact_write`. Output: ≥3 distinct 16-field options (STRAT-002) or business-model comparison; similarity check enforced downstream. Task types: business-model comparison, strategic-option generation. |
| **Document worker** | Input: approved context refs (understanding, decision, research artifacts). Tools: `memory_read`, `artifact_write`. Output: structured editable documents with provenance. Task types: business-plan generation, landing-page copy, internal product requirements. |

All three run **informational / internal-reversible risk classes only** — no MVP worker has any external-effect tool in its allowlist (the MVP's zero-external-actions boundary is thus structural, not procedural).

## 3. Model gateway (ADR-011 — the internal contract)

Per accepted ADR-004: provider-neutral internal module; **one primary + one fallback model; no dynamic routing**; internal boundary, not a product.

| Element | Contract |
|---|---|
| Request (stable) | `{task_class, template_ref+version, context_parts[], output_schema_ref, budget, timeout_class, company_id, correlation_id, policy_context}` |
| Response (stable) | `{outcome, validated_output?, error_category?, provider, model, model_version, token_usage, estimated_cost, fallback_used, latency_ms}` |
| Structured outputs | schema-first; provider dialect adapters at the gateway edge only |
| Schema validation | in-gateway; invalid → bounded re-ask → `invalid_output` error category |
| Timeout | per timeout_class; overrun → retry policy |
| Retry | bounded exponential backoff (NFR-007); idempotent by construction (pure calls) |
| Fallback eligibility | per task_class config: quality-bearing generation (strategy options, understanding) prefers **queueing** over fallback; extraction/classification classes may fall back (ADR-004) |
| Usage/cost recording | every call emits `model.call_completed` → usage event (company + account attribution, ADR-013) |
| Redaction | prompts/outputs logged only through the redaction pipeline; raw content stored by reference with restricted access (ADR-017) |
| Error normalization | one internal taxonomy: `timeout · rate_limited · provider_unavailable · invalid_output · content_refused · budget_exceeded · internal` — raw provider errors never surface to users |
| Model-version recording | stamped on every call and every derived artifact |
| Company policy | pre-call check: company budget/caps (NFR-015), model-tier entitlement (future, D-02) |
| Credentials | resolved server-side from the vault at call time (ADR-003/014); never in job payloads, never to clients (invariant 13) |

**Implementation status (ACBP-P2-003, CDR-026):** the gateway ABSTRACTION is BUILT — `callModel` (`@acbp/core/model`) with the ADR-011 request/response contract, per-class timeout (IOQ-13-ratified interactive 30s / generation 120s), bounded retry (≤2) + bounded re-ask (≤1), fallback eligibility per task class (generation ineligible — no silent fallback), the normalized seven-value taxonomy, redacted logging, company-policy pre-check hook, and APPEND-ONLY usage metering (`usage_events`, migration 0017) with FAIL-CLOSED behaviour. Providers are injected: v1 wires ONLY a deterministic FAKE provider (`@acbp/adapters/model`). **The live provider path — a real OpenAI/Anthropic key in the vault, the exact `gpt-5.1` dated-snapshot pin (CDR-001 §8), and the ADR-019 §13 pre-production evaluation gate — is a DEFERRED owner gate (CDR-026 §0), NOT built in P2-003.**

**Initial configuration (ADR-019, accepted 2026-07-18):** primary model family **OpenAI GPT-5.1**; fallback model family **Anthropic Claude Sonnet 4**. Exact API model identifiers/snapshots remain configuration-bound (AOQ-18) and must be pinned before implementation. Binding rules from ADR-019: prompts and output schemas tested against **both** models; **no silent fallback** where the switch could materially change output quality, cost, policy posture, or data processing — material-decision task classes queue or surface degradation honestly; every call additionally records the **fallback reason**; a pre-production **evaluation gate** (10 areas, ADR-019 §13) chooses configuration values without altering this provider-neutral architecture. Provider names appear only in gateway adapters and configuration — never in product-domain modules.

## 4. Prompt-injection boundaries (NFR-021)

Content classes and their treatment:

| Content class | Trust | Rules |
|---|---|---|
| Authenticated user input | Trusted-as-input | May steer work; still schema-validated; cannot bypass policy chain |
| External web content (research) | **Untrusted** | Wrapped as data with provenance; instructions within it are inert; heightened policy scrutiny on any tool call proposed while processing it |
| Uploaded files (future) | Untrusted | Same as web content + malware scanning |
| Integration content (future) | Untrusted | Same; per-connection provenance |
| Generated documents | Semi-trusted (own provenance) | Re-ingestion keeps `model_generation` source type; never auto-promoted to fact (DATA-ARCHITECTURE §3) |
| Tool output | Per-tool class | Structured; validated against tool output schema |

**Hard rule (invariant 17):** tool calls originate exclusively from worker control flow evaluated against the policy chain — never from instructions parsed out of processed content. Suspected injection ⇒ content quarantined, task flagged, `policy.blocked`-class event emitted.
