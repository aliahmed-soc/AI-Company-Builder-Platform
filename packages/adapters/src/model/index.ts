// @acbp/adapters — model-provider adapters barrel (ACBP-P2-003).
// v1 wires ONLY the deterministic fake provider; the concrete OpenAI/Anthropic adapters + any live call are a
// deferred owner gate (CDR-026 §0).
export * from './fake-provider.js';
