// core/understanding — public index (ACBP-P2-008; CDR-029). Cross-module imports go through this index (spec rule 10).
export {
  generateUnderstanding,
  formatMemoryForPrompt,
  buildUnderstandingRequest,
  type GenerateUnderstandingParams,
  type UnderstandingGenerationDeps,
  type UnderstandingGenerationOptions,
  type GenerateUnderstandingResult,
  type UnderstandingDocumentDTO,
  type UnderstandingSectionDTO,
  type UnderstandingItemDTO,
} from './understanding-generation.js';
