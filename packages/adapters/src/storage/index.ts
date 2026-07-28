// adapters/storage — object storage (ACBP-P0-011; ACBP-P5-011). Implements the provider-neutral `ObjectStorage`
// interface from @acbp/contracts. The CONCRETE provider adapter (R2/S3) remains an owner gate — CDR-060 §4 — so what
// lives here today is the in-memory implementation every test runs against.
export { InMemoryObjectStorage } from './in-memory-storage.js';

