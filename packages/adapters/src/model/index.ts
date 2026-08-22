// @acbp/adapters — model-provider adapters barrel (ACBP-P2-003; ACBP-API-006).
// P2-003 wired ONLY the deterministic fake provider, because a live call was a deferred owner gate (CDR-026 §0).
// ACBP-API-006 lifted that gate — a real credential was supplied — so the live Anthropic adapter joins it here.
export * from './fake-provider.js';
// The FIRST provider in this repository whose calls cost money (CDR-091). The fake stays and is not superseded:
// every gateway test that needs determinism still uses it, and only the composition layer picks between them.
export * from './anthropic-provider.js';
// The owner-presence gate on paid calls (AGENTS.md §1). Exported because the COMPOSITION layer is where a grant
// is supplied or withheld, and it must be able to name the type without reaching into an adapter's file path.
export * from './owner-presence.js';
