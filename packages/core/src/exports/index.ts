// core/exports — export of a company's owned data (ACBP-P7-001; CDR-078; EXPORT-001, NFR-014; ADR-002, ADR-016).
// Cross-module imports go through this index (spec rule 10).
export { exportCompanyData, MAX_EXPORT_ROWS_PER_COLLECTION } from './export-service.js';
export type { ExportCompanyDataParams, ExportCompanyDataOptions, ExportCompanyDataResult } from './export-service.js';
