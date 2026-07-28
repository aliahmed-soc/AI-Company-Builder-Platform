// @acbp/adapters — concrete provider implementations of the @acbp/contracts adapter contracts.
// ACBP-P1-001: Clerk identity provider (authentication boundary). Others arrive with their tickets.
export * from './clerk/index.js';
export * from './model/index.js';
// Object storage (ACBP-P5-011). The in-memory implementation only — the concrete R2/S3 adapter is an owner gate
// (CDR-060 §4), and it is a class implementing an interface that already exists.
export * from './storage/index.js';
