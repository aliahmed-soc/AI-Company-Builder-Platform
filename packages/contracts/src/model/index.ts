// @acbp/contracts — model gateway contracts barrel (ACBP-P2-003; ADR-011, ADR-019; CDR-026).
// The internal gateway request/response seam + config vocabulary + the append-only usage-event
// contract. The provider-facing `ModelProvider` lives under adapters/ (a distinct, lower seam).
export * from './gateway.js';
export * from './usage.js';
export * from './template.js';
