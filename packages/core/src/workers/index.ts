// core/workers - the worker registry (ACBP-P5-004; CDR-056). The allowlist's home; nothing imports registry.js directly.
export { resolveWorkerAllowlist, setCompanyWorkerState } from './registry.js';
export type { RegistryOptions, ResolveWorkerParams, ResolveWorkerResult, SetWorkerStateParams, SetWorkerStateResult, WorkerDefinitionDTO } from './registry.js';
