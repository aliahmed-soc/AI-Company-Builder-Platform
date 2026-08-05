// @acbp/core — company module barrel (ACBP-P1-010; CDR-015).
export * from './company-context-resolver.js';
export * from './company-service.js';
export * from './company-lifecycle.js';
export * from './activity-service.js';
export * from './portfolio-service.js';
export * from './provisioning-service.js';
// The lifecycle guard's READ (ACBP-P7-002; CDR-079 §3; launch Gate 14). Cross-module consumers — runs, jobs,
// tools — import it through this index (spec rule 10). It is a plain function, never a port: a caller-injectable
// answer to a safety question has been re-introduced and deleted twice in this codebase already.
export * from './lifecycle-guard.js';
