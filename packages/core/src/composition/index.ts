// @acbp/core/composition — module public index. The composition layer wires concrete provider adapters
// + database + use cases (ACBP-P1-002 Slice 3). Imported by application composition roots (apps/web).
export * from './clerk-identity.js';
export {
  createModelGateway,
  type ModelGatewayCompositionConfig,
  type CallModelOptions,
  type BoundModelGateway,
} from './model-gateway.js';
export { interviewOutputValidator } from './interview-gateway.js';
export { understandingOutputValidator } from './understanding-gateway.js';
export { strategyOutputValidator, strategyRecommendationValidator } from './strategy-gateway.js';
export { roadmapOutputValidator, taskPlanOutputValidator } from './planning-gateway.js';
// Research (ACBP-P5-006). SHAPE only — the retrieved-source check cannot run in this hook, and the draft/document
// type split is what makes that safe rather than merely documented.
export { researchOutputValidator } from './research-gateway.js';
// Business-model comparison (ACBP-P5-007). Complete in one pass, unlike research's shape/certify split.
export { comparisonOutputValidator } from './comparison-gateway.js';
