# Approval and Policy Architecture

Status: Proposed. Governs APPR-001…010, POL-001/002/003/004/005/006/007, TOOL-003. ADRs: ADR-009 (approval enforcement), ADR-010 (policy evaluation). Diagram: `diagrams/08`.

## 1. The authority chain

```
AI recommendation → policy evaluation → approval requirement → human or delegated decision → execution authorization → tool execution
```

Each arrow is a **separate component with a separate record**. The chain's non-negotiable property: **the AI model can never mark its own action approved** (invariant 5). Structurally: approval decisions are writable only through the approval API, which rejects non-human/non-delegated actor types at the schema level; worker/model actors have no code path to it. Model output may *recommend*, *classify*, and *draft* — it is input to the chain, never authority in it (PRD principle 21).

## 2. Approval binding (ADR-009)

An approval record binds, at creation:

| Bound element | Detail |
|---|---|
| Company | tenant scope — approval from one company can never authorize another's action |
| Actor | requesting worker/run + deciding approver identities |
| Action type | tool_id + version + risk class |
| Exact normalized payload | canonical serialization → content hash (APPR-004); normalization rules versioned |
| Tool | the specific registered tool (invariant 4 interplay) |
| Destination | recipient/target where applicable (future external classes) |
| Estimated cost or limit | from preflight; execution exceeding bound limit fails closed |
| Approval scope | see §3 |
| Expiration | per risk class default (APPR-005); clock ambiguity resolves to expired |
| Policy version | the policy snapshot the decision was made under |

**Material-change rule:** any change to payload, tool, destination, or cost bound ⇒ hash mismatch ⇒ approval invalid ⇒ re-approval required (invariant 7). Edit-then-approve (APPR-007) creates a *new* bound payload; the old approval is superseded, never mutated.

**Consumption:** single-use. The dispatcher verifies-and-consumes atomically at the execution instant (invariant 6); verify checks hash, expiry, revocation, stop-state, integration status. Revoke-vs-execute races resolve in favor of revocation or produce a compensating alert (APPR-006).

## 3. Approval scopes

| Scope | Meaning | MVP? |
|---|---|---|
| One action | single payload-bound execution | **MVP** |
| Limited batch | enumerated member payloads, each hash-bound; per-member outcomes (APPR-007) | MVP (mechanics), used rarely |
| Capability category | pre-authorization of a category within autonomy level 3 | Post-MVP (levels 3+) |
| Bounded operating policy | standing authorization within POL limits (level 4) | Post-MVP |

Not all scopes ship in MVP (per PRD §11.5: MVP = autonomy levels 1–2). The *data model* supports all four so later levels are additive.

## 4. Policy engine (ADR-010)

**Deterministic, versioned, fail-closed.** Inputs: action context (tool, risk class, payload digest, cost estimate, destination), company policy version, autonomy level, usage state, emergency-stop state, integration status, calendar context. Output: `allow | require_approval | deny(escalate?)` + evaluation record (POL-006, append-only).

Evaluated dimensions (MVP subset bold): **spending limits (POL-001)**, message limits (POL-002), working hours (POL-004), **allowed tools (worker allowlist interplay)**, allowed destinations (POL-003), **risk class (APPR-001)**, data sensitivity, required roles (POL-007 future), **emergency-stop state (ADMIN-001)**, integration status (INTEG-003), **usage limits (NFR-015)**, **forbidden actions + escalation (POL-005 — deny wins over any approval)**.

**Model-produced classifications as inputs:** a model may suggest an action's category or sensitivity, but trust-critical determinations (risk class, spend, destination, forbidden match) come from the **tool registry and structured payload fields**, not model text. Where a model classification is the only available signal, the engine treats it as untrusted and takes the most restrictive applicable path (PRD principle 17).

**Conflict rule:** most restrictive wins (POL-005). **Unavailability rule:** policy engine unreachable ⇒ deny (fail closed, TOOL-003).

## 5. Evaluation timing — three mandatory points

| # | When | Purpose | Skippable? |
|---|---|---|---|
| 1 | Action proposed (task queue / plan accept) | Early honest feedback; avoids wasted work | No |
| 2 | Approval requested | Decision context correctness (policy version recorded into the approval) | Only when point 1 concluded `not_required` and no approval exists |
| 3 | **Immediately before execution** (dispatcher) | The world may have changed: limits, stops, revocations, expiry | **Never — mandatory (invariant 6)** |

Point 3 re-checks everything cheaply (stop-state, limits, integration status, approval validity); it is the enforcement point the launch gates test (gates 3, 4, 8, 15).
