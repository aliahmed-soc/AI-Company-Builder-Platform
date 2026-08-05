// @acbp/contracts — company contract barrel (ACBP-P1-010; CDR-015).
export * from './company.js';
// The autonomous-work lifecycle gate (ACBP-P7-002; CDR-079 §3; launch Gate 14). One allowlist over BOTH levels,
// taking rows whose `status` is `unknown` so an unrecognised value fails closed by construction.
export * from './lifecycle-gate.js';
