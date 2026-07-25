// core/strategy — module public index (ACBP-P3-001; CDR-034). Cross-module imports go through this index (spec rule 10).
export { generateStrategyOptions, getLatestStrategyGeneration, formatUnderstandingForPrompt, buildStrategyRequest } from './strategy-generation.js';
export type {
  GenerateStrategyParams,
  StrategyGenerationDeps,
  StrategyGenerationOptions,
  GenerateStrategyResult,
  StrategyReadParams,
  LatestStrategyResult,
} from './strategy-generation.js';
