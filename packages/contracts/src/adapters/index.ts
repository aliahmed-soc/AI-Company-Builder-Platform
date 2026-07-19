// @acbp/contracts — provider-adapter contracts barrel (ACBP-P0-019).
// Provider-neutral interfaces for the four canonical categories: secrets, identity, storage, model.
// No provider SDK types, no implementations — those arrive in packages/adapters in later tickets.
export * from './common.js';
export * from './secret-provider.js';
export * from './identity-provider.js';
export * from './identity-webhook.js';
export * from './storage-provider.js';
export * from './model-provider.js';
